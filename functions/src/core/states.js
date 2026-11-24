'use strict';
/**
 * Request lifecycle (spec section 8). Pure logic - no Firebase imports so it is unit-testable.
 * The same rules MUST be enforced server-side in Cloud Functions (Phase 2).
 */
const STATUS = Object.freeze({
  CREATED: 'created',
  SENT: 'sent',
  DELIVERED: 'delivered',
  VIEWED: 'viewed',
  IN_PROGRESS: 'in_progress',
  CLOSED_ON_THE_WAY: 'closed_on_the_way',
  CLOSED_RESOLVED: 'closed_resolved',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

// Non-terminal states, in forward-only order.
const ACTIVE_ORDER = [STATUS.CREATED, STATUS.SENT, STATUS.DELIVERED, STATUS.VIEWED, STATUS.IN_PROGRESS];
const TERMINAL = new Set([STATUS.CLOSED_ON_THE_WAY, STATUS.CLOSED_RESOLVED, STATUS.CANCELLED, STATUS.EXPIRED]);

// Who is allowed to move a request INTO each state.
const ACTOR_FOR = Object.freeze({
  [STATUS.SENT]: 'system',
  [STATUS.DELIVERED]: 'system',
  [STATUS.VIEWED]: 'owner',
  [STATUS.IN_PROGRESS]: 'owner',
  [STATUS.CLOSED_ON_THE_WAY]: 'owner',
  [STATUS.CLOSED_RESOLVED]: 'owner',
  [STATUS.CANCELLED]: 'visitor',
  [STATUS.EXPIRED]: 'system',
});

const isTerminal = (s) => TERMINAL.has(s);
const isKnown = (s) => ACTIVE_ORDER.includes(s) || TERMINAL.has(s);

function canTransition(from, to, actor) {
  if (!isKnown(from) || !isKnown(to)) return false;
  if (isTerminal(from)) return false;           // closed sessions never reopen
  if (ACTOR_FOR[to] !== actor) return false;    // wrong actor for this target state
  if (isTerminal(to)) return true;              // any active state may be closed
  return ACTIVE_ORDER.indexOf(to) > ACTIVE_ORDER.indexOf(from); // forward only
}

/** Messages are allowed only while the session is open (spec 6: no messages after close). */
const canSendMessage = (status) => isKnown(status) && !isTerminal(status);

/**
 * Escalating alerts keep going only while the owner has NOT opened the request.
 * ASSUMPTION A2 (see docs/EXECUTION_PLAN.md, decision D1): "opening" = status `viewed`.
 */
const isAlertingStatus = (status) =>
  status === STATUS.CREATED || status === STATUS.SENT || status === STATUS.DELIVERED;

module.exports = { STATUS, ACTIVE_ORDER, TERMINAL, ACTOR_FOR, isTerminal, isKnown, canTransition, canSendMessage, isAlertingStatus };
