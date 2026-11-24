'use strict';
/**
 * Firebase wiring (Phase 2). Business rules live in src/service.js; this file only adapts
 * Firebase callables / Cloud Tasks / scheduler to it. NOT yet run against the emulator.
 */
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineString } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { getFunctions } = require('firebase-admin/functions');

const { createService } = require('./src/service');
const { createFirestoreStore } = require('./src/firestoreStore');
const { createNotifier } = require('./src/notifier');
const { ServiceError } = require('./src/errors');

setGlobalOptions({ region: 'europe-west1', maxInstances: 10 }); // region: adjust once the Firebase project (D4) is chosen
const PUBLIC_BASE_URL = defineString('PUBLIC_BASE_URL'); // decision D5: the permanent QR domain

initializeApp();
const store = createFirestoreStore(getFirestore());

let cached;
const service = () => {
  if (!cached) {
    const queue = (name) => getFunctions().taskQueue(name);
    cached = createService({
      store,
      baseUrl: PUBLIC_BASE_URL.value(),
      notifier: createNotifier({ store, messaging: getMessaging() }),
      scheduler: {
        scheduleAlert: (id, index, delayMs) =>
          queue('alertTask').enqueue({ requestId: id, index }, { scheduleDelaySeconds: Math.round(delayMs / 1000), id: `alert-${id}-${index}` }),
        scheduleExpire: (id, delayMs) =>
          queue('expireTask').enqueue({ requestId: id }, { scheduleDelaySeconds: Math.ceil(delayMs / 1000), id: `expire-${id}` }),
      },
    });
  }
  return cached;
};

const HTTPS_CODE = {
  unauthenticated: 'unauthenticated',
  forbidden: 'permission-denied',
  not_found: 'not-found',
  rate_limited: 'resource-exhausted',
  limit_reached: 'resource-exhausted',
  message_limit: 'resource-exhausted',
  session_closed: 'failed-precondition',
  not_accepting: 'failed-precondition',
  own_car: 'failed-precondition',
};

const authOf = (req) => (req.auth ? { uid: req.auth.uid, provider: req.auth.token && req.auth.token.firebase && req.auth.token.firebase.sign_in_provider } : null);

const callable = (fn) => onCall(async (req) => {
  try {
    return await fn(authOf(req), req.data || {});
  } catch (e) {
    if (e instanceof ServiceError) throw new HttpsError(HTTPS_CODE[e.code] || 'invalid-argument', e.code, e.details);
    console.error('unhandled_error', e);
    throw new HttpsError('internal', 'internal');
  }
});

// Owner (non-anonymous) callables
exports.createCar = callable((a, d) => service().createCar(a, d));
exports.rotateQr = callable((a, d) => service().rotateQr(a, d));
exports.markViewed = callable((a, d) => service().markViewed(a, d));
exports.ackDelivered = callable((a, d) => service().ackDelivered(a, d));
exports.closeRequest = callable((a, d) => service().closeRequest(a, d));
// Visitor (anonymous auth) callables
exports.createRequest = callable((a, d) => service().createRequest(a, d));
exports.cancelRequest = callable((a, d) => service().cancelRequest(a, d));
// Both
exports.sendMessage = callable((a, d) => service().sendMessage(a, d));

// Cloud Tasks handlers (the service re-checks the CURRENT request state before acting)
const retryConfig = { maxAttempts: 3, minBackoffSeconds: 5 };
exports.alertTask = onTaskDispatched({ retryConfig, rateLimits: { maxConcurrentDispatches: 20 } }, async (req) => {
  await service().fireAlert(req.data.requestId, req.data.index);
});
exports.expireTask = onTaskDispatched({ retryConfig, rateLimits: { maxConcurrentDispatches: 20 } }, async (req) => {
  await service().expireRequest(req.data.requestId);
});

// Safety net: expires anything whose task was lost
exports.expirySweep = onSchedule('every 1 minutes', async () => {
  await service().sweepExpired();
});
