'use strict';
/** In-memory implementations of the ports. transition() is synchronous inside, i.e. atomic like a Firestore txn. */
const clone = (x) => (x === undefined ? undefined : structuredClone(x));

function createMemoryStore() {
  const db = { cars: new Map(), tokens: new Map(), requests: new Map(), messages: new Map(), users: new Map(), rate: [] };
  let mid = 0;
  return {
    db,
    async getQrToken(h) { return clone(db.tokens.get(h)) || null; },
    async getCar(id) { return clone(db.cars.get(id)) || null; },
    async createCar(car, tok) { db.cars.set(car.id, clone(car)); db.tokens.set(tok.hash, clone(tok)); },
    async rotateQr({ carId, oldHash, newHash, newToken, now, ownerUid }) {
      db.tokens.get(oldHash).active = false;
      db.tokens.set(newHash, { hash: newHash, carId, ownerUid, active: true, createdAt: now });
      Object.assign(db.cars.get(carId), { qrToken: newToken, qrTokenHash: newHash, qrRotatedAt: now });
    },
    async getRequest(id) { return clone(db.requests.get(id)) || null; },
    async createRequestDoc(d) { db.requests.set(d.id, clone(d)); db.messages.set(d.id, []); },
    async findOpenRequest(carId, visitorUid) {
      for (const r of db.requests.values()) if (r.carId === carId && r.visitorUid === visitorUid && r.open) return clone(r);
      return null;
    },
    async transition(id, { allowedFrom, patch, message }) {
      const cur = db.requests.get(id);
      if (!cur) return { ok: false, reason: 'not_found' };
      if (!allowedFrom.includes(cur.status)) return { ok: false, reason: 'bad_state', current: clone(cur) };
      Object.assign(cur, patch);
      let messageId;
      if (message) { messageId = `m${++mid}`; db.messages.get(id).push({ id: messageId, ...clone(message), participants: clone(cur.participants) }); }
      return { ok: true, request: clone(cur), messageId };
    },
    async getOwnerSettings(uid) { return clone(db.users.get(uid)) || null; },
    async recordRateEvent(e) { db.rate.push(clone(e)); },
    async listRateEvents(field, value, sinceMs) { return db.rate.filter((e) => e[field] === value && e.at > sinceMs).map((e) => e.at); },
    async listOpenExpired(nowMs, limit) {
      return [...db.requests.values()].filter((r) => r.open && r.expiresAtMs <= nowMs).slice(0, limit).map(clone);
    },
  };
}

function createClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

function createFakePush({ failFor = new Set() } = {}) {
  const sent = [];
  return {
    sent, failFor,
    async notifyOwner(ownerUid, payload) {
      if (failFor.has('all')) throw new Error('push down');
      sent.push({ ownerUid, ...payload });
    },
  };
}

function createFakeScheduler() {
  const tasks = [];
  return { tasks, async enqueue(payload, delayMs) { tasks.push({ payload, delayMs }); } };
}

module.exports = { createMemoryStore, createClock, createFakePush, createFakeScheduler };
