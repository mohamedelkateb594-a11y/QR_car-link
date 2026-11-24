'use strict';
/** In-memory store for unit tests. Transactions are serialised (mutex) and rolled back on throw. */
const { isTerminal } = require('../core/states');

function createMemoryStore() {
  const db = { tokens: new Map(), cars: new Map(), requests: new Map(), sessions: new Map(), messages: new Map(), users: new Map(), rate: new Map() };
  let seq = 0;
  let chain = Promise.resolve();
  const clone = (x) => (x === undefined ? undefined : structuredClone(x));

  const makeTx = (d) => ({
    getToken: async (h) => clone(d.tokens.get(h)), setToken: async (h, v) => { d.tokens.set(h, clone(v)); },
    getCar: async (id) => clone(d.cars.get(id)), setCar: async (id, v) => { d.cars.set(id, clone(v)); },
    countCars: async (uid) => [...d.cars.values()].filter((c) => c.ownerUid === uid).length,
    getRequest: async (id) => clone(d.requests.get(id)), setRequest: async (id, v) => { d.requests.set(id, clone(v)); },
    getSession: async (id) => clone(d.sessions.get(id)), setSession: async (id, v) => { d.sessions.set(id, clone(v)); },
    addMessage: async (id, m) => { d.messages.set(id, [...(d.messages.get(id) || []), clone(m)]); },
    getUser: async (uid) => clone(d.users.get(uid)),
    getRate: async (k) => clone(d.rate.get(k)) || [], setRate: async (k, v) => { d.rate.set(k, clone(v)); },
  });

  return {
    _db: db,
    newId: () => `id${++seq}_${Math.random().toString(36).slice(2, 10)}`,
    transaction(fn) {
      const run = chain.then(async () => {
        const snap = { tokens: new Map(db.tokens), cars: new Map(db.cars), requests: new Map(db.requests), sessions: new Map(db.sessions), messages: new Map(db.messages), users: new Map(db.users), rate: new Map(db.rate) };
        try { return await fn(makeTx(db)); } catch (e) { for (const k of Object.keys(snap)) { db[k].clear(); for (const [a, b] of snap[k]) db[k].set(a, b); } throw e; }
      });
      chain = run.catch(() => {});
      return run;
    },
    getRequest: async (id) => clone(db.requests.get(id)),
    listOpenExpired: async (nowMs) => [...db.requests.values()].filter((r) => !isTerminal(r.status) && nowMs >= r.expiresAt).map((r) => r.id),
  };
}

module.exports = { createMemoryStore };
