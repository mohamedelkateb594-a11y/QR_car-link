'use strict';
const { ServiceError } = require('../errors');
const { sanitizeText } = require('../core/policy');
const { generateToken, hashToken, buildQrUrl } = require('../core/token');

/**
 * Car + QR management (owner only; caller must already have verified a non-anonymous sign-in).
 * deps: { store, clock, newId, baseUrl }
 *
 * DESIGN NOTE (reverses a Phase 1 handoff rule): the plaintext token is ALSO kept on the car doc so the
 * owner app can re-display/re-print the QR. Lookup still goes through qrTokens/{sha256}. The token is printed
 * on the windshield, so it is never secret from anyone who can see the car; its job is unguessability.
 */
function createCarService({ store, clock, newId, baseUrl }) {
  const need = () => { if (!baseUrl) throw new ServiceError('misconfigured_base_url'); };

  async function createCar(input, ctx) {
    need();
    const label = sanitizeText(input && input.label, 60);
    const color = sanitizeText(input && input.color, 30);
    if (!label.ok) throw new ServiceError(label.error);
    if (!color.ok) throw new ServiceError(color.error);
    const now = clock.now();
    const token = generateToken();
    const hash = hashToken(token);
    const car = {
      id: newId(), ownerUid: ctx.uid, label: label.value, color: color.value,
      acceptingRequests: true, qrToken: token, qrTokenHash: hash, createdAt: now,
    };
    await store.createCar(car, { hash, carId: car.id, ownerUid: ctx.uid, active: true, createdAt: now });
    return { carId: car.id, qrUrl: buildQrUrl(baseUrl, token) };
  }

  async function rotateQr({ carId }, ctx) {
    need();
    const car = typeof carId === 'string' ? await store.getCar(carId) : null;
    if (!car || car.ownerUid !== ctx.uid) throw new ServiceError('not_found');
    const token = generateToken();
    const newHash = hashToken(token);
    await store.rotateQr({ carId, ownerUid: ctx.uid, oldHash: car.qrTokenHash, newHash, newToken: token, now: clock.now() });
    return { carId, qrUrl: buildQrUrl(baseUrl, token) };
  }

  return { createCar, rotateQr };
}
module.exports = { createCarService };
