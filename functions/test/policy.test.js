'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/core/policy');

test('create-request: accepts every listed reason, message optional', () => {
  for (const reason of P.REASONS) {
    const r = P.validateCreateRequest({ reason });
    assert.equal(r.ok, true, reason);
    assert.equal(r.value.message, '');
  }
});

test('create-request: rejects bad payloads and unknown reasons', () => {
  assert.equal(P.validateCreateRequest(null).error, 'invalid_payload');
  assert.equal(P.validateCreateRequest('x').error, 'invalid_payload');
  assert.equal(P.validateCreateRequest({ reason: 'hack' }).error, 'invalid_reason');
  assert.equal(P.validateCreateRequest({}).error, 'invalid_reason');
  assert.equal(P.validateCreateRequest({ reason: 'other', message: 5 }).error, 'invalid_text');
});

test('message: trimmed, control and bidi-override chars stripped, Arabic preserved', () => {
  const r = P.validateCreateRequest({ reason: 'other', message: '  \u0000انزل\u202E لو سمحت\u0007  ' });
  assert.equal(r.ok, true);
  assert.equal(r.value.message, 'انزل لو سمحت');
});

test('message length limit counts characters (not UTF-16 units) and is inclusive', () => {
  const cfg = { ...P.DEFAULT_CONFIG, maxMessageLen: 5 };
  assert.equal(P.validateChatMessage('12345', cfg).ok, true);
  assert.equal(P.validateChatMessage('123456', cfg).error, 'message_too_long');
  assert.equal(P.validateChatMessage('😀😀😀😀😀', cfg).ok, true); // 5 chars, 10 UTF-16 units
  assert.equal(P.validateChatMessage('😀😀😀😀😀😀', cfg).error, 'message_too_long');
});

test('chat message cannot be empty or whitespace-only', () => {
  assert.equal(P.validateChatMessage('').error, 'empty_message');
  assert.equal(P.validateChatMessage('   \n ').error, 'empty_message');
  assert.equal(P.validateChatMessage(undefined).error, 'empty_message');
});

test('expiry defaults to 15 minutes and is configurable', () => {
  assert.equal(P.computeExpiry(1000), 1000 + 15 * 60 * 1000);
  assert.equal(P.computeExpiry(1000, { requestTtlMs: 60000 }), 61000);
  assert.equal(P.isExpired(5000, 4999), false);
  assert.equal(P.isExpired(5000, 5000), true);
});

test('rate limiter: allows up to max in window, then blocks with correct retry time', () => {
  const lim = { max: 3, windowMs: 10000 };
  assert.deepEqual(P.checkRateLimit([], 0, lim), { allowed: true, retryAfterMs: 0 });
  assert.equal(P.checkRateLimit([1000, 2000], 5000, lim).allowed, true);
  const blocked = P.checkRateLimit([1000, 2000, 3000], 5000, lim);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 1000 + 10000 - 5000); // oldest of the last 3 expires at 11000
  assert.equal(P.checkRateLimit([1000, 2000, 3000], 11000, lim).allowed, true); // window slid past oldest
  assert.equal(P.checkRateLimit([-50000, -40000, -30000], 0, lim).allowed, true); // all stale
});
