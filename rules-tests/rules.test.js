'use strict';
/* Security tests for database.rules.json (the only protection of the free-plan edition). Run: npm test */
const fs = require('node:fs');
const path = require('node:path');
const { test, before, beforeEach, after } = require('node:test');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const NOW = { '.sv': 'timestamp' };
const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);
const TOKEN = 'T'.repeat(32);
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-qr-car',
    database: { host: '127.0.0.1', port: 9000, rules: fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8') },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearDatabase();
  await seed({ ['links/' + HASH]: { ownerUid: 'owner', carId: 'c1', active: true } });
});

const seed = (values) => env.withSecurityRulesDisabled((c) => c.database().ref().update(values));
const as = (uid, provider) => env.authenticatedContext(uid, { firebase: { sign_in_provider: provider } }).database();
const owner = () => as('owner', 'password');
const stranger = () => as('stranger', 'password');
const visitor = (uid = 'v1') => as(uid, 'anonymous');

const request = (uid = 'v1', extra = {}) => ({ visitorUid: uid, reason: 'move_car', status: 'sent', createdAt: NOW, ...extra });
const create = (db, uid, rid, hash = HASH, body = request(uid)) => db.ref().update({
  ['requests/' + hash + '/' + rid]: body,
  ['visitorState/' + uid + '/lastAt']: NOW,
  ['visitorState/' + uid + '/lastKey']: hash + '/' + rid,
});
const seedRequest = (status = 'sent', ageMs = 0) =>
  seed({ ['requests/' + HASH + '/r1']: { visitorUid: 'v1', reason: 'other', status, createdAt: Date.now() - ageMs } });
const message = (from) => ({ from, text: 'hello', createdAt: NOW });

test('visitor creates a request on an active link', async () => {
  await assertSucceeds(create(visitor(), 'v1', 'r1'));
});
test('one write cannot create two requests', async () => {
  await assertFails(visitor().ref().update({
    ['requests/' + HASH + '/r1']: request(),
    ['requests/' + HASH + '/r2']: request(),
    'visitorState/v1/lastAt': NOW,
    'visitorState/v1/lastKey': HASH + '/r1',
  }));
});
test('second request within a minute is refused', async () => {
  await assertSucceeds(create(visitor(), 'v1', 'r1'));
  await assertFails(create(visitor(), 'v1', 'r2'));
});
test('request without the cooldown write is refused', async () => {
  await assertFails(visitor().ref('requests/' + HASH + '/r1').set(request()));
});
test('paused or unknown link refuses requests', async () => {
  await assertFails(create(visitor(), 'v1', 'r1', HASH2));
  await seed({ ['links/' + HASH + '/active']: false });
  await assertFails(create(visitor(), 'v1', 'r1'));
});
test('request cannot carry extra fields or another visitor uid', async () => {
  await assertFails(create(visitor(), 'v1', 'r1', HASH, request('v1', { phone: '0100' })));
  await assertFails(create(visitor(), 'v1', 'r1', HASH, request('v2')));
});
test('only the owner and that visitor can read a request', async () => {
  await seedRequest();
  await assertSucceeds(visitor().ref('requests/' + HASH + '/r1').get());
  await assertSucceeds(owner().ref('requests/' + HASH).get());
  await assertFails(visitor('v2').ref('requests/' + HASH + '/r1').get());
  await assertFails(stranger().ref('requests/' + HASH).get());
  await assertFails(visitor().ref('links/' + HASH).get());
});
test('status moves only in the allowed direction and by the right side', async () => {
  await seedRequest();
  const st = (db) => db.ref('requests/' + HASH + '/r1/status');
  await assertFails(st(visitor()).set('viewed'));
  await assertFails(st(owner()).set('cancelled'));
  await assertSucceeds(st(owner()).set('viewed'));
  await assertSucceeds(st(owner()).set('closed_on_the_way'));
  await assertFails(st(owner()).set('viewed'));
  await assertFails(st(visitor()).set('cancelled'));
});
test('both sides can chat while open, nobody else', async () => {
  await seedRequest();
  const m = (db, id) => db.ref('messages/' + HASH + '/r1/' + id);
  await assertSucceeds(m(visitor(), 'm1').set(message('visitor')));
  await assertSucceeds(m(owner(), 'm2').set(message('owner')));
  await assertFails(m(visitor(), 'm3').set(message('owner')));
  await assertFails(m(visitor('v2'), 'm4').set(message('visitor')));
  await assertFails(m(visitor(), 'm1').set(message('visitor')));
  await assertFails(m(stranger(), 'm5').set(message('owner')));
});
test('closed request refuses messages', async () => {
  await seedRequest('closed_resolved');
  await assertFails(visitor().ref('messages/' + HASH + '/r1/m1').set(message('visitor')));
});
test('expired request refuses messages and status changes', async () => {
  await seedRequest('sent', 16 * 60 * 1000);
  await assertFails(visitor().ref('messages/' + HASH + '/r1/m1').set(message('visitor')));
  await assertFails(owner().ref('requests/' + HASH + '/r1/status').set('viewed'));
});
test('a link cannot be removed or taken over', async () => {
  await assertFails(owner().ref('links/' + HASH).remove());
  await assertFails(owner().ref('links/' + HASH + '/ownerUid').remove());
  await assertFails(stranger().ref('links/' + HASH).set({ ownerUid: 'stranger', carId: 'x', active: true }));
  await assertSucceeds(owner().ref('links/' + HASH + '/active').set(false));
});
test('anonymous users cannot own links or car backups', async () => {
  await assertFails(visitor().ref('links/' + HASH2).set({ ownerUid: 'v1', carId: 'x', active: true }));
  await assertFails(visitor().ref('owners/v1/cars/c1').set({ label: 'car', token: TOKEN, updatedAt: NOW }));
});
test('car backup (with the QR token) is private to its owner', async () => {
  await assertSucceeds(owner().ref('owners/owner/cars/c1').set({ label: 'car', token: TOKEN, updatedAt: NOW }));
  await assertSucceeds(owner().ref('owners/owner/cars').get());
  await assertFails(stranger().ref('owners/owner/cars').get());
  await assertFails(visitor().ref('owners/owner/cars').get());
  await assertFails(stranger().ref('owners/owner/cars/c1').set({ deleted: true, updatedAt: NOW }));
  await assertFails(owner().ref('owners/owner/cars/c2').set({ label: 'car', token: 'short', updatedAt: NOW }));
});
test('app writes: add, rotate and delete a car atomically', async () => {
  const backup = { label: 'car', token: TOKEN, updatedAt: NOW };
  await assertSucceeds(owner().ref().update({
    ['links/' + HASH2]: { ownerUid: 'owner', carId: 'c2', active: true }, 'owners/owner/cars/c2': backup,
  }));
  await assertSucceeds(owner().ref().update({
    ['links/' + 'c'.repeat(64)]: { ownerUid: 'owner', carId: 'c2', active: true },
    ['links/' + HASH2 + '/active']: false, 'owners/owner/cars/c2': backup,
  }));
  await assertSucceeds(owner().ref().update({
    ['links/' + 'c'.repeat(64) + '/active']: false, 'owners/owner/cars/c2': { deleted: true, updatedAt: NOW },
  }));
});
