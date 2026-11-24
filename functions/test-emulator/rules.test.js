'use strict';
// Run with: npm run test:rules   (needs firebase-tools + the Firestore emulator). NOT yet executed.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

let env;
test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-qr-car',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8') },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('cars/c1').set({ ownerUid: 'owner', label: 'A', color: 'w', acceptingRequests: true, activeTokenHash: 'h' });
    await db.doc('qrTokens/h').set({ carId: 'c1', active: true });
    await db.doc('requests/r1').set({ ownerUid: 'owner', visitorUid: 'vis', participants: ['owner', 'vis'], status: 'sent' });
    await db.doc('requests/r1/messages/m1').set({ from: 'visitor', text: 'hi', createdAt: 1 });
  });
});
test.after(() => env.cleanup());

const owner = () => env.authenticatedContext('owner', { firebase: { sign_in_provider: 'google.com' } }).firestore();
const vis = () => env.authenticatedContext('vis', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const stranger = () => env.authenticatedContext('x', { firebase: { sign_in_provider: 'anonymous' } }).firestore();

test('request + messages readable by both participants only', async () => {
  await assertSucceeds(owner().doc('requests/r1').get());
  await assertSucceeds(vis().doc('requests/r1').get());
  await assertFails(stranger().doc('requests/r1').get());
  await assertSucceeds(vis().collection('requests/r1/messages').orderBy('createdAt').get());
  await assertSucceeds(owner().collection('requests/r1/messages').orderBy('createdAt').get());
  await assertFails(stranger().collection('requests/r1/messages').orderBy('createdAt').get());
  await assertFails(env.unauthenticatedContext().firestore().doc('requests/r1').get());
});

test("owner's request list query is allowed via participants array-contains", async () => {
  await assertSucceeds(owner().collection('requests').where('participants', 'array-contains', 'owner').orderBy('createdAt', 'desc').get());
});

test('clients can never write requests or messages', async () => {
  await assertFails(owner().doc('requests/r1').update({ status: 'closed_resolved' }));
  await assertFails(vis().doc('requests/r1').update({ status: 'cancelled' }));
  await assertFails(vis().collection('requests/r1/messages').add({ from: 'visitor', text: 'x' }));
  await assertFails(vis().collection('requests').add({ participants: ['vis'] }));
});

test('cars: owner reads and edits cosmetic fields only; no create/delete; tokens unreadable', async () => {
  await assertSucceeds(owner().doc('cars/c1').get());
  await assertFails(vis().doc('cars/c1').get());
  await assertSucceeds(owner().doc('cars/c1').update({ label: 'B' }));
  await assertFails(owner().doc('cars/c1').update({ ownerUid: 'me' }));
  await assertFails(owner().doc('cars/c1').update({ activeTokenHash: 'z' }));
  await assertFails(owner().doc('cars/c2').set({ ownerUid: 'owner', label: 'n' }));
  await assertFails(owner().doc('cars/c1').delete());
  await assertFails(owner().doc('qrTokens/h').get());
});

test('anonymous visitors cannot touch owner settings or devices', async () => {
  await assertFails(vis().doc('users/vis').set({ level: 'off' }));
  await assertSucceeds(owner().doc('users/owner').set({ level: 'light', repeatEnabled: true }));
  await assertFails(owner().doc('users/owner').set({ level: 'light', isAdmin: true }));
  await assertSucceeds(owner().doc('users/owner/devices/d1').set({ token: 't', platform: 'android', updatedAt: 1 }));
});
