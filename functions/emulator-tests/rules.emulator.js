'use strict';
/**
 * Firestore security-rules tests. Run ONLY against the Firestore emulator (see docs/ci.yml.txt):
 *   firebase emulators:exec --only firestore --project demo-qr-car "cd functions && node --test emulator-tests/rules.emulator.js"
 * Deliberately NOT named *.test.js so that `npm test` (unit tests, no emulator) does not pick it up.
 * !! First authored without being able to run it (no network/emulator in the authoring environment). !!
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, setLogLevel } = require('firebase/firestore');

setLogLevel('error');
let env;

const owner = () => env.authenticatedContext('owner1', { firebase: { sign_in_provider: 'google.com' } }).firestore();
const otherOwner = () => env.authenticatedContext('owner2', { firebase: { sign_in_provider: 'google.com' } }).firestore();
const visitor = () => env.authenticatedContext('visitor1', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const otherVisitor = () => env.authenticatedContext('visitor2', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-qr-car',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8') },
  });
});
test.after(async () => { await env.cleanup(); });
test.beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'cars/car1'), { id: 'car1', ownerUid: 'owner1', label: 'A', color: 'red', acceptingRequests: true, qrToken: 'T', qrTokenHash: 'H', createdAt: 1 });
    await setDoc(doc(db, 'qrTokens/H'), { hash: 'H', carId: 'car1', ownerUid: 'owner1', active: true });
    await setDoc(doc(db, 'rateEvents/e1'), { carId: 'car1', visitorUid: 'visitor1', ipHash: 'x', at: 1 });
    await setDoc(doc(db, 'requests/r1'), { id: 'r1', carId: 'car1', ownerUid: 'owner1', visitorUid: 'visitor1', participants: ['owner1', 'visitor1'], status: 'sent', open: true });
    await setDoc(doc(db, 'requests/r1/messages/m1'), { from: 'visitor', text: 'hi', participants: ['owner1', 'visitor1'], createdAt: 1 });
    await setDoc(doc(db, 'users/owner1'), { level: 'standard' });
  });
});

test('requests: only the two participants can read (criterion 12)', async () => {
  await assertSucceeds(getDoc(doc(owner(), 'requests/r1')));
  await assertSucceeds(getDoc(doc(visitor(), 'requests/r1')));
  await assertFails(getDoc(doc(otherVisitor(), 'requests/r1')));
  await assertFails(getDoc(doc(otherOwner(), 'requests/r1')));
  await assertFails(getDoc(doc(anon(), 'requests/r1')));
});

test('requests: no direct client writes by anyone (all writes go through Cloud Functions)', async () => {
  for (const db of [owner(), visitor(), otherVisitor(), anon()]) {
    await assertFails(setDoc(doc(db, 'requests/new'), { participants: ['owner1', 'visitor1'], status: 'created' }));
    await assertFails(updateDoc(doc(db, 'requests/r1'), { status: 'closed_resolved' }));
    await assertFails(deleteDoc(doc(db, 'requests/r1')));
  }
});

test('messages: participants read, outsiders cannot; nobody writes directly (no messages after close)', async () => {
  await assertSucceeds(getDoc(doc(visitor(), 'requests/r1/messages/m1')));
  await assertSucceeds(getDocs(collection(owner(), 'requests/r1/messages')));
  await assertFails(getDoc(doc(otherVisitor(), 'requests/r1/messages/m1')));
  await assertFails(getDoc(doc(anon(), 'requests/r1/messages/m1')));
  for (const db of [owner(), visitor()]) {
    await assertFails(setDoc(doc(db, 'requests/r1/messages/m2'), { from: 'owner', text: 'x', participants: ['owner1', 'visitor1'] }));
    await assertFails(updateDoc(doc(db, 'requests/r1/messages/m1'), { text: 'edited' }));
    await assertFails(deleteDoc(doc(db, 'requests/r1/messages/m1')));
  }
});

test('server-only collections: qrTokens and rateEvents are closed to every client', async () => {
  for (const db of [owner(), visitor(), anon()]) {
    await assertFails(getDoc(doc(db, 'qrTokens/H')));
    await assertFails(setDoc(doc(db, 'qrTokens/Z'), { carId: 'car1' }));
    await assertFails(getDoc(doc(db, 'rateEvents/e1')));
    await assertFails(setDoc(doc(db, 'rateEvents/e2'), { at: 1 }));
  }
});

test('cars: owner reads; others and anonymous visitors cannot', async () => {
  await assertSucceeds(getDoc(doc(owner(), 'cars/car1')));
  await assertFails(getDoc(doc(otherOwner(), 'cars/car1')));
  await assertFails(getDoc(doc(visitor(), 'cars/car1')));
  await assertFails(getDoc(doc(anon(), 'cars/car1')));
});

test('cars: owner may edit only cosmetic fields; cannot touch ownerUid/qrToken; no client create/delete', async () => {
  await assertSucceeds(updateDoc(doc(owner(), 'cars/car1'), { label: 'New', acceptingRequests: false }));
  await assertFails(updateDoc(doc(owner(), 'cars/car1'), { ownerUid: 'owner2' }));
  await assertFails(updateDoc(doc(owner(), 'cars/car1'), { qrToken: 'stolen' }));
  await assertFails(updateDoc(doc(owner(), 'cars/car1'), { label: 'x'.repeat(61) }));
  await assertFails(updateDoc(doc(owner(), 'cars/car1'), { acceptingRequests: 'yes' }));
  await assertFails(updateDoc(doc(otherOwner(), 'cars/car1'), { label: 'hijack' }));
  await assertFails(setDoc(doc(owner(), 'cars/car2'), { ownerUid: 'owner1', label: 'B' }));
  await assertFails(deleteDoc(doc(owner(), 'cars/car1')));
});

test('users: owner manages own settings with valid values only; anonymous visitors cannot', async () => {
  await assertSucceeds(setDoc(doc(owner(), 'users/owner1'), { repeatEnabled: false, level: 'light' }));
  await assertFails(setDoc(doc(owner(), 'users/owner1'), { level: 'insane' }));
  await assertFails(setDoc(doc(owner(), 'users/owner1'), { level: 'light', isAdmin: true }));
  await assertFails(setDoc(doc(owner(), 'users/owner1'), { repeatEnabled: 'no' }));
  await assertFails(setDoc(doc(otherOwner(), 'users/owner1'), { level: 'light' }));
  await assertFails(getDoc(doc(otherOwner(), 'users/owner1')));
  await assertFails(setDoc(doc(visitor(), 'users/visitor1'), { level: 'light' }));
  await assertSucceeds(getDoc(doc(owner(), 'users/owner1')));
});

test('users/devices: owner registers an android FCM token; bad shapes and other users are rejected', async () => {
  await assertSucceeds(setDoc(doc(owner(), 'users/owner1/devices/d1'), { token: 'abc', platform: 'android', updatedAt: 1 }));
  await assertFails(setDoc(doc(owner(), 'users/owner1/devices/d2'), { token: 'abc', platform: 'ios' }));
  await assertFails(setDoc(doc(owner(), 'users/owner1/devices/d3'), { token: '', platform: 'android' }));
  await assertFails(setDoc(doc(owner(), 'users/owner1/devices/d4'), { token: 'abc', platform: 'android', extra: 1 }));
  await assertFails(setDoc(doc(otherOwner(), 'users/owner1/devices/d5'), { token: 'abc', platform: 'android' }));
  await assertFails(setDoc(doc(visitor(), 'users/visitor1/devices/d6'), { token: 'abc', platform: 'android' }));
});

test('unknown collections are denied by default', async () => {
  await assertFails(getDoc(doc(owner(), 'secrets/x')));
  await assertFails(setDoc(doc(owner(), 'secrets/x'), { a: 1 }));
});
