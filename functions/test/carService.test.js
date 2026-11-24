'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, OWNER, VISITOR } = require('./helpers/world');
const { isWellFormedToken, hashToken } = require('../src/core/token');

test('createCar: QR url contains only a well-formed random token; hash lookup doc is active', async () => {
  const w = await makeWorld();
  assert.match(w.qrUrl, /^https:\/\/qr\.example\.test\/c\/[A-Za-z0-9_-]{32}$/);
  assert.equal(isWellFormedToken(w.token), true);
  const tok = w.store.db.tokens.get(hashToken(w.token));
  assert.equal(tok.active, true);
  assert.equal(tok.carId, w.carId);
  assert.equal(tok.ownerUid, OWNER.uid);
  // no phone/PII fields anywhere on the car or token docs
  assert.deepEqual(Object.keys(w.store.db.cars.get(w.carId)).sort(),
    ['acceptingRequests', 'color', 'createdAt', 'id', 'label', 'ownerUid', 'qrToken', 'qrTokenHash'].sort());
});

test('createCar: rejects over-long label; refuses to run without a base url', async () => {
  const w = await makeWorld();
  await assert.rejects(w.cars.createCar({ label: 'x'.repeat(61) }, OWNER), { code: 'message_too_long' });
  const { createCarService } = require('../src/services/carService');
  const bad = createCarService({ store: w.store, clock: w.clock, newId: () => 'z', baseUrl: '' });
  await assert.rejects(bad.createCar({ label: 'a' }, OWNER), { code: 'misconfigured_base_url' });
});

test('rotateQr: old token stops working, new token works, only the owner may rotate', async () => {
  const w = await makeWorld();
  const { qrUrl } = await w.cars.rotateQr({ carId: w.carId }, OWNER);
  const newToken = qrUrl.split('/c/')[1];
  assert.notEqual(newToken, w.token);
  await assert.rejects(w.reqs.createRequest({ token: w.token, reason: 'move_car' }, VISITOR), { code: 'invalid_link' });
  const ok = await w.reqs.createRequest({ token: newToken, reason: 'move_car' }, VISITOR);
  assert.ok(ok.requestId);
  await assert.rejects(w.cars.rotateQr({ carId: w.carId }, { uid: 'stranger' }), { code: 'not_found' });
  await assert.rejects(w.cars.rotateQr({ carId: 'nope' }, OWNER), { code: 'not_found' });
});
