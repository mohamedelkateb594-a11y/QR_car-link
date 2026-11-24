'use strict';
const { isTerminal, isAlertingStatus } = require('./states');

/**
 * Alert offsets (ms after request creation). Spec section 7 example: 0 / 30s / 60s / 90s.
 * Levels are ASSUMPTION A3 (spec asks for a configurable level but defines none).
 */
const LEVELS = Object.freeze({
  off: [0],                         // single push only
  light: [0, 60000],
  standard: [0, 30000, 60000, 90000],
});

function buildAlertSchedule(settings = {}) {
  const enabled = settings.repeatEnabled !== false;
  const level = LEVELS[settings.level] ? settings.level : 'standard';
  return enabled ? LEVELS[level].slice() : LEVELS.off.slice();
}

/**
 * Decide, at the moment a scheduled alert fires, whether it may still be sent.
 * Must be evaluated server-side against the CURRENT request state (not the state at scheduling time).
 */
function shouldFireAlert(request, nowMs) {
  if (!request || isTerminal(request.status)) return false;
  if (!isAlertingStatus(request.status)) return false;
  if (typeof request.expiresAtMs === 'number' && nowMs >= request.expiresAtMs) return false;
  return true;
}

module.exports = { LEVELS, buildAlertSchedule, shouldFireAlert };
