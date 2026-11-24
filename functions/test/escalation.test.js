'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAlertSchedule, shouldFireAlert } = require('../src/core/escalation');
const { STATUS: S } = require('../src/core/states');

test('default schedule matches spec example: 0/30/60/90 seconds', () => {
  assert.deepEqual(buildAlertSchedule(), [0, 30000, 60000, 90000]);
  assert.deepEqual(buildAlertSchedule({}), [0, 30000, 60000, 90000]);
});

test('repeat can be disabled or reduced; unknown level falls back to standard; result is a copy', () => {
  assert.deepEqual(buildAlertSchedule({ repeatEnabled: false }), [0]);
  assert.deepEqual(buildAlertSchedule({ level: 'off' }), [0]);
  assert.deepEqual(buildAlertSchedule({ level: 'light' }), [0, 60000]);
  assert.deepEqual(buildAlertSchedule({ level: 'nonsense' }), [0, 30000, 60000, 90000]);
  const a = buildAlertSchedule(); a.push(1);
  assert.deepEqual(buildAlertSchedule(), [0, 30000, 60000, 90000]);
});

test('alert fires only for unopened, unexpired, non-terminal requests', () => {
  const now = 10_000;
  assert.equal(shouldFireAlert({ status: S.SENT, expiresAtMs: now + 1 }, now), true);
  assert.equal(shouldFireAlert({ status: S.CREATED, expiresAtMs: now + 1 }, now), true);
  assert.equal(shouldFireAlert({ status: S.SENT }, now), true);
});

test('alert is suppressed after view, close, cancel, expiry, or when request is missing', () => {
  const now = 10_000;
  for (const status of [S.VIEWED, S.IN_PROGRESS, S.CLOSED_ON_THE_WAY, S.CLOSED_RESOLVED, S.CANCELLED, S.EXPIRED]) {
    assert.equal(shouldFireAlert({ status, expiresAtMs: now + 1000 }, now), false, status);
  }
  assert.equal(shouldFireAlert({ status: S.SENT, expiresAtMs: now }, now), false); // expiry boundary
  assert.equal(shouldFireAlert(null, now), false);
  assert.equal(shouldFireAlert(undefined, now), false);
});
