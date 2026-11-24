'use strict';
/** Tunable defaults. Spec: 15 min expiry is an initial, adjustable value (section 9). */
const DEFAULT_CONFIG = Object.freeze({
  requestTtlMs: 15 * 60 * 1000,
  maxMessageLen: 500,           // ASSUMPTION A5 - not in spec
  perVisitorLimit: { max: 3, windowMs: 10 * 60 * 1000 },  // ASSUMPTION A6 - not in spec
  perCarLimit: { max: 10, windowMs: 60 * 60 * 1000 },     // ASSUMPTION A6 - not in spec
});

const REASONS = Object.freeze(['blocked_me', 'move_car', 'lights_on', 'issue', 'other']);

// Remove control chars (keep \n \t) and bidi-override chars used for text spoofing.
const STRIP_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
const charLen = (s) => [...s].length;

function sanitizeText(input, maxLen) {
  if (input === undefined || input === null) return { ok: true, value: '' };
  if (typeof input !== 'string') return { ok: false, error: 'invalid_text' };
  const value = input.replace(STRIP_RE, '').trim();
  if (charLen(value) > maxLen) return { ok: false, error: 'message_too_long' };
  return { ok: true, value };
}

/** Validates the public "create request" payload coming from the web page. */
function validateCreateRequest(input, cfg = DEFAULT_CONFIG) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'invalid_payload' };
  if (!REASONS.includes(input.reason)) return { ok: false, error: 'invalid_reason' };
  const msg = sanitizeText(input.message, cfg.maxMessageLen);
  if (!msg.ok) return msg;
  return { ok: true, value: { reason: input.reason, message: msg.value } };
}

/** A non-empty message is required for chat messages (unlike the optional first note). */
function validateChatMessage(input, cfg = DEFAULT_CONFIG) {
  const msg = sanitizeText(input, cfg.maxMessageLen);
  if (!msg.ok) return msg;
  if (msg.value === '') return { ok: false, error: 'empty_message' };
  return { ok: true, value: msg.value };
}

const computeExpiry = (createdAtMs, cfg = DEFAULT_CONFIG) => createdAtMs + cfg.requestTtlMs;
const isExpired = (expiresAtMs, nowMs) => nowMs >= expiresAtMs;

/** Sliding-window limiter over a list of past event timestamps (ms). */
function checkRateLimit(timestamps, nowMs, { max, windowMs }) {
  const recent = timestamps.filter((t) => nowMs - t < windowMs).sort((a, b) => a - b);
  if (recent.length < max) return { allowed: true, retryAfterMs: 0 };
  const unblockAt = recent[recent.length - max] + windowMs;
  return { allowed: false, retryAfterMs: unblockAt - nowMs };
}

module.exports = { DEFAULT_CONFIG, REASONS, sanitizeText, validateCreateRequest, validateChatMessage, computeExpiry, isExpired, checkRateLimit };
