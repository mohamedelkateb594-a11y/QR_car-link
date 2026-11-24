'use strict';
/** Firestore implementation of the store used by src/service.js. NOT yet run against the emulator. */
const { ACTIVE_ORDER } = require('./core/states');
const { ServiceError } = require('./errors');

function createFirestoreStore(db) {
  const requests = () => db.collection('requests');
  const withId = (snap) => (snap.exists ? { id: snap.id, ...snap.data() } : null);

  return {
    newId: () => requests().doc().id,

    async getTokenRecord(hash) {
      const s = await db.collection('qrTokens').doc(hash).get();
      return s.exists ? s.data() : null;
    },
    async getCar(id) { return withId(await db.collection('cars').doc(id).get()); },
    async countCarsByOwner(uid) {
      const s = await db.collection('cars').where('ownerUid', '==', uid).count().get();
      return s.data().count;
    },
    async createCarWithToken(car, hash) {
      const { id, ...data } = car;
      const batch = db.batch();
      batch.set(db.collection('cars').doc(id), data);
      batch.set(db.collection('qrTokens').doc(hash), { carId: id, ownerUid: car.ownerUid, active: true, createdAt: car.createdAt });
      await batch.commit();
    },
    async rotateToken({ carId, ownerUid, oldHash, newHash, now }) {
      const batch = db.batch();
      batch.update(db.collection('cars').doc(carId), { activeTokenHash: newHash });
      batch.set(db.collection('qrTokens').doc(oldHash), { active: false, rotatedAt: now }, { merge: true });
      batch.set(db.collection('qrTokens').doc(newHash), { carId, ownerUid, active: true, createdAt: now });
      await batch.commit();
    },

    async getUserSettings(uid) {
      const s = await db.collection('users').doc(uid).get();
      return s.exists ? s.data() : {};
    },
    async listDevices(uid) {
      const s = await db.collection('users').doc(uid).collection('devices').get();
      return s.docs.map((d) => ({ id: d.id, token: d.data().token }));
    },
    async deleteDevice(uid, deviceId) {
      await db.collection('users').doc(uid).collection('devices').doc(deviceId).delete();
    },

    async insertRequest(req) {
      const { id, ...data } = req;
      await requests().doc(id).set(data);
    },
    async getRequest(id) { return withId(await requests().doc(id).get()); },

    /** Needs composite indexes (field, createdAt) - see firestore.indexes.json. */
    async listRecentRequestTimes(field, value, sinceMs) {
      const s = await requests().where(field, '==', value).where('createdAt', '>=', sinceMs).select('createdAt').limit(100).get();
      return s.docs.map((d) => d.get('createdAt'));
    },
    /** Needs composite index (status, expiresAtMs). */
    async listExpirable(nowMs, limit) {
      const s = await requests().where('status', 'in', ACTIVE_ORDER).where('expiresAtMs', '<=', nowMs).limit(limit).get();
      return s.docs.map((d) => d.id);
    },

    /** `fn(current)` -> { patch?, message?, result? }. Runs in a transaction, so it must be pure. */
    mutateRequest(id, fn) {
      return db.runTransaction(async (tx) => {
        const ref = requests().doc(id);
        const snap = await tx.get(ref);
        if (!snap.exists) throw new ServiceError('not_found');
        const cur = { id: snap.id, ...snap.data() };
        const out = fn(cur) || {};
        const patch = out.patch || {};
        let messageId;
        if (Object.keys(patch).length) tx.update(ref, patch);
        if (out.message) {
          const mref = ref.collection('messages').doc();
          messageId = mref.id;
          tx.set(mref, out.message);
        }
        return { request: { ...cur, ...patch }, messageId, result: out.result };
      });
    },
  };
}

module.exports = { createFirestoreStore };
