'use strict';
const crypto = require('node:crypto');

const TOKEN_BYTES = 24;                 // 192 bits of entropy -> 32 base64url chars
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

/** Random, unguessable QR token. Contains no personal data. */
const generateToken = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url');

const isWellFormedToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);

/** Only the hash is stored (qrTokens/{hash}); a DB leak does not reveal printable QR links. */
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

const buildQrUrl = (baseUrl, token) => `${String(baseUrl).replace(/\/+$/, '')}/c/${token}`;

module.exports = { TOKEN_BYTES, generateToken, isWellFormedToken, hashToken, buildQrUrl };
