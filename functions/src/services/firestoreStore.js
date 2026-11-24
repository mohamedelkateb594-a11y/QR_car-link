'use strict';
/**
 * Firestore adapter for the service's store interface. NOT TESTED (no emulator/network in the build environment).
 * Firestore transactions require all reads before all writes, but the service interleaves them, so writes are
 * BUFFERED and flushed after the callback. This is safe because the service never reads a document it has
 * already written in the same transaction (see service.js; keep it that way).
 */
const { isTerminal } = require('../core/states');

const TERMINAL_LIST = ['closed_on_the_way', 'closed_resolved', 'cancelled', 'expired'];

function createFirestoreStore(db) {
  const col = (n) => db.collection(n);
  const clean = (o) => JSON.parse(JSON.stringify(o)); // drop undefined

  const makeTx = (t, writes) => {
    const get = async (ref) => { const s = await t.get(ref); return s.exists ? s.data() : undefined; };
    const set = (ref, v) => { writes.push(() => t.set(ref, clean(v))); };
    return {
      getToken: (h) => get(col('qrTokens').doc(h)), setToken: async (h, v) => set(col('qrTokens').doc(h), v),
      getCar: (id) => get(col('cars').doc(id)), setCar: async (id, v) => set(col('cars').doc(id), v),
      countCars: async (uid) => (await t.get(col('cars').where('ownerUid', '==', uid))).size,
      getRequest: (id) => get(col('requests').doc(id)), setRequest: async (id, v) => set(col('requests').doc(id), v),
      getSession: (id) => get(col('sessions').doc(id)), setSession: async (id, v) => set(col('sessions').doc(id), v),
      addMessage: async (id, m) => set(col('sessions').doc(id).collection('messages').doc(), m),
      getUser: (uid) => get(col('users').doc(uid)),
      getRate: async (k) => (await get(col('rate').doc(k)))?.ts || [], setRate: async (k, v) => set(col('rate').doc(k), { ts: v }),
    };
  };

  return {
    newId: () => col('requests').doc().id,
    transaction: (fn) => db.runTransaction(async (t) => {
      const writes = [];
      const out = await fn(makeTx(t, writes));
      writes.forEach((w) => w());
      return out;
    }),
    getRequest: async (id) => { const s = await col('requests').doc(id).get(); return s.exists ? s.data() : undefined; },
    listOpenExpired: async (nowMs) => {
      const q = await col('requests').where('expiresAt', '<=', nowMs).limit(200).get();
      return q.docs.map((d) => d.data()).filter((r) => !isTerminal(r.status)).map((r) => r.id);
    },
    TERMINAL_LIST,
  };
}

module.exports = { createFirestoreStore };
