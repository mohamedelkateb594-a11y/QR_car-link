'use strict';
const { createMemoryStore, createClock, createFakePush, createFakeScheduler } = require('./fakes');
const { createCarService } = require('../../src/services/carService');
const { createRequestService } = require('../../src/services/requestService');
const { DEFAULT_CONFIG } = require('../../src/core/policy');

const OWNER = { uid: 'owner1' };
const VISITOR = { uid: 'visitor1', ipHash: 'ip1' };

async function makeWorld(over = {}) {
  let n = 0;
  const store = createMemoryStore();
  const clock = createClock();
  const push = createFakePush();
  const scheduler = createFakeScheduler();
  const newId = () => `id${++n}`;
  const logger = { warn() {} };
  const cars = createCarService({ store, clock, newId, baseUrl: 'https://qr.example.test' });
  const reqs = createRequestService({ store, push, scheduler, clock, newId, logger, config: { ...DEFAULT_CONFIG, ...over } });
  const { carId, qrUrl } = await cars.createCar({ label: 'Car', color: 'red' }, OWNER);
  const token = qrUrl.split('/c/')[1];
  return { store, clock, push, scheduler, cars, reqs, carId, token, qrUrl };
}
module.exports = { makeWorld, OWNER, VISITOR };
