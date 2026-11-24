'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../src/service');
const { createMemoryStore } = require('../test-support/memoryStore');
const { generateToken, hashToken } = require('../src/core/token');
const { STATUS: S } = require('../src/core/states');
const { DEFAULT_CONFIG } = require('../src/core/policy');

const OWNER = { uid: 'owner1', provider: 'google.com' };
const visitor = (n = 1) => ({ uid: `visitor${n}`, provider: 'anonymous' });
const MIN = 60 * 1000;

async function setup({ devices = 1, settings } = {}) {
  const store = createMemoryStore();
  const clock = { t: 1_000_000 };
  const sched = { alerts: [], expires: [] };
  const push = { calls: [], sent: devices };
  const svc = createService({
    store,
    baseUrl: 'https://qr.example',
    now: () => clock.t,
    logger: { error() {} },
    scheduler: {
      async scheduleAlert(id, index, delayMs) { sched.alerts.push({ id, index, delayMs }); },
      async scheduleExpire(id, delayMs) { sched.expires.push({ id, delayMs }); },
    },
    notifier: { async notifyOwner(uid, p) { push.calls.push({ uid, ...p }); return { sent: push.sent }; } },
  });
  if (settings) store.db.users.set(OWNER.uid, settings);
  const car = await svc.createCar(OWNER, { label: 'Corolla', color: 'white' });
  const token = car.qrUrl.split('/c/')[1];
  const open = async (v = visitor(1), extra = {}) => svc.createRequest(v, { token, reason: 'blocked_me', ...extra });
  return { svc, store, clock, sched, push, car, token, open };
}
const code = (p) => p.then(() => 'no-error', (e) => e.code);

test('createCar: stores only the token hash, returns the QR url once, owners only, capped', async () => {
  const { svc, store, car, token } = await setup();
  assert.match(car.qrUrl, /^https:\/\/qr\.example\/c\/[A-Za-z0-9_-]{32}$/);
  assert.ok(store.db.tokens.has(hashToken(token)));
  assert.equal(JSON.stringify([...store.db.cars.values()]).includes(token), false);
  assert.equal(await code(svc.createCar(visitor(), { label: 'x' })), 'forbidden');
  assert.equal(await code(svc.createCar(null, { label: 'x' })), 'unauthenticated');
  for (let i = 0; i < 4; i++) await svc.createCar(OWNER, { label: `c${i}` });
  assert.equal(await code(svc.createCar(OWNER, { label: 'one too many' })), 'limit_reached');
});

test('rotateQr: old token stops working, new one works, only the car owner may rotate', async () => {
  const { svc, car, token, open } = await setup();
  assert.equal(await code(svc.rotateQr({ uid: 'other', provider: 'google.com' }, { carId: car.carId })), 'not_found');
  const rotated = await svc.rotateQr(OWNER, { carId: car.carId });
  assert.equal(await code(open()), 'not_found');
  const newToken = rotated.qrUrl.split('/c/')[1];
  assert.notEqual(newToken, token);
  const r = await svc.createRequest(visitor(), { token: newToken, reason: 'move_car' });
  assert.ok(r.requestId);
});

test('createRequest: status sent when a push goes out, created when owner has no device; schedules expiry + alerts', async () => {
  const a = await setup({ devices: 1 });
  const r = await a.open();
  assert.equal(r.status, S.SENT);
  assert.equal(r.expiresAtMs, 1_000_000 + 15 * MIN);
  assert.deepEqual(a.sched.expires, [{ id: r.requestId, delayMs: 15 * MIN }]);
  assert.deepEqual(a.sched.alerts.map((x) => x.delayMs), [30000, 60000, 90000]);
  assert.equal(a.push.calls.length, 1);
  const req = a.store.db.requests.get(r.requestId);
  assert.deepEqual(req.participants, ['owner1', 'visitor1']);

  const b = await setup({ devices: 0 });
  assert.equal((await b.open()).status, S.CREATED);
});

test('createRequest: respects the owner alert level', async () => {
  const a = await setup({ settings: { level: 'light' } });
  await a.open();
  assert.deepEqual(a.sched.alerts.map((x) => x.delayMs), [60000]);
  const b = await setup({ settings: { repeatEnabled: false } });
  await b.open();
  assert.deepEqual(b.sched.alerts, []);
});

test('createRequest: rejects bad input, unknown/malformed tokens, own car, paused car, anonymous-less callers', async () => {
  const { svc, store, car, token, open } = await setup();
  assert.equal(await code(svc.createRequest(null, { token, reason: 'other' })), 'unauthenticated');
  assert.equal(await code(svc.createRequest(visitor(), { token, reason: 'hack' })), 'invalid_reason');
  assert.equal(await code(svc.createRequest(visitor(), { token, reason: 'other', message: 'x'.repeat(501) })), 'message_too_long');
  assert.equal(await code(svc.createRequest(visitor(), { token: 'short', reason: 'other' })), 'not_found');
  assert.equal(await code(svc.createRequest(visitor(), { token: generateToken(), reason: 'other' })), 'not_found');
  assert.equal(await code(svc.createRequest({ uid: OWNER.uid, provider: 'anonymous' }, { token, reason: 'other' })), 'own_car');
  store.db.cars.get(car.carId).acceptingRequests = false;
  assert.equal(await code(open()), 'not_accepting');
});

test('createRequest: rate limits per visitor (3/10min) and per car (10/hour) with retry time', async () => {
  const a = await setup();
  for (let i = 0; i < 3; i++) await a.open(visitor(1));
  try { await a.open(visitor(1)); assert.fail('expected rate_limited'); } catch (e) {
    assert.equal(e.code, 'rate_limited');
    assert.equal(e.details.retryAfterMs, 10 * MIN);
  }
  a.clock.t += 10 * MIN;
  assert.ok((await a.open(visitor(1))).requestId);

  const b = await setup();
  for (let i = 0; i < 10; i++) await b.open(visitor(100 + i));
  assert.equal(await code(b.open(visitor(999))), 'rate_limited');
});

test('alerts: fire while unopened; stop after the owner views, closes, or the request expires', async () => {
  const { svc, clock, open, store } = await setup();
  const { requestId } = await open();
  assert.equal((await svc.fireAlert(requestId, 1)).fired, true);
  await svc.markViewed(OWNER, { requestId });
  assert.equal((await svc.fireAlert(requestId, 2)).fired, false);

  const second = await open(visitor(2));
  clock.t += 15 * MIN;
  assert.equal((await svc.fireAlert(second.requestId, 1)).fired, false);
  assert.equal((await svc.fireAlert('missing', 1)).fired, false);
  assert.ok(store.db.requests.size === 2);
});

test('markViewed / ackDelivered: owner only, idempotent, visitor cannot', async () => {
  const { svc, open } = await setup({ devices: 0 });
  const { requestId } = await open();
  assert.equal(await code(svc.markViewed(visitor(), { requestId })), 'not_found');
  assert.equal((await svc.ackDelivered(OWNER, { requestId })).status, S.DELIVERED);
  assert.equal((await svc.markViewed(OWNER, { requestId })).status, S.VIEWED);
  assert.equal((await svc.markViewed(OWNER, { requestId })).status, S.VIEWED);
  assert.equal((await svc.ackDelivered(OWNER, { requestId })).status, S.VIEWED); // never goes backwards
  assert.equal(await code(svc.markViewed({ uid: 'stranger', provider: 'anonymous' }, { requestId })), 'not_found');
});

test('chat: both sides can talk, owner reply moves to in_progress, strangers and empty text rejected', async () => {
  const { svc, store, open } = await setup();
  const { requestId } = await open();
  await svc.sendMessage(visitor(), { requestId, text: 'من فضلك انزل' });
  assert.equal((await svc.sendMessage(OWNER, { requestId, text: 'نازل حالا' })).status, S.IN_PROGRESS);
  assert.deepEqual(store.db.messages.map((m) => m.from), ['visitor', 'owner']);
  assert.equal(store.db.messages[0].text, 'من فضلك انزل');
  assert.equal(await code(svc.sendMessage({ uid: 'stranger', provider: 'anonymous' }, { requestId, text: 'hi' })), 'not_found');
  assert.equal(await code(svc.sendMessage(visitor(), { requestId, text: '   ' })), 'empty_message');
  assert.equal(await code(svc.sendMessage(null, { requestId, text: 'hi' })), 'unauthenticated');
});

test('chat: capped per request', async () => {
  const { svc, open } = await setup();
  const { requestId } = await open();
  for (let i = 0; i < 100; i++) await svc.sendMessage(visitor(), { requestId, text: `m${i}` });
  assert.equal(await code(svc.sendMessage(visitor(), { requestId, text: 'one more' })), 'message_limit');
});

test('close: owner closes with either outcome; afterwards no messages, no reopening, no second close', async () => {
  for (const [outcome, status] of [['on_the_way', S.CLOSED_ON_THE_WAY], ['resolved', S.CLOSED_RESOLVED]]) {
    const { svc, open, store } = await setup();
    const { requestId } = await open();
    assert.equal(await code(svc.closeRequest(visitor(), { requestId, outcome })), 'not_found');
    assert.equal(await code(svc.closeRequest(OWNER, { requestId, outcome: 'constructor' })), 'invalid_outcome');
    assert.equal((await svc.closeRequest(OWNER, { requestId, outcome })).status, status);
    assert.equal(await code(svc.sendMessage(visitor(), { requestId, text: 'hello?' })), 'session_closed');
    assert.equal(await code(svc.sendMessage(OWNER, { requestId, text: 'hello?' })), 'session_closed');
    assert.equal(await code(svc.closeRequest(OWNER, { requestId, outcome })), 'session_closed');
    assert.equal(await code(svc.cancelRequest(visitor(), { requestId })), 'session_closed');
    assert.equal((await svc.markViewed(OWNER, { requestId })).status, status);
    assert.equal(store.db.messages.length, 0);
  }
});

test('cancel: visitor only; blocks further messages', async () => {
  const { svc, open } = await setup();
  const { requestId } = await open();
  assert.equal(await code(svc.cancelRequest(OWNER, { requestId })), 'not_found');
  assert.equal((await svc.cancelRequest(visitor(), { requestId })).status, S.CANCELLED);
  assert.equal(await code(svc.sendMessage(visitor(), { requestId, text: 'x' })), 'session_closed');
});

test('expiry: 15 min after creation, even if the owner already opened it; sweep + task + lazy paths', async () => {
  const { svc, clock, open, store } = await setup();
  const a = await open(visitor(1));
  const b = await open(visitor(2));
  const c = await open(visitor(3));
  await svc.markViewed(OWNER, { requestId: b.requestId });
  await svc.sendMessage(OWNER, { requestId: c.requestId, text: 'on it' }); // in_progress

  clock.t += 15 * MIN - 1;
  assert.deepEqual(await svc.sweepExpired(), { expired: 0 });
  assert.equal((await svc.expireRequest(a.requestId)).expired, false); // task fired too early: no-op

  clock.t += 1;
  assert.deepEqual(await svc.sweepExpired(), { expired: 3 });
  for (const r of [a, b, c]) assert.equal(store.db.requests.get(r.requestId).status, S.EXPIRED);
  assert.deepEqual(await svc.sweepExpired(), { expired: 0 });
  assert.equal(await code(svc.sendMessage(visitor(1), { requestId: a.requestId, text: 'late' })), 'session_closed');
  assert.equal((await svc.expireRequest('nope')).expired, false);
});

test('expiry: lazily applied when someone acts after the deadline but before the sweep ran', async () => {
  const { svc, clock, open, store } = await setup();
  const { requestId } = await open();
  clock.t += 16 * MIN;
  assert.equal(await code(svc.sendMessage(visitor(), { requestId, text: 'hi' })), 'session_closed');
  assert.equal(store.db.requests.get(requestId).status, S.EXPIRED);
  assert.equal(store.db.messages.length, 0);
});

test('scheduling failures do not lose the request', async () => {
  const store = createMemoryStore();
  const svc = createService({
    store, baseUrl: 'https://qr.example', logger: { error() {} },
    scheduler: { async scheduleAlert() { throw new Error('queue down'); }, async scheduleExpire() { throw new Error('queue down'); } },
    notifier: { async notifyOwner() { return { sent: 1 }; } },
  });
  const car = await svc.createCar(OWNER, { label: 'x' });
  const r = await svc.createRequest(visitor(), { token: car.qrUrl.split('/c/')[1], reason: 'other' });
  assert.equal(r.status, S.SENT);
  assert.equal(DEFAULT_CONFIG.requestTtlMs, 15 * MIN);
});
