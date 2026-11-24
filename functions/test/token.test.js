'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateToken, isWellFormedToken, hashToken, buildQrUrl } = require('../src/core/token');

test('tokens are well-formed, 32 chars, and unique across 5000 samples', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const t = generateToken();
    assert.equal(t.length, 32);
    assert.equal(isWellFormedToken(t), true);
    seen.add(t);
  }
  assert.equal(seen.size, 5000);
});

test('malformed tokens are rejected', () => {
  for (const bad of ['', 'short', 'a'.repeat(31), 'a'.repeat(33), 'a'.repeat(31) + '!', 'a'.repeat(31) + ' ', null, undefined, 42, {}]) {
    assert.equal(isWellFormedToken(bad), false, String(bad));
  }
});

test('hash is deterministic, 64 hex chars, and differs from the token', () => {
  const t = generateToken();
  assert.equal(hashToken(t), hashToken(t));
  assert.match(hashToken(t), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken(t), t);
  assert.notEqual(hashToken(t), hashToken(generateToken()));
});

test('QR url holds only the token (no phone or personal data) and tolerates trailing slashes', () => {
  const t = generateToken();
  assert.equal(buildQrUrl('https://example.web.app', t), `https://example.web.app/c/${t}`);
  assert.equal(buildQrUrl('https://example.web.app///', t), `https://example.web.app/c/${t}`);
});
