'use strict';
/**
 * Phase 2 service layer. All business rules live here; Firebase specifics are injected:
 *   store     - persistence (see src/firestoreStore.js, test-support/memoryStore.js)
 *   scheduler - delayed jobs (Cloud Tasks in production)
 *   notifier  - push delivery (FCM in production)
 * `auth` is `{ uid, provider }` or null. Visitors are anonymous-auth users, owners are not.
 */
const { STATUS: S, canTransition, canSendMessage, isTerminal } = require('./core/states');
const P = require('./core/policy');
const T = require('./core/token');
const E = require('./core/escalation');
const { ServiceError } = require('./errors');

// ASSUMPTIONS A8/A9 (not in spec): per-owner car cap and per-request message cap.
const LIMITS = Object.freeze({ maxCarsPerOwner: 5, maxMessagesPerRequest: 100 });
const CLOSE_OUTCOMES = Object.freeze({ on_the_way: S.CLOSED_ON_THE_WAY, resolved: S.CLOSED_RESOLVED });

function createService({ store, scheduler, notifier, baseUrl, now = Date.now, config = P.DEFAULT_CONFIG, limits = LIMITS, logger = console }) {
  const fail = (code, details) => new ServiceError(code, details);
  const requireAuth = (auth) => { if (!auth || !auth.uid) throw fail('unauthenticated'); return auth; };
  const requireOwner = (auth) => { requireAuth(auth); if (auth.provider === 'anonymous') throw fail('forbidden'); return auth; };
  const roleOf = (req, uid) => (uid === req.ownerUid ? 'owner' : uid === req.visitorUid ? 'visitor' : null);
  const expiryPatch = (t) => ({ status: S.EXPIRED, closedAt: t });
  const mustExpire = (cur, t) => !isTerminal(cur.status) && P.isExpired(cur.expiresAtMs, t);

  /**
   * Role-checked, expiry-aware mutation of one request, inside the store's transaction.
   * Wrong role and unknown id both give `not_found` so existence is not leaked.
   * `apply` must be pure (transactions may re-run it).
   */
  function mutateAs(auth, requestId, wantedRole, apply) {
    requireAuth(auth);
    if (typeof requestId !== 'string' || requestId === '') throw fail('not_found');
    return store.mutateRequest(requestId, (cur) => {
      const role = roleOf(cur, auth.uid);
      if (!role || (wantedRole && role !== wantedRole)) throw fail('not_found');
      const t = now();
      if (mustExpire(cur, t)) return { patch: expiryPatch(t), result: { closed: true } };
      if (isTerminal(cur.status)) return { result: { closed: true } };
      return apply(cur, role, t) || {};
    });
  }

  const labelOf = (v, max, code) => {
    const r = P.sanitizeText(v, max);
    if (!r.ok) throw fail(code);
    return r.value;
  };

  // ---------- owner: cars & QR ----------
  async function createCar(auth, input = {}) {
    requireOwner(auth);
    const label = labelOf(input.label, 60, 'invalid_label');
    const color = labelOf(input.color, 30, 'invalid_color');
    if ((await store.countCarsByOwner(auth.uid)) >= limits.maxCarsPerOwner) throw fail('limit_reached');
    const token = T.generateToken();
    const hash = T.hashToken(token);
    const carId = store.newId();
    await store.createCarWithToken(
      { id: carId, ownerUid: auth.uid, label, color, acceptingRequests: true, activeTokenHash: hash, createdAt: now() },
      hash,
    );
    // The raw token is returned ONCE; only its hash is stored (so the app must keep the QR locally).
    return { carId, qrUrl: T.buildQrUrl(baseUrl, token) };
  }

  async function rotateQr(auth, { carId } = {}) {
    requireOwner(auth);
    const car = typeof carId === 'string' ? await store.getCar(carId) : null;
    if (!car || car.ownerUid !== auth.uid) throw fail('not_found');
    const token = T.generateToken();
    await store.rotateToken({ carId, ownerUid: auth.uid, oldHash: car.activeTokenHash, newHash: T.hashToken(token), now: now() });
    return { carId, qrUrl: T.buildQrUrl(baseUrl, token) };
  }

  // ---------- visitor: create request ----------
  async function createRequest(auth, input = {}) {
    requireAuth(auth);
    const v = P.validateCreateRequest(input, config);
    if (!v.ok) throw fail(v.error);
    if (!T.isWellFormedToken(input.token)) throw fail('not_found');
    const hash = T.hashToken(input.token);
    const rec = await store.getTokenRecord(hash);
    if (!rec || !rec.active) throw fail('not_found');
    const car = await store.getCar(rec.carId);
    if (!car || car.activeTokenHash !== hash) throw fail('not_found');
    if (car.ownerUid === auth.uid) throw fail('own_car');
    if (car.acceptingRequests === false) throw fail('not_accepting');

    const t = now();
    for (const [field, value, lim] of [['visitorUid', auth.uid, config.perVisitorLimit], ['carId', car.id, config.perCarLimit]]) {
      const times = await store.listRecentRequestTimes(field, value, t - lim.windowMs);
      const rl = P.checkRateLimit(times, t, lim);
      if (!rl.allowed) throw fail('rate_limited', { retryAfterMs: rl.retryAfterMs });
    }

    const id = store.newId();
    await store.insertRequest({
      id, carId: car.id, ownerUid: car.ownerUid, visitorUid: auth.uid, participants: [car.ownerUid, auth.uid],
      reason: v.value.reason, message: v.value.message, status: S.CREATED,
      createdAt: t, expiresAtMs: P.computeExpiry(t, config), messageCount: 0,
    });

    // Scheduling failures must not lose the request: the 1-minute sweep still expires it.
    const schedule = E.buildAlertSchedule(await store.getUserSettings(car.ownerUid));
    const jobs = [scheduler.scheduleExpire(id, config.requestTtlMs)];
    schedule.slice(1).forEach((offset, i) => jobs.push(scheduler.scheduleAlert(id, i + 1, offset)));
    (await Promise.allSettled(jobs)).forEach((r) => { if (r.status === 'rejected') logger.error('schedule_failed', { requestId: id }); });

    await fireAlert(id, 0);
    const fresh = await store.getRequest(id);
    return { requestId: id, status: fresh.status, expiresAtMs: fresh.expiresAtMs };
  }

  // ---------- alerts & expiry (called by Cloud Tasks / sweep) ----------
  async function fireAlert(requestId, index) {
    const req = await store.getRequest(requestId);
    if (!E.shouldFireAlert(req, now())) return { fired: false };
    const { sent } = await notifier.notifyOwner(req.ownerUid, { requestId, reason: req.reason, index });
    if (sent > 0 && req.status === S.CREATED) {
      await store.mutateRequest(requestId, (cur) => (canTransition(cur.status, S.SENT, 'system') ? { patch: { status: S.SENT } } : {}));
    }
    return { fired: true, sent };
  }

  async function expireRequest(requestId) {
    try {
      const out = await store.mutateRequest(requestId, (cur) => {
        const t = now();
        if (!mustExpire(cur, t) || !canTransition(cur.status, S.EXPIRED, 'system')) return { result: { expired: false } };
        return { patch: expiryPatch(t), result: { expired: true } };
      });
      return out.result;
    } catch (e) {
      if (e instanceof ServiceError && e.code === 'not_found') return { expired: false };
      throw e;
    }
  }

  async function sweepExpired(limit = 200) {
    const ids = await store.listExpirable(now(), limit);
    let expired = 0;
    for (const id of ids) if ((await expireRequest(id)).expired) expired += 1;
    return { expired };
  }

  // ---------- owner / visitor actions on a request ----------
  async function markViewed(auth, { requestId } = {}) {
    const out = await mutateAs(auth, requestId, 'owner', (cur, _r, t) =>
      (canTransition(cur.status, S.VIEWED, 'owner') ? { patch: { status: S.VIEWED, viewedAt: t } } : {}));
    return { status: out.request.status };
  }

  /** The owner's device reports that the push arrived (spec status "delivered"). */
  async function ackDelivered(auth, { requestId } = {}) {
    const out = await mutateAs(auth, requestId, 'owner', (cur) =>
      (canTransition(cur.status, S.DELIVERED, 'system') ? { patch: { status: S.DELIVERED } } : {}));
    return { status: out.request.status };
  }

  async function sendMessage(auth, { requestId, text } = {}) {
    const v = P.validateChatMessage(text, config);
    if (!v.ok) throw fail(v.error);
    const out = await mutateAs(auth, requestId, null, (cur, role, t) => {
      if (!canSendMessage(cur.status)) return { result: { closed: true } };
      const count = cur.messageCount || 0;
      if (count >= limits.maxMessagesPerRequest) throw fail('message_limit');
      const patch = { messageCount: count + 1 };
      if (role === 'owner' && canTransition(cur.status, S.IN_PROGRESS, 'owner')) {
        patch.status = S.IN_PROGRESS;
        if (!cur.viewedAt) patch.viewedAt = t;
      }
      return { patch, message: { from: role, text: v.value, createdAt: t } };
    });
    if (out.result && out.result.closed) throw fail('session_closed');
    return { messageId: out.messageId, status: out.request.status };
  }

  async function closeRequest(auth, { requestId, outcome } = {}) {
    const to = typeof outcome === 'string' && Object.hasOwn(CLOSE_OUTCOMES, outcome) ? CLOSE_OUTCOMES[outcome] : null;
    if (!to) throw fail('invalid_outcome');
    const out = await mutateAs(auth, requestId, 'owner', (cur, _r, t) =>
      (canTransition(cur.status, to, 'owner') ? { patch: { status: to, closedAt: t } } : {}));
    if (out.result && out.result.closed) throw fail('session_closed');
    return { status: out.request.status };
  }

  async function cancelRequest(auth, { requestId } = {}) {
    const out = await mutateAs(auth, requestId, 'visitor', (cur, _r, t) =>
      (canTransition(cur.status, S.CANCELLED, 'visitor') ? { patch: { status: S.CANCELLED, closedAt: t } } : {}));
    if (out.result && out.result.closed) throw fail('session_closed');
    return { status: out.request.status };
  }

  return { createCar, rotateQr, createRequest, fireAlert, expireRequest, sweepExpired, markViewed, ackDelivered, sendMessage, closeRequest, cancelRequest };
}

module.exports = { createService, LIMITS };
