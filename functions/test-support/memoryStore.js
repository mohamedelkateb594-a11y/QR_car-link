'use strict';
/** In-memory store with the same contract as src/firestoreStore.js, for unit tests. */
const { ACTIVE_ORDER } = require('../src/core/states');
const { ServiceError } = require('../src/errors');

const clone = (x) => (x === undefined ? x : structuredClone(x));

function createMemoryStore() {
  let n = 0;
  const db = { cars: new Map(), tokens: new Map(), requests: new Map(), messages: [], users: new Map(), devices: new Map() };
  return {
    db,
    newId: () => `id${++n}`,
    async getTokenRecord(h) { return clone(db.tokens.get(h)) || null; },
    async getCar(id) { return clone(db.cars.get(id)) || null; },
    async countCarsByOwner(uid) { return [...db.cars.values()].filter((c) => c.ownerUid === uid).length; },
    async createCarWithToken(car, hash) {
      db.cars.set(car.id, clone(car));
      db.tokens.set(hash, { carId: car.id, ownerUid: car.ownerUid, active: true, createdAt: car.createdAt });
    },
    async rotateToken({ carId, ownerUid, oldHash, newHash, now }) {
      db.cars.get(carId).activeTokenHash = newHash;
      db.tokens.set(oldHash, { ...db.tokens.get(oldHash), active: false, rotatedAt: now });
      db.tokens.set(newHash, { carId, ownerUid, active: true, createdAt: now });
    },
    async getUserSettings(uid) { return clone(db.users.get(uid)) || {}; },
    async listDevices(uid) { return clone(db.devices.get(uid)) || []; },
    async deleteDevice(uid, id) { db.devices.set(uid, (db.devices.get(uid) || []).filter((d) => d.id !== id)); },
    async insertRequest(req) { db.requests.set(req.id, clone(req)); },
    async getRequest(id) { return clone(db.requests.get(id)) || null; },
    async listRecentRequestTimes(field, value, sinceMs) {
      return [...db.requests.values()].filter((r) => r[field] === value && r.createdAt >= sinceMs).map((r) => r.createdAt);
    },
    async listExpirable(nowMs, limit) {
      return [...db.requests.values()].filter((r) => ACTIVE_ORDER.includes(r.status) && r.expiresAtMs <= nowMs).slice(0, limit).map((r) => r.id);
    },
    async mutateRequest(id, fn) {
      const stored = db.requests.get(id);
      if (!stored) throw new ServiceError('not_found');
      const cur = clone(stored);
      const out = fn(cur) || {};
      const patch = out.patch || {};
      let messageId;
      if (out.message) { messageId = `m${++n}`; db.messages.push({ requestId: id, id: messageId, ...clone(out.message) }); }
      db.requests.set(id, { ...stored, ...patch });
      return { request: { ...cur, ...patch }, messageId, result: out.result };
    },
  };
}

module.exports = { createMemoryStore };
