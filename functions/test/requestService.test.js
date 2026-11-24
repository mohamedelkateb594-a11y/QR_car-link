'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, OWNER, VISITOR } = require('./helpers/world');

const MIN = 60 * 1000;
const create = (w, extra = {}, ctx = VISITOR) => w.reqs.createRequest({ token: w.token, reason: 'move_car', message: 'من فضلك', ...extra }, ctx);

test('createRequest: stores request, notifies the right owner, schedules 30/60/90s alerts + 15min expiry', async () => {
  const w = await makeWorld();
  const { requestId, existing } = await create(w);
  assert.equal(existing, false);
  const r = w.store.db.requests.get(requestId);
  assert.equal(r.ownerUid, OWNER.uid);
  assert.deepEqual(r.participants.sort(), ['owner1', 'visitor1']);
  assert.equal(r.status, 'sent');            // push accepted -> sent (not "viewed")
  assert.equal(r.open, true);
  assert.equal(r.expiresAtMs, r.createdAt + 15 * MIN);
  assert.deepEqual(w.push.sent.map((p) => [p.ownerUid, p.type, p.attempt]), [['owner1', 'new_request', 0]]);
  assert.deepEqual(w.scheduler.tasks.map((t) => [t.payload.kind, t.payload.index, t.delayMs]),
    [['alert', 1, 30000], ['alert', 2, 60000], ['alert', 3, 90000], ['expire', undefined, 15 * MIN]]);
  // no phone numbers / personal data on the request doc
  assert.equal(JSON.stringify(r).match(/phone|tel|mobile/i), null);
});

test('createRequest: owner alert settings change the schedule', async () => {
  const w = await makeWorld();
  w.store.db.users.set('owner1', { repeatEnabled: false });
  await create(w);
  assert.deepEqual(w.scheduler.tasks.map((t) => t.payload.kind), ['expire']);
});

test('createRequest: push failure does not fail the request; a later alert delivers and flips to sent', async () => {
  const w = await makeWorld();
  w.push.failFor.add('all');
  const { requestId } = await create(w);
  assert.equal(w.store.db.requests.get(requestId).status, 'created');
  w.push.failFor.clear();
  w.clock.advance(30000);
  assert.deepEqual(await w.reqs.fireAlert(requestId, 1), { fired: true });
  assert.equal(w.store.db.requests.get(requestId).status, 'sent');
});

test('createRequest: bad / unknown / malformed token, bad reason, long message are rejected and create nothing', async () => {
  const w = await makeWorld();
  const cases = [
    [{ token: 'short', reason: 'move_car' }, 'invalid_link'],
    [{ token: 'A'.repeat(32), reason: 'move_car' }, 'invalid_link'],
    [{ token: w.token, reason: 'hack' }, 'invalid_reason'],
    [{ token: w.token, reason: 'other', message: 'x'.repeat(501) }, 'message_too_long'],
    [null, 'invalid_payload'],
  ];
  for (const [input, code] of cases) await assert.rejects(w.reqs.createRequest(input, VISITOR), { code });
  assert.equal(w.store.db.requests.size, 0);
  assert.equal(w.push.sent.length, 0);
});

test('createRequest: paused car does not accept requests', async () => {
  const w = await makeWorld();
  w.store.db.cars.get(w.carId).acceptingRequests = false;
  await assert.rejects(create(w), { code: 'not_accepting' });
  assert.equal(w.store.db.requests.size, 0);
});

test('createRequest: same visitor repeating while open gets the same request, no second push or rate event', async () => {
  const w = await makeWorld();
  const a = await create(w);
  const b = await create(w);
  assert.equal(b.requestId, a.requestId);
  assert.equal(b.existing, true);
  assert.equal(w.store.db.requests.size, 1);
  assert.equal(w.push.sent.length, 1);
  assert.equal(w.store.db.rate.length, 1);
});

test('createRequest: after an expired request, the same visitor can create a new one', async () => {
  const w = await makeWorld();
  const a = await create(w);
  w.clock.advance(15 * MIN);
  const b = await create(w);
  assert.notEqual(b.requestId, a.requestId);
  assert.equal(w.store.db.requests.get(a.requestId).status, 'expired');
});

test('rate limit per visitor: blocked with retryAfterMs, nothing created while blocked, allowed again later', async () => {
  const w = await makeWorld();
  for (let i = 0; i < 3; i++) {
    const { requestId } = await create(w);
    await w.reqs.cancelRequest({ requestId }, VISITOR);
    w.clock.advance(1000);
  }
  const before = w.store.db.requests.size;
  await assert.rejects(create(w), (e) => e.code === 'rate_limited' && e.retryAfterMs > 0);
  assert.equal(w.store.db.requests.size, before);
  w.clock.advance(10 * MIN);
  assert.ok((await create(w)).requestId);
});

test('rate limit per car: many different visitors cannot flood one car', async () => {
  const w = await makeWorld();
  for (let i = 0; i < 10; i++) await create(w, {}, { uid: `v${i}`, ipHash: `ip${i}` });
  await assert.rejects(create(w, {}, { uid: 'v99', ipHash: 'ip99' }), { code: 'rate_limited' });
});

test('rate limit per IP hash: a visitor who resets their anonymous uid is still limited', async () => {
  const w = await makeWorld();
  for (let i = 0; i < 3; i++) { const r = await create(w, {}, { uid: `fresh${i}`, ipHash: 'same-ip' }); await w.reqs.cancelRequest({ requestId: r.requestId }, { uid: `fresh${i}` }); }
  await assert.rejects(create(w, {}, { uid: 'fresh-new', ipHash: 'same-ip' }), { code: 'rate_limited' });
});

test('sendMessage: both sides can chat; only visitor messages push the owner', async () => {
  const w = await makeWorld();
  const { requestId } = await create(w);
  w.push.sent.length = 0;
  await w.reqs.sendMessage({ requestId, text: 'أنا تحت' }, VISITOR);
  await w.reqs.sendMessage({ requestId, text: 'نازل حالًا' }, OWNER);
  const msgs = w.store.db.messages.get(requestId);
  assert.deepEqual(msgs.map((m) => [m.from, m.text]), [['visitor', 'أنا تحت'], ['owner', 'نازل حالًا']]);
  assert.deepEqual(msgs[0].participants.sort(), ['owner1', 'visitor1']);
  assert.deepEqual(w.push.sent.map((p) => p.type), ['message']);
});

test('sendMessage: strangers get not_found (no existence oracle); empty and over-long text rejected', async () => {
  const w = await makeWorld();
  const { requestId } = await create(w);
  await assert.rejects(w.reqs.sendMessage({ requestId, text: 'hi' }, { uid: 'intruder' }), { code: 'not_found' });
  await assert.rejects(w.reqs.sendMessage({ requestId: 'does-not-exist', text: 'hi' }, VISITOR), { code: 'not_found' });
  await assert.rejects(w.reqs.sendMessage({ requestId, text: '  ' }, VISITOR), { code: 'empty_message' });
  await assert.rejects(w.reqs.sendMessage({ requestId, text: 'x'.repeat(501) }, VISITOR), { code: 'message_too_long' });
  assert.equal(w.store.db.messages.get(requestId).length, 0);
});

test('closeRequest on_the_way: closes atomically with optional message; no more messages, no re-close, no reopen', async () => {
  const w = await makeWorld();
  const { requestId } = await create(w);
  await w.reqs.markViewed({ requestId }, OWNER);
  assert.deepEqual(await w.reqs.closeRequest({ requestId, action: 'on_the_way', message: 'نازل خلال دقيقتين' }, OWNER), { status: 'closed_on_the_way' });
  const r = w.store.db.requests.get(requestId);
  assert.equal(r.status, 'closed_on_the_way');
  assert.equal(r.open, false);
  assert.ok(r.closedAt);
  assert.deepEqual(w.store.db.messages.get(requestId).map((m) => [m.from, m.kind, m.text]), [['owner', 'closing', 'نازل خلال دقيقتين']]);
  await assert.rejects(w.reqs.sendMessage({ requestId, text: 'hello' }, VISITOR), { code: 'session_closed' });
  await assert.rejects(w.reqs.sendMessage({ requestId, text: 'hello' }, OWNER), { code: 'session_closed' });
  await assert.rejects(w.reqs.closeRequest({ requestId, action: 'resolved' }, OWNER), { code: 'session_closed' });
  await assert.rejects(w.reqs.cancelRequest({ requestId }, VISITOR), { code: 'session_closed' });
  assert.deepEqual(await w.reqs.markViewed({ requestId }, OWNER), { changed: false, status: 'closed_on_the_way' });
  assert.equal(w.store.db.requests.get(requestId).status, 'closed_on_the_way');
  assert.equal(w.store.db.messages.get(requestId).length, 1);
});

test('closeRequest resolved without message adds no message; invalid action / long message rejected; only owner may close', async () => {
  const w = await makeWorld();
  const { requestId } = await create(w);
  await assert.rejects(w.reqs.closeRequest({ requestId, action: 'nope' }, OWNER), { code: 'invalid_action' });
  await assert.rejects(w.reqs.closeRequest({ requestId, action: 'resolved', message: 'x'.repeat(501) }, OWNER), { code: 'message_too_long' });
  await assert.rejects(w.reqs.closeRequest({ requestId, action: 'resolved' }, VISITOR), { code: 'forbidden' });
  await assert.rejects(w.reqs.closeRequest({ requestId, action: 'resolved' }, { uid: 'intruder' }), { code: 'not_found' });
  assert.equal(w.store.db.requests.get(requestId).status, 'sent');
  await w.reqs.closeRequest({ requestId, action: 'resolved' }, OWNER);
  assert.equal(w.store.db.requests.get(requestId).status, 'closed_resolved');
  assert.equal(w.store.db.messages.get(requestId).length, 0);
});

test('cancelRequest: visitor cancels; owner cannot; closed afterwards', async () => {
  const w = await makeWorld();
  const { requestId } = await create(w);
  await assert.rejects(w.reqs.cancelRequest({ requestId }, OWNER), { code: 'forbidden' });
  await w.reqs.cancelRequest({ requestId }, VISITOR);
  const r = w.store.db.requests.get(requestId);
  assert.deepEqual([r.status, r.open], ['cancelled', false]);
  await assert.rejects(w.reqs.sendMessage({ requestId, text: 'x' }, VISITOR), { code: 'session_closed' });
});

test('markViewed: idempotent; only the owner may call it', async () => {
  const w = await makeWorld();
  const { requestId } = await create(w);
  await assert.rejects(w.reqs.markViewed({ requestId }, VISITOR), { code: 'forbidden' });
  assert.equal((await w.reqs.markViewed({ requestId }, OWNER)).changed, true);
  const viewedAt = w.store.db.requests.get(requestId).viewedAt;
  w.clock.advance(5000);
  assert.deepEqual(await w.reqs.markViewed({ requestId }, OWNER), { changed: false, status: 'viewed' });
  assert.equal(w.store.db.requests.get(requestId).viewedAt, viewedAt);
});

test('alerts stop after view, close, cancel and expiry (acceptance criterion 10)', async () => {
  const mk = async (act) => {
    const w = await makeWorld();
    const { requestId } = await create(w);
    await act(w, requestId);
    w.push.sent.length = 0;
    w.clock.advance(30000);
    const res = await w.reqs.fireAlert(requestId, 1);
    return { res, pushes: w.push.sent.length };
  };
  const stopped = { res: { fired: false }, pushes: 0 };
  assert.deepEqual(await mk((w, id) => w.reqs.markViewed({ requestId: id }, OWNER)), stopped);
  assert.deepEqual(await mk((w, id) => w.reqs.closeRequest({ requestId: id, action: 'resolved' }, OWNER)), stopped);
  assert.deepEqual(await mk((w, id) => w.reqs.cancelRequest({ requestId: id }, VISITOR)), stopped);
  assert.deepEqual(await mk((w) => w.clock.advance(15 * MIN)), stopped);   // expiry time reached, even before the sweep runs
  const live = await mk(() => {});
  assert.deepEqual(live, { res: { fired: true }, pushes: 1 });             // control: an untouched request still alerts
});

test('expiry runs server-side: not early, then expired; late messages rejected; alerts and re-expiry are no-ops', async () => {
  const w = await makeWorld();
  const { requestId } = await create(w);
  w.clock.advance(15 * MIN - 1);
  assert.deepEqual(await w.reqs.expireRequest(requestId), { changed: false, reason: 'not_due' });
  assert.equal(w.store.db.requests.get(requestId).status, 'sent');
  w.clock.advance(1);
  assert.deepEqual(await w.reqs.expireRequest(requestId), { changed: true });
  assert.deepEqual(w.store.db.requests.get(requestId).open, false);
  await assert.rejects(w.reqs.sendMessage({ requestId, text: 'late' }, VISITOR), { code: 'session_closed' });
  assert.deepEqual(await w.reqs.expireRequest(requestId), { changed: false, reason: 'already_final' });
  assert.deepEqual(await w.reqs.expireRequest('missing'), { changed: false, reason: 'not_found' });
});

test('expiry does not overwrite a request the owner already closed', async () => {
  const w = await makeWorld();
  const { requestId } = await create(w);
  await w.reqs.closeRequest({ requestId, action: 'on_the_way' }, OWNER);
  w.clock.advance(20 * MIN);
  assert.deepEqual(await w.reqs.expireRequest(requestId), { changed: false, reason: 'already_final' });
  assert.equal(w.store.db.requests.get(requestId).status, 'closed_on_the_way');
});

test('sweep expires only due, still-open requests (covers lost expiry tasks)', async () => {
  const w = await makeWorld();
  const a = await create(w, {}, { uid: 'v1', ipHash: 'a' });
  const b = await create(w, {}, { uid: 'v2', ipHash: 'b' });
  await w.reqs.closeRequest({ requestId: b.requestId, action: 'resolved' }, OWNER);
  w.clock.advance(10 * MIN);
  const c = await create(w, {}, { uid: 'v3', ipHash: 'c' });   // not yet due when the sweep runs
  w.clock.advance(5 * MIN);
  assert.deepEqual(await w.reqs.sweepExpired(), { checked: 1, expired: 1 });
  const st = (id) => w.store.db.requests.get(id).status;
  assert.deepEqual([st(a.requestId), st(b.requestId), st(c.requestId)], ['expired', 'closed_resolved', 'sent']);
});
