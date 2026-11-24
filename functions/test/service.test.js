'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../src/services/service');
const { createMemoryStore } = require('../src/services/memoryStore');
const { hashToken } = require('../src/core/token');

function setup() {
  let now = 1_000_000;
  const pushes = []; const alerts = []; const expires = [];
  const store = createMemoryStore();
  const svc = createService({
    store, baseUrl: 'https://example.test', clock: () => now,
    notifier: { push: async (uid, p) => { pushes.push({ uid, ...p }); return { accepted: true }; } },
    scheduler: { scheduleAlert: async (id, step, at) => alerts.push({ id, step, at }), scheduleExpire: async (id, at) => expires.push({ id, at }) },
  });
  return { svc, store, pushes, alerts, expires, tick: (ms) => { now += ms; }, now: () => now };
}
const tokenOf = (url) => url.split('/c/')[1];
async function withCar(ctx, uid = 'owner1') {
  const { qrUrl, carId } = await ctx.svc.createCar({ uid, label: 'Car' });
  return { token: tokenOf(qrUrl), carId };
}
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code);

test('QR: token is stored only as a hash and URL points to /c/<token>', async () => {
  const ctx = setup(); const { token } = await withCar(ctx);
  assert.ok(ctx.store._db.tokens.has(hashToken(token)));
  assert.ok(![...ctx.store._db.tokens.keys()].includes(token));
});

test('criterion 3: request reaches the right owner, alerts + expiry are scheduled', async () => {
  const ctx = setup(); const { token } = await withCar(ctx);
  const { requestId } = await ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'move_car', message: 'hi' } });
  assert.equal(ctx.pushes[0].uid, 'owner1');
  assert.equal(ctx.store._db.requests.get(requestId).status, 'sent');
  assert.deepEqual(ctx.alerts.map((a) => a.at - 1_000_000), [30000, 60000, 90000]);
  assert.equal(ctx.expires[0].at - 1_000_000, 15 * 60 * 1000);
});

test('push failure does not lose the request (stays `created`, not `sent`)', async () => {
  const ctx = setup(); const { token } = await withCar(ctx);
  ctx.svc = createService({ store: ctx.store, baseUrl: 'x', clock: ctx.now, notifier: { push: async () => { throw new Error('fcm down'); } }, scheduler: { scheduleAlert: async () => {}, scheduleExpire: async () => {} } });
  const { requestId } = await ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'other' } });
  assert.equal(ctx.store._db.requests.get(requestId).status, 'created');
});

test('invalid / revoked / paused tokens all give the same generic error', async () => {
  const ctx = setup(); const { token, carId } = await withCar(ctx);
  await rejects(ctx.svc.createRequest({ token: 'short', uid: 'v1', payload: { reason: 'other' } }), 'not_found');
  await rejects(ctx.svc.createRequest({ token: 'A'.repeat(32), uid: 'v1', payload: { reason: 'other' } }), 'not_found');
  await ctx.svc.rotateQr({ uid: 'owner1', carId });
  await rejects(ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'other' } }), 'not_found'); // old QR revoked
  const car = ctx.store._db.cars.get(carId); ctx.store._db.cars.set(carId, { ...car, acceptingRequests: false });
  const { qrUrl } = await ctx.svc.rotateQr({ uid: 'owner1', carId });
  await rejects(ctx.svc.createRequest({ token: tokenOf(qrUrl), uid: 'v1', payload: { reason: 'other' } }), 'not_found'); // paused
});

test('only the car owner can rotate its QR', async () => {
  const ctx = setup(); const { carId } = await withCar(ctx);
  await rejects(ctx.svc.rotateQr({ uid: 'intruder', carId }), 'not_found');
});

test('rate limit: 4th request from one visitor in the window is refused', async () => {
  const ctx = setup(); const { token } = await withCar(ctx);
  for (let i = 0; i < 3; i++) await ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'other' } });
  await rejects(ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'other' } }), 'rate_limited');
  await ctx.svc.createRequest({ token, uid: 'v2', payload: { reason: 'other' } }); // another visitor still fine
});

test('criterion 5: both sides exchange messages; owner is pushed on visitor messages', async () => {
  const ctx = setup(); const { token } = await withCar(ctx);
  const { requestId } = await ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'move_car' } });
  await ctx.svc.sendMessage({ requestId, uid: 'v1', text: 'where are you?' });
  await ctx.svc.sendMessage({ requestId, uid: 'owner1', text: 'coming' });
  assert.deepEqual(ctx.store._db.messages.get(requestId).map((m) => m.from), ['visitor', 'owner']);
  assert.equal(ctx.pushes.filter((p) => p.type === 'new_message').length, 1);
});

test('criterion 12: a stranger cannot read/write/close/cancel someone else\'s session', async () => {
  const ctx = setup(); const { token } = await withCar(ctx);
  const { requestId } = await ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'other' } });
  await rejects(ctx.svc.sendMessage({ requestId, uid: 'v2', text: 'x' }), 'not_found');
  await rejects(ctx.svc.markViewed({ requestId, uid: 'v2' }), 'not_found');
  await rejects(ctx.svc.closeRequest({ requestId, uid: 'v2', kind: 'resolved' }), 'not_found');
  await rejects(ctx.svc.cancelRequest({ requestId, uid: 'owner1' }), 'not_found');   // owner cannot cancel (visitor action)
  await rejects(ctx.svc.closeRequest({ requestId, uid: 'v1', kind: 'resolved' }), 'not_found'); // visitor cannot close
});

test('criterion 7+8: closing ends the session, note is the last message, nothing can follow', async () => {
  const ctx = setup(); const { token } = await withCar(ctx);
  const { requestId } = await ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'move_car' } });
  const r = await ctx.svc.closeRequest({ requestId, uid: 'owner1', kind: 'on_the_way', note: 'two minutes' });
  assert.equal(r.status, 'closed_on_the_way');
  assert.equal(ctx.store._db.sessions.get(requestId).status, 'closed_on_the_way');
  await rejects(ctx.svc.sendMessage({ requestId, uid: 'v1', text: 'hello?' }), 'session_closed');
  await rejects(ctx.svc.sendMessage({ requestId, uid: 'owner1', text: 'hello?' }), 'session_closed');
  await rejects(ctx.svc.closeRequest({ requestId, uid: 'owner1', kind: 'resolved' }), 'session_closed'); // no reopen / re-close
  await rejects(ctx.svc.cancelRequest({ requestId, uid: 'v1' }), 'session_closed');
  assert.equal(ctx.store._db.messages.get(requestId).at(-1).text, 'two minutes');
});

test('resolved close works straight from `sent` (owner never opened first)', async () => {
  const ctx = setup(); const { token } = await withCar(ctx);
  const { requestId } = await ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'move_car' } });
  assert.equal((await ctx.svc.closeRequest({ requestId, uid: 'owner1', kind: 'resolved' })).status, 'closed_resolved');
});

test('criterion 10: alerts stop after view / close / cancel / expiry', async () => {
  const ctx = setup(); const { token } = await withCar(ctx);
  const mk = async (uid) => (await ctx.svc.createRequest({ token, uid, payload: { reason: 'other' } })).requestId;
  const a = await mk('va'); const b = await mk('vb'); const c = await mk('vc'); const d = await mk('vd');
  assert.equal((await ctx.svc.fireAlert({ requestId: a, step: 0 })).fired, true);   // still unanswered
  await ctx.svc.markViewed({ requestId: a, uid: 'owner1' });
  await ctx.svc.closeRequest({ requestId: b, uid: 'owner1', kind: 'resolved' });
  await ctx.svc.cancelRequest({ requestId: c, uid: 'vc' });
  ctx.tick(15 * 60 * 1000);                                                       // d expires by time alone
  for (const id of [a, b, c, d]) assert.equal((await ctx.svc.fireAlert({ requestId: id, step: 1 })).fired, false, id);
});

test('markViewed is idempotent and never downgrades or reopens', async () => {
  const ctx = setup(); const { token } = await withCar(ctx);
  const { requestId } = await ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'other' } });
  assert.equal((await ctx.svc.markViewed({ requestId, uid: 'owner1' })).status, 'viewed');
  assert.equal((await ctx.svc.markViewed({ requestId, uid: 'owner1' })).status, 'viewed');
  await ctx.svc.closeRequest({ requestId, uid: 'owner1', kind: 'resolved' });
  assert.equal((await ctx.svc.markViewed({ requestId, uid: 'owner1' })).status, 'closed_resolved');
});

test('criterion 9+11: expiry is server-side (Task, sweep, or lazily on any write) and visible in the mirror', async () => {
  const ctx = setup(); const { token } = await withCar(ctx);
  const mk = async (uid) => (await ctx.svc.createRequest({ token, uid, payload: { reason: 'other' } })).requestId;
  const a = await mk('va'); const b = await mk('vb'); const c = await mk('vc');
  assert.equal((await ctx.svc.expireRequest({ requestId: a })).status, 'sent');     // too early: no-op
  ctx.tick(15 * 60 * 1000);
  assert.equal((await ctx.svc.expireRequest({ requestId: a })).status, 'expired');  // Task path
  assert.equal((await ctx.svc.expireRequest({ requestId: a })).status, 'expired');  // duplicate Task: harmless
  assert.deepEqual(await ctx.svc.sweepExpired(), { expired: 2 });                   // sweep catches b and c
  assert.equal(ctx.store._db.sessions.get(b).status, 'expired');
  await rejects(ctx.svc.sendMessage({ requestId: b, uid: 'vb', text: 'late' }), 'session_closed');
});

test('lazy expiry: a message sent after the deadline expires the session instead of being stored', async () => {
  const ctx = setup(); const { token } = await withCar(ctx);
  const { requestId } = await ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'other' } });
  ctx.tick(15 * 60 * 1000 + 1);
  await rejects(ctx.svc.sendMessage({ requestId, uid: 'v1', text: 'late' }), 'session_closed');
  assert.equal(ctx.store._db.requests.get(requestId).status, 'expired'); // lazy expiry persisted (transaction did not roll it back)
});

test('visitor mirror never exposes owner or car ids', async () => {
  const ctx = setup(); const { token } = await withCar(ctx);
  const { requestId } = await ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'other', message: 'hi' } });
  const s = JSON.stringify(ctx.store._db.sessions.get(requestId)) + JSON.stringify(ctx.store._db.messages.get(requestId));
  assert.ok(!s.includes('owner1')); assert.ok(!/carId/.test(s));
});

test('bad input: unknown reason, over-long text, bidi-override stripped', async () => {
  const ctx = setup(); const { token } = await withCar(ctx);
  await rejects(ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'nope' } }), 'invalid_reason');
  await rejects(ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'other', message: 'x'.repeat(501) } }), 'message_too_long');
  const { requestId } = await ctx.svc.createRequest({ token, uid: 'v1', payload: { reason: 'other', message: 'ok‮txt' } });
  assert.equal(ctx.store._db.messages.get(requestId)[0].text, 'oktxt');
});

test('car limit per user', async () => {
  const ctx = setup();
  for (let i = 0; i < 5; i++) await ctx.svc.createCar({ uid: 'o', label: `c${i}` });
  await rejects(ctx.svc.createCar({ uid: 'o' }), 'car_limit_reached');
});
