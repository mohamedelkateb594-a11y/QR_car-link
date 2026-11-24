'use strict';
/**
 * Phase 2 business logic. No firebase imports: the store, notifier and scheduler are injected,
 * so every rule here is unit-tested with an in-memory store and the same code runs in Cloud Functions.
 *
 * Data model (decision K1, see DEVELOPER_HANDOFF.md):
 *   requests/{id}            owner-private (ownerUid, carId, visitorUid, ...). Owner reads only.
 *   sessions/{id}            visitor mirror: status/reason/expiry only - NO ownerUid/carId.
 *   sessions/{id}/messages   {from, text, createdAt} - no uids. Read by the visitor (session.visitorUid) or the owner.
 *   rate/{key}               server-only timestamps for rate limiting.
 */
const { STATUS, isTerminal, canTransition, canSendMessage } = require('../core/states');
const { DEFAULT_CONFIG, validateCreateRequest, validateChatMessage, sanitizeText, computeExpiry, isExpired, checkRateLimit } = require('../core/policy');
const { generateToken, isWellFormedToken, hashToken, buildQrUrl } = require('../core/token');
const { buildAlertSchedule, shouldFireAlert } = require('../core/escalation');
const { AppError } = require('./errors');

const MAX_CARS_PER_USER = 5; // ASSUMPTION A8 - not in spec; abuse guard.

function createService({ store, notifier, scheduler, clock = () => Date.now(), config = DEFAULT_CONFIG, baseUrl }) {
  const need = (cond, code) => { if (!cond) throw new AppError(code); };

  // ---- helpers -------------------------------------------------------------------------------
  /**
   * Run `fn` in a transaction. `fn` may `return { fail: 'code' }`: the error is thrown only AFTER the commit,
   * so writes made before the failure (e.g. lazy expiry) are persisted instead of rolled back.
   */
  async function txOrFail(fn) {
    const out = await store.transaction(fn);
    if (out && out.fail) throw new AppError(out.fail);
    return out;
  }

  function actorOf(req, uid) {
    if (uid && uid === req.ownerUid) return 'owner';
    if (uid && uid === req.visitorUid) return 'visitor';
    return null;
  }

  /** Move a request (and its visitor mirror) to a new status. Caller must have checked canTransition. */
  async function applyStatus(tx, req, to, extra = {}) {
    const now = clock();
    const patch = { status: to, ...extra };
    if (isTerminal(to)) patch.closedAt = now;
    await tx.setRequest(req.id, { ...req, ...patch });
    const session = await tx.getSession(req.id);
    await tx.setSession(req.id, { ...session, status: to, ...(isTerminal(to) ? { closedAt: now } : {}) });
    return { ...req, ...patch };
  }

  /** Lazily expire inside a transaction so no message/transition can slip in after the deadline. */
  async function expireIfDue(tx, req) {
    if (!isTerminal(req.status) && isExpired(req.expiresAt, clock()) && canTransition(req.status, STATUS.EXPIRED, 'system')) {
      return applyStatus(tx, req, STATUS.EXPIRED);
    }
    return req;
  }

  // ---- owner: cars & QR ----------------------------------------------------------------------
  async function createCar({ uid, label = '', color = '' }) {
    need(uid, 'unauthenticated');
    const l = sanitizeText(label, 60); const c = sanitizeText(color, 30);
    need(l.ok && c.ok, 'invalid_payload');
    const token = generateToken();
    const carId = store.newId();
    await store.transaction(async (tx) => {
      need((await tx.countCars(uid)) < MAX_CARS_PER_USER, 'car_limit_reached');
      await tx.setCar(carId, { ownerUid: uid, label: l.value, color: c.value, acceptingRequests: true, activeTokenHash: hashToken(token), createdAt: clock() });
      await tx.setToken(hashToken(token), { carId, ownerUid: uid, active: true, createdAt: clock() });
    });
    // The raw token is returned ONCE; only its hash is stored. The app must keep the URL (open question Q1).
    return { carId, qrUrl: buildQrUrl(baseUrl, token) };
  }

  async function rotateQr({ uid, carId }) {
    need(uid, 'unauthenticated');
    const token = generateToken();
    await store.transaction(async (tx) => {
      const car = await tx.getCar(carId);
      need(car && car.ownerUid === uid, 'not_found');
      if (car.activeTokenHash) {
        const old = await tx.getToken(car.activeTokenHash);
        if (old) await tx.setToken(car.activeTokenHash, { ...old, active: false, revokedAt: clock() });
      }
      await tx.setCar(carId, { ...car, activeTokenHash: hashToken(token) });
      await tx.setToken(hashToken(token), { carId, ownerUid: uid, active: true, createdAt: clock() });
    });
    return { carId, qrUrl: buildQrUrl(baseUrl, token) };
  }

  // ---- visitor: create request ---------------------------------------------------------------
  async function createRequest({ token, uid, payload }) {
    need(uid, 'unauthenticated');
    // Same generic error for malformed / unknown / revoked / paused: no oracle for token guessing.
    need(isWellFormedToken(token), 'not_found');
    const v = validateCreateRequest(payload, config);
    if (!v.ok) throw new AppError(v.error);

    const now = clock();
    const requestId = store.newId();
    let ownerUid;
    let settings;

    await store.transaction(async (tx) => {
      const rec = await tx.getToken(hashToken(token));
      need(rec && rec.active, 'not_found');
      const car = await tx.getCar(rec.carId);
      need(car && car.activeTokenHash === hashToken(token) && car.acceptingRequests !== false, 'not_found');

      const vKey = `v:${uid}`; const cKey = `c:${rec.carId}`;
      const vRate = checkRateLimit(await tx.getRate(vKey), now, config.perVisitorLimit);
      const cRate = checkRateLimit(await tx.getRate(cKey), now, config.perCarLimit);
      if (!vRate.allowed || !cRate.allowed) throw new AppError('rate_limited', { retryAfterMs: Math.max(vRate.retryAfterMs, cRate.retryAfterMs) });
      await tx.setRate(vKey, [...(await tx.getRate(vKey)), now].filter((t) => now - t < config.perVisitorLimit.windowMs));
      await tx.setRate(cKey, [...(await tx.getRate(cKey)), now].filter((t) => now - t < config.perCarLimit.windowMs));

      ownerUid = rec.ownerUid;
      settings = (await tx.getUser(ownerUid)) || {};
      const expiresAt = computeExpiry(now, config);
      await tx.setRequest(requestId, {
        id: requestId, carId: rec.carId, ownerUid, visitorUid: uid, reason: v.value.reason, message: v.value.message,
        status: STATUS.CREATED, createdAt: now, expiresAt,
      });
      await tx.setSession(requestId, { visitorUid: uid, reason: v.value.reason, status: STATUS.CREATED, createdAt: now, expiresAt });
      if (v.value.message) await tx.addMessage(requestId, { from: 'visitor', text: v.value.message, createdAt: now });
    });

    // Side effects after the commit. A push failure must not lose the request (owner still sees it in-app).
    const offsets = buildAlertSchedule(settings);
    let pushed = false;
    try { pushed = (await notifier.push(ownerUid, { type: 'new_request', requestId, reason: v.value.reason })).accepted === true; } catch { /* logged by caller */ }
    await store.transaction(async (tx) => {
      const req = await tx.getRequest(requestId);
      if (pushed && req && canTransition(req.status, STATUS.SENT, 'system')) await applyStatus(tx, req, STATUS.SENT);
    });
    for (const [i, off] of offsets.entries()) if (off > 0) await scheduler.scheduleAlert(requestId, i, now + off);
    await scheduler.scheduleExpire(requestId, now + config.requestTtlMs);

    return { requestId };
  }

  // ---- both: messages ------------------------------------------------------------------------
  async function sendMessage({ requestId, uid, text }) {
    need(uid, 'unauthenticated');
    const m = validateChatMessage(text, config);
    if (!m.ok) throw new AppError(m.error);
    let ownerUid; let actor;
    await txOrFail(async (tx) => {
      let req = await tx.getRequest(requestId);
      need(req && actorOf(req, uid), 'not_found');          // non-participants get the same error as a missing id
      actor = actorOf(req, uid);
      req = await expireIfDue(tx, req);
      if (!canSendMessage(req.status)) return { fail: 'session_closed' };
      await tx.addMessage(requestId, { from: actor, text: m.value, createdAt: clock() });
      ownerUid = req.ownerUid;
      return {};
    });
    if (actor === 'visitor') { try { await notifier.push(ownerUid, { type: 'new_message', requestId }); } catch { /* best effort */ } }
    return { ok: true };
  }

  // ---- owner ---------------------------------------------------------------------------------
  /** Only a real open of the request by the owner sets `viewed` (a delivered push is not a view). */
  async function markViewed({ requestId, uid }) {
    need(uid, 'unauthenticated');
    return store.transaction(async (tx) => {
      let req = await tx.getRequest(requestId);
      need(req && actorOf(req, uid) === 'owner', 'not_found');
      req = await expireIfDue(tx, req);
      if (isTerminal(req.status)) return { status: req.status };
      if (canTransition(req.status, STATUS.VIEWED, 'owner')) req = await applyStatus(tx, req, STATUS.VIEWED, { viewedAt: clock() });
      return { status: req.status }; // already viewed/in_progress: idempotent
    });
  }

  async function closeRequest({ requestId, uid, kind, note }) {
    need(uid, 'unauthenticated');
    const to = kind === 'on_the_way' ? STATUS.CLOSED_ON_THE_WAY : kind === 'resolved' ? STATUS.CLOSED_RESOLVED : null;
    need(to, 'invalid_kind');
    const n = sanitizeText(note, config.maxMessageLen);
    need(n.ok, n.error || 'invalid_text');
    return txOrFail(async (tx) => {
      let req = await tx.getRequest(requestId);
      need(req && actorOf(req, uid) === 'owner', 'not_found');
      req = await expireIfDue(tx, req);
      if (!canTransition(req.status, to, 'owner')) return { fail: 'session_closed' };
      // Optional note is written in the SAME transaction as the close: it is the last message, nothing can follow it.
      if (n.value) await tx.addMessage(requestId, { from: 'owner', text: n.value, createdAt: clock() });
      const closed = await applyStatus(tx, req, to);
      return { status: closed.status };
    });
  }

  // ---- visitor -------------------------------------------------------------------------------
  async function cancelRequest({ requestId, uid }) {
    need(uid, 'unauthenticated');
    return txOrFail(async (tx) => {
      let req = await tx.getRequest(requestId);
      need(req && actorOf(req, uid) === 'visitor', 'not_found');
      req = await expireIfDue(tx, req);
      if (!canTransition(req.status, STATUS.CANCELLED, 'visitor')) return { fail: 'session_closed' };
      const closed = await applyStatus(tx, req, STATUS.CANCELLED);
      return { status: closed.status };
    });
  }

  // ---- system: Cloud Tasks handlers + sweep --------------------------------------------------
  /** Fired by Cloud Tasks at expiresAt. Re-checks the CURRENT state; safe to run twice or early. */
  async function expireRequest({ requestId }) {
    return store.transaction(async (tx) => {
      const req = await tx.getRequest(requestId);
      if (!req) return { status: 'missing' };
      const after = await expireIfDue(tx, req);
      return { status: after.status };
    });
  }

  /** Fired by Cloud Tasks at each alert offset. Decides against the state at fire time, not scheduling time. */
  async function fireAlert({ requestId, step }) {
    const req = await store.getRequest(requestId);
    if (!shouldFireAlert(req && { status: req.status, expiresAtMs: req.expiresAt }, clock())) return { fired: false };
    await notifier.push(req.ownerUid, { type: 'alert', requestId, step });
    return { fired: true };
  }

  /** Safety net (every minute) in case a Task was lost: expire everything overdue. */
  async function sweepExpired() {
    const ids = await store.listOpenExpired(clock());
    let n = 0;
    for (const id of ids) { const r = await expireRequest({ requestId: id }); if (r.status === STATUS.EXPIRED) n += 1; }
    return { expired: n };
  }

  return { createCar, rotateQr, createRequest, sendMessage, markViewed, closeRequest, cancelRequest, expireRequest, fireAlert, sweepExpired };
}

module.exports = { createService, MAX_CARS_PER_USER };
