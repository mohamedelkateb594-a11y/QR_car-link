'use strict';
/**
 * Firestore implementation of the `store` port used by the services.
 * !! NOT RUN YET: written in Phase 2 without firebase-admin installed or an emulator available. !!
 * Review + test against the Firebase Emulator before trusting it (see DEVELOPER_HANDOFF.md).
 * `db` is an admin Firestore instance. All times are epoch-ms numbers.
 */
function createFirestoreStore(db) {
  const col = (n) => db.collection(n);
  const data = (snap) => (snap.exists ? { id: snap.id, ...snap.data() } : null);

  return {
    async getQrToken(hash) { const s = await col('qrTokens').doc(hash).get(); return s.exists ? s.data() : null; },
    async getCar(id) { return data(await col('cars').doc(id).get()); },

    async createCar(car, tokenDoc) {
      const b = db.batch();
      b.set(col('cars').doc(car.id), car);
      b.set(col('qrTokens').doc(tokenDoc.hash), tokenDoc);
      await b.commit();
    },

    async rotateQr({ carId, ownerUid, oldHash, newHash, newToken, now }) {
      const b = db.batch();
      b.update(col('qrTokens').doc(oldHash), { active: false });
      b.set(col('qrTokens').doc(newHash), { hash: newHash, carId, ownerUid, active: true, createdAt: now });
      b.update(col('cars').doc(carId), { qrToken: newToken, qrTokenHash: newHash, qrRotatedAt: now });
      await b.commit();
    },

    async getRequest(id) { return data(await col('requests').doc(id).get()); },
    async createRequestDoc(doc) { await col('requests').doc(doc.id).set(doc); },

    async findOpenRequest(carId, visitorUid) {
      const q = await col('requests').where('carId', '==', carId).where('visitorUid', '==', visitorUid)
        .where('open', '==', true).limit(1).get();
      return q.empty ? null : data(q.docs[0]);
    },

    /** Atomic compare-and-set on `status`, optionally appending a message in the same transaction. */
    async transition(id, { allowedFrom, patch, message }) {
      return db.runTransaction(async (tx) => {
        const ref = col('requests').doc(id);
        const snap = await tx.get(ref);
        if (!snap.exists) return { ok: false, reason: 'not_found' };
        const cur = snap.data();
        if (!allowedFrom.includes(cur.status)) return { ok: false, reason: 'bad_state', current: { id, ...cur } };
        if (Object.keys(patch).length) tx.update(ref, patch);
        let messageId;
        if (message) {
          const mref = ref.collection('messages').doc();
          tx.set(mref, { ...message, participants: cur.participants });
          messageId = mref.id;
        }
        return { ok: true, request: { id, ...cur, ...patch }, messageId };
      });
    },

    async getOwnerSettings(uid) { const s = await col('users').doc(uid).get(); return s.exists ? s.data() : null; },

    // Server-only collection (rules deny all client access). Needs the composite indexes in firestore.indexes.json.
    async recordRateEvent(e) { await col('rateEvents').add(e); },
    async listRateEvents(field, value, sinceMs) {
      const q = await col('rateEvents').where(field, '==', value).where('at', '>', sinceMs).get();
      return q.docs.map((d) => d.get('at'));
    },

    async listOpenExpired(nowMs, limit) {
      const q = await col('requests').where('open', '==', true).where('expiresAtMs', '<=', nowMs).limit(limit).get();
      return q.docs.map(data);
    },
  };
}
module.exports = { createFirestoreStore };
