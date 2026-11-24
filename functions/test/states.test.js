'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { STATUS: S, canTransition, canSendMessage, isTerminal, isAlertingStatus } = require('../src/core/states');

test('owner can close from any active state, with either closing action', () => {
  for (const from of [S.CREATED, S.SENT, S.DELIVERED, S.VIEWED, S.IN_PROGRESS]) {
    assert.equal(canTransition(from, S.CLOSED_ON_THE_WAY, 'owner'), true, from);
    assert.equal(canTransition(from, S.CLOSED_RESOLVED, 'owner'), true, from);
  }
});

test('closed sessions never reopen and accept no further transitions', () => {
  for (const from of [S.CLOSED_ON_THE_WAY, S.CLOSED_RESOLVED, S.CANCELLED, S.EXPIRED]) {
    assert.equal(isTerminal(from), true);
    for (const to of Object.values(S)) {
      for (const actor of ['owner', 'visitor', 'system']) {
        assert.equal(canTransition(from, to, actor), false, `${from}->${to} by ${actor}`);
      }
    }
  }
});

test('actors are restricted: visitor only cancels, system only expires/sends, owner closes', () => {
  assert.equal(canTransition(S.SENT, S.CANCELLED, 'visitor'), true);
  assert.equal(canTransition(S.SENT, S.CANCELLED, 'owner'), false);
  assert.equal(canTransition(S.SENT, S.CLOSED_RESOLVED, 'visitor'), false);
  assert.equal(canTransition(S.SENT, S.EXPIRED, 'system'), true);
  assert.equal(canTransition(S.SENT, S.EXPIRED, 'owner'), false);
  assert.equal(canTransition(S.CREATED, S.SENT, 'system'), true);
  assert.equal(canTransition(S.SENT, S.VIEWED, 'owner'), true);
  assert.equal(canTransition(S.SENT, S.VIEWED, 'visitor'), false);
});

test('non-terminal progress is forward only', () => {
  assert.equal(canTransition(S.VIEWED, S.SENT, 'system'), false);
  assert.equal(canTransition(S.VIEWED, S.VIEWED, 'owner'), false);
  assert.equal(canTransition(S.VIEWED, S.IN_PROGRESS, 'owner'), true);
  assert.equal(canTransition(S.IN_PROGRESS, S.VIEWED, 'owner'), false);
});

test('unknown states are rejected', () => {
  assert.equal(canTransition('bogus', S.CLOSED_RESOLVED, 'owner'), false);
  assert.equal(canTransition(S.SENT, 'bogus', 'owner'), false);
  assert.equal(canSendMessage('bogus'), false);
});

test('messages allowed only while session is open', () => {
  for (const s of [S.CREATED, S.SENT, S.DELIVERED, S.VIEWED, S.IN_PROGRESS]) assert.equal(canSendMessage(s), true, s);
  for (const s of [S.CLOSED_ON_THE_WAY, S.CLOSED_RESOLVED, S.CANCELLED, S.EXPIRED]) assert.equal(canSendMessage(s), false, s);
});

test('alerting statuses stop once the owner has opened the request (assumption A2)', () => {
  assert.equal(isAlertingStatus(S.SENT), true);
  assert.equal(isAlertingStatus(S.VIEWED), false);
  assert.equal(isAlertingStatus(S.CLOSED_RESOLVED), false);
});
