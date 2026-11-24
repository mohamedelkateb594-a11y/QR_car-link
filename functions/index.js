'use strict';
/**
 * Cloud Functions wiring (Phase 2). !! NOT DEPLOYED OR RUN: firebase-admin / firebase-functions could not be
 * installed in the authoring environment (no network). Business logic lives in src/services (unit-tested);
 * this file only adapts HTTP/auth/task plumbing. Verify on the Firebase Emulator before deploying.
 */
const crypto = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { getFunctions } = require('firebase-admin/functions');

const { ServiceError } = require('./src/errors');
const { DEFAULT_CONFIG } = require('./src/core/policy');
const { createFirestoreStore } = require('./src/adapters/firestoreStore');
const { createFcmPush } = require('./src/adapters/fcmPush');
const { createCarService } = require('./src/services/carService');
const { createRequestService } = require('./src/services/requestService');

initializeApp();
const db = getFirestore();

const TASK_FUNCTION = 'processTask';
const scheduler = {
  enqueue: (payload, delayMs) =>
    getFunctions().taskQueue(TASK_FUNCTION).enqueue(payload, { scheduleDelaySeconds: Math.max(0, Math.round(delayMs / 1000)) }),
};

const store = createFirestoreStore(db);
const common = { store, clock: { now: () => Date.now() }, newId: () => db.collection('_ids').doc().id };
const requests = createRequestService({ ...common, push: createFcmPush({ db, messaging: getMessaging() }), scheduler, config: DEFAULT_CONFIG });
// QR_BASE_URL must be the FINAL public origin (decision D5): printed QR codes depend on it.
const cars = createCarService({ ...common, baseUrl: process.env.QR_BASE_URL });

const HTTPS_CODE = {
  invalid_payload: 'invalid-argument', invalid_reason: 'invalid-argument', invalid_text: 'invalid-argument',
  message_too_long: 'invalid-argument', empty_message: 'invalid-argument', invalid_action: 'invalid-argument',
  invalid_link: 'not-found', not_found: 'not-found', forbidden: 'permission-denied',
  rate_limited: 'resource-exhausted', not_accepting: 'failed-precondition', session_closed: 'failed-precondition',
};

function guarded(handler, { owner = false } = {}) {
  return onCall(async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'sign_in_required');
    const isAnonymous = req.auth.token.firebase.sign_in_provider === 'anonymous';
    if (owner && isAnonymous) throw new HttpsError('permission-denied', 'owner_account_required');
    const ip = (req.rawRequest && req.rawRequest.ip) || '';
    // IP_HASH_SALT must be set (secret/param) or hashes are guessable. Only the salted hash is stored.
    const ipHash = ip ? crypto.createHash('sha256').update(ip + (process.env.IP_HASH_SALT || '')).digest('hex') : null;
    try {
      return await handler(req.data || {}, { uid: req.auth.uid, isAnonymous, ipHash });
    } catch (e) {
      if (e instanceof ServiceError) {
        throw new HttpsError(HTTPS_CODE[e.code] || 'failed-precondition', e.code, e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : undefined);
      }
      console.error(e);
      throw new HttpsError('internal', 'internal');
    }
  });
}

// Owner (signed-in, non-anonymous)
exports.createCar = guarded((d, ctx) => cars.createCar(d, ctx), { owner: true });
exports.rotateQr = guarded((d, ctx) => cars.rotateQr(d, ctx), { owner: true });
exports.markViewed = guarded((d, ctx) => requests.markViewed(d, ctx), { owner: true });
exports.closeRequest = guarded((d, ctx) => requests.closeRequest(d, ctx), { owner: true });

// Visitor (anonymous auth) - role is derived from the uid stored on the request, not from the caller's claim
exports.createRequest = guarded((d, ctx) => requests.createRequest(d, ctx));
exports.cancelRequest = guarded((d, ctx) => requests.cancelRequest(d, ctx));
exports.sendMessage = guarded((d, ctx) => requests.sendMessage(d, ctx));

// Delayed alerts + expiry (Cloud Tasks). Each task re-checks current state before acting.
exports[TASK_FUNCTION] = onTaskDispatched(
  { retryConfig: { maxAttempts: 3, minBackoffSeconds: 5 }, rateLimits: { maxConcurrentDispatches: 20 } },
  async (req) => {
    const { kind, requestId, index } = req.data || {};
    if (kind === 'alert') await requests.fireAlert(requestId, index);
    else if (kind === 'expire') await requests.expireRequest(requestId);
  },
);

// Safety net: expires anything whose expiry task was lost.
exports.sweepExpired = onSchedule('every 1 minutes', async () => { await requests.sweepExpired(); });
