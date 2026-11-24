'use strict';
/**
 * Cloud Functions wiring (Phase 2). NOT DEPLOYED / NOT TESTED: requires `npm install` (firebase-admin,
 * firebase-functions v2) and a Firebase project (decision D4). All business rules live in src/services/service.js
 * and are covered by unit tests; this file only adapts transport, auth and side-effect providers.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { getFunctions } = require('firebase-admin/functions');
const { createService } = require('./src/services/service');
const { createFirestoreStore } = require('./src/services/firestoreStore');
const { AppError } = require('./src/services/errors');

initializeApp();
const db = getFirestore();
const BASE_URL = process.env.QR_BASE_URL; // decision D5: final QR domain must be fixed BEFORE printing

const CODE_MAP = { unauthenticated: 'unauthenticated', not_found: 'not-found', rate_limited: 'resource-exhausted', session_closed: 'failed-precondition' };

const notifier = {
  /** Sends FCM to every device of the owner. `accepted` only means FCM took it - NOT that the owner saw it. */
  async push(uid, data) {
    const devs = await db.collection('users').doc(uid).collection('devices').get();
    const tokens = devs.docs.map((d) => d.data().token).filter(Boolean);
    if (!tokens.length) return { accepted: false };
    // Data-only + high priority so the app builds the notification on its custom channel (Phase 6).
    const r = await getMessaging().sendEachForMulticast({ tokens, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])), android: { priority: 'high' } });
    return { accepted: r.successCount > 0 };
  },
};

const scheduler = {
  async scheduleAlert(requestId, step, atMs) {
    await getFunctions().taskQueue('alertTask').enqueue({ requestId, step }, { scheduleTime: new Date(atMs) });
  },
  async scheduleExpire(requestId, atMs) {
    await getFunctions().taskQueue('expireTask').enqueue({ requestId }, { scheduleTime: new Date(atMs) });
  },
};

const svc = createService({ store: createFirestoreStore(db), notifier, scheduler, baseUrl: BASE_URL });

/** Wrap a service call: auth uid from the request, domain errors -> HttpsError with a stable code. */
const callable = (fn) => onCall({ enforceAppCheck: false /* Phase 7: true */ }, async (req) => {
  try { return await fn({ uid: req.auth && req.auth.uid, data: req.data || {}, req }); }
  catch (e) {
    if (e instanceof AppError) throw new HttpsError(CODE_MAP[e.code] || 'invalid-argument', e.code, e.details);
    console.error(e); throw new HttpsError('internal', 'internal');
  }
});

exports.createCar = callable(({ uid, data }) => svc.createCar({ uid, label: data.label, color: data.color }));
exports.rotateQr = callable(({ uid, data }) => svc.rotateQr({ uid, carId: data.carId }));
exports.createRequest = callable(({ uid, data }) => svc.createRequest({ uid, token: data.token, payload: { reason: data.reason, message: data.message } }));
exports.sendMessage = callable(({ uid, data }) => svc.sendMessage({ uid, requestId: data.requestId, text: data.text }));
exports.markViewed = callable(({ uid, data }) => svc.markViewed({ uid, requestId: data.requestId }));
exports.closeRequest = callable(({ uid, data }) => svc.closeRequest({ uid, requestId: data.requestId, kind: data.kind, note: data.note }));
exports.cancelRequest = callable(({ uid, data }) => svc.cancelRequest({ uid, requestId: data.requestId }));

exports.alertTask = onTaskDispatched({ retryConfig: { maxAttempts: 2 }, rateLimits: { maxConcurrentDispatches: 20 } }, (req) => svc.fireAlert(req.data));
exports.expireTask = onTaskDispatched({ retryConfig: { maxAttempts: 3 } }, (req) => svc.expireRequest(req.data));
exports.sweepExpired = onSchedule('every 1 minutes', () => svc.sweepExpired());
