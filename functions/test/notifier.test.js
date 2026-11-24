'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier } = require('../src/notifier');
const { createMemoryStore } = require('../test-support/memoryStore');
const { buildAlertSchedule } = require('../src/core/escalation');

test('push carries the reason label but never the visitor text; sets the high-priority channel', async () => {
  const store = createMemoryStore();
  store.db.devices.set('o', [{ id: 'd1', token: 'tok1' }]);
  const sent = [];
  const n = createNotifier({ store, messaging: { async send(m) { sent.push(m); } } });
  assert.deepEqual(await n.notifyOwner('o', { requestId: 'r1', reason: 'blocked_me' }), { sent: 1 });
  assert.equal(sent[0].token, 'tok1');
  assert.equal(sent[0].data.requestId, 'r1');
  assert.equal(sent[0].android.priority, 'high');
  assert.equal(sent[0].android.notification.channelId, 'contact_requests');
});

test('dead tokens are removed, other failures are logged and do not stop other devices', async () => {
  const store = createMemoryStore();
  store.db.devices.set('o', [{ id: 'dead', token: 'a' }, { id: 'flaky', token: 'b' }, { id: 'ok', token: 'c' }]);
  const logged = [];
  const n = createNotifier({
    store,
    logger: { error: (...a) => logged.push(a) },
    messaging: {
      async send(m) {
        if (m.token === 'a') throw Object.assign(new Error('x'), { code: 'messaging/registration-token-not-registered' });
        if (m.token === 'b') throw Object.assign(new Error('x'), { code: 'messaging/internal-error' });
      },
    },
  });
  assert.deepEqual(await n.notifyOwner('o', { requestId: 'r', reason: 'other' }), { sent: 1 });
  assert.deepEqual((await store.listDevices('o')).map((d) => d.id), ['flaky', 'ok']);
  assert.equal(logged.length, 1);
});

test('escalation: hostile level names fall back to standard instead of throwing', () => {
  assert.deepEqual(buildAlertSchedule({ level: 'constructor' }), [0, 30000, 60000, 90000]);
  assert.deepEqual(buildAlertSchedule({ level: '__proto__' }), [0, 30000, 60000, 90000]);
});
