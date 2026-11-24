'use strict';
const { ServiceError } = require('../errors');
const { STATUS: S, ACTIVE_ORDER, canTransition, canSendMessage } = require('../core/states');
const { DEFAULT_CONFIG, validateCreateRequest, validateChatMessage, sanitizeText, computeExpiry, checkRateLimit } = require('../core/policy');
const { isWellFormedToken, hashToken } = require('../core/token');
const { buildAlertSchedule, shouldFireAlert } = require('../core/escalation');

const allowedFrom = (to, actor) => ACTIVE_ORDER.filter((s) => canTransition(s, to, actor));
const OPEN_FOR_MESSAGES = ACTIVE_ORDER.filter(canSendMessage);
const CLOSE_ACTIONS = { on_the_way: S.CLOSED_ON_THE_WAY, resolved: S.CLOSED_RESOLVED };

/**
 * Business logic for contact requests. Pure orchestration over injected ports so it is testable without Firebase.
 * deps: { store, push, scheduler, clock, newId, config?, logger? }
 *  - store.transition() MUST be atomic compare-and-set on status (Firestore transaction in production).
 *  - push.notifyOwner(ownerUid, payload) must throw on failure.
 *  - scheduler.enqueue(payload, delayMs) schedules a delayed task.
 */
function createRequestService({ store, push, scheduler, clock, newId, config = DEFAULT_CONFIG, logger = console }) {
  async function loadForActor(requestId, uid) {
    const r = typeof requestId === 'string' && requestId ? await store.getRequest(requestId) : null;
    // Same answer for "missing" and "not yours": do not reveal which request ids exist.
    if (!r || !Array.isArray(r.participants) || !r.participants.includes(uid)) throw new ServiceError('not_found');
    return { request: r, role: uid === r.ownerUid ? 'owner' : 'visitor' };
  }

  async function checkLimits(car, ctx, now) {
    const checks = [['carId', car.id, config.perCarLimit], ['visitorUid', ctx.uid, config.perVisitorLimit]];
    if (ctx.ipHash) checks.push(['ipHash', ctx.ipHash, config.perVisitorLimit]);
    for (const [field, value, limit] of checks) {
      const times = await store.listRateEvents(field, value, now - limit.windowMs);
      const res = checkRateLimit(times, now, limit);
      if (!res.allowed) throw new ServiceError('rate_limited', { retryAfterMs: res.retryAfterMs });
    }
  }

  /** Visitor (anonymous) creates a request from the QR page. */
  async function createRequest(input, ctx) {
    const v = validateCreateRequest(input, config);
    if (!v.ok) throw new ServiceError(v.error);
    if (!isWellFormedToken(input.token)) throw new ServiceError('invalid_link');

    const tok = await store.getQrToken(hashToken(input.token));
    if (!tok || !tok.active) throw new ServiceError('invalid_link');
    const car = await store.getCar(tok.carId);
    if (!car || car.ownerUid !== tok.ownerUid) throw new ServiceError('invalid_link');
    if (car.acceptingRequests === false) throw new ServiceError('not_accepting');

    const now = clock.now();
    // Idempotency: one open request per (car, visitor). A stale one is expired first, then a new one is allowed.
    const existing = await store.findOpenRequest(car.id, ctx.uid);
    if (existing) {
      if (now < existing.expiresAtMs) return { requestId: existing.id, expiresAtMs: existing.expiresAtMs, existing: true };
      await expireRequest(existing.id);
    }

    await checkLimits(car, ctx, now);

    const doc = {
      id: newId(), carId: car.id, ownerUid: car.ownerUid, visitorUid: ctx.uid,
      participants: [...new Set([car.ownerUid, ctx.uid])],
      reason: v.value.reason, message: v.value.message,
      status: S.CREATED, open: true,
      createdAt: now, expiresAtMs: computeExpiry(now, config), viewedAt: null, closedAt: null,
    };
    await store.createRequestDoc(doc);
    await store.recordRateEvent({ carId: car.id, visitorUid: ctx.uid, ipHash: ctx.ipHash || null, at: now });

    const settings = (await store.getOwnerSettings(car.ownerUid)) || {};
    const schedule = buildAlertSchedule(settings);
    try {
      for (let i = 1; i < schedule.length; i++) {
        await scheduler.enqueue({ kind: 'alert', requestId: doc.id, index: i }, schedule[i]);
      }
      await scheduler.enqueue({ kind: 'expire', requestId: doc.id }, config.requestTtlMs);
    } catch (e) {
      // Expiry is still guaranteed by the sweep; only repeat alerts are degraded.
      logger.warn('scheduler.enqueue failed', e && e.message);
    }
    await fireAlert(doc.id, 0); // immediate push; never fails the visitor's request
    return { requestId: doc.id, expiresAtMs: doc.expiresAtMs, existing: false };
  }

  /** Called by the task queue. Re-reads CURRENT state; a request that moved on gets no alert. */
  async function fireAlert(requestId, index) {
    const request = await store.getRequest(requestId);
    if (!shouldFireAlert(request, clock.now())) return { fired: false };
    try {
      await push.notifyOwner(request.ownerUid, { type: 'new_request', requestId, attempt: index, reason: request.reason });
    } catch (e) {
      logger.warn('push failed', requestId, e && e.message);
      return { fired: false, error: 'push_failed' };
    }
    // "sent" = accepted by the push channel. It is NOT proof the owner saw it (that is `viewed`).
    await store.transition(requestId, { allowedFrom: allowedFrom(S.SENT, 'system'), patch: { status: S.SENT } });
    return { fired: true };
  }

  async function sendMessage({ requestId, text }, ctx) {
    const t = validateChatMessage(text, config);
    if (!t.ok) throw new ServiceError(t.error);
    const { request, role } = await loadForActor(requestId, ctx.uid);
    const res = await store.transition(request.id, {
      allowedFrom: OPEN_FOR_MESSAGES, patch: {},
      message: { from: role, text: t.value, kind: 'message', createdAt: clock.now() },
    });
    if (!res.ok) throw new ServiceError(res.reason === 'not_found' ? 'not_found' : 'session_closed');
    if (role === 'visitor') {
      try { await push.notifyOwner(request.ownerUid, { type: 'message', requestId: request.id, attempt: 0, reason: request.reason }); }
      catch (e) { logger.warn('message push failed', e && e.message); }
    }
    return { messageId: res.messageId };
  }

  /** Owner opened the request. Idempotent; never reopens a closed one. */
  async function markViewed({ requestId }, ctx) {
    const { request, role } = await loadForActor(requestId, ctx.uid);
    if (role !== 'owner') throw new ServiceError('forbidden');
    const res = await store.transition(request.id, {
      allowedFrom: allowedFrom(S.VIEWED, 'owner'), patch: { status: S.VIEWED, viewedAt: clock.now() },
    });
    if (res.ok) return { changed: true, status: S.VIEWED };
    return { changed: false, status: res.current ? res.current.status : request.status };
  }

  /** Owner's final action: on_the_way | resolved. Closes the session atomically with its optional message. */
  async function closeRequest({ requestId, action, message }, ctx) {
    const target = CLOSE_ACTIONS[action];
    if (!target) throw new ServiceError('invalid_action');
    const m = sanitizeText(message, config.maxMessageLen);
    if (!m.ok) throw new ServiceError(m.error);
    const { request, role } = await loadForActor(requestId, ctx.uid);
    if (role !== 'owner') throw new ServiceError('forbidden');
    const now = clock.now();
    const res = await store.transition(request.id, {
      allowedFrom: allowedFrom(target, 'owner'),
      patch: { status: target, open: false, closedAt: now },
      message: m.value ? { from: 'owner', text: m.value, kind: 'closing', createdAt: now } : undefined,
    });
    if (!res.ok) throw new ServiceError(res.reason === 'not_found' ? 'not_found' : 'session_closed');
    return { status: target };
  }

  async function cancelRequest({ requestId }, ctx) {
    const { request, role } = await loadForActor(requestId, ctx.uid);
    if (role !== 'visitor') throw new ServiceError('forbidden');
    const res = await store.transition(request.id, {
      allowedFrom: allowedFrom(S.CANCELLED, 'visitor'),
      patch: { status: S.CANCELLED, open: false, closedAt: clock.now() },
    });
    if (!res.ok) throw new ServiceError(res.reason === 'not_found' ? 'not_found' : 'session_closed');
    return { status: S.CANCELLED };
  }

  /** System action. Server-side only: works even if both parties closed the page/app. */
  async function expireRequest(requestId) {
    const request = await store.getRequest(requestId);
    if (!request) return { changed: false, reason: 'not_found' };
    const now = clock.now();
    if (now < request.expiresAtMs) return { changed: false, reason: 'not_due' };
    const res = await store.transition(requestId, {
      allowedFrom: allowedFrom(S.EXPIRED, 'system'),
      patch: { status: S.EXPIRED, open: false, closedAt: now },
    });
    return res.ok ? { changed: true } : { changed: false, reason: 'already_final' };
  }

  /** Safety net for lost/failed expiry tasks. Run every minute. */
  async function sweepExpired(limit = 200) {
    const due = await store.listOpenExpired(clock.now(), limit);
    let expired = 0;
    for (const r of due) if ((await expireRequest(r.id)).changed) expired++;
    return { checked: due.length, expired };
  }

  return { createRequest, fireAlert, sendMessage, markViewed, closeRequest, cancelRequest, expireRequest, sweepExpired };
}
module.exports = { createRequestService };
