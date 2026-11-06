import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const approverKey = 'test-approver-key';
let tempDir;
let statePath;
let server;
let base;

function start() {
  return new Promise((resolve) => {
    server = createApp({ rootDir, statePath, approverKey });
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
}

async function post(path, body, headers = {}) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(path) {
  const response = await fetch(base + path);
  return { status: response.status, body: await response.json() };
}

const asApprover = { 'X-Approver-Key': approverKey };
const refund = { decision: 'refund', amountCents: 3200, reason: 'Section 1.', customerReply: 'Refund on its way.' };
const signOff = { decision: 'refund', amountCents: 3200, customerReply: 'Refund on its way.', approver: 'Maya' };

async function caseAwaitingSignOff(requestId = 'REQ-1001') {
  const { body: opened } = await post('/api/cases', { requestId });
  await post(`/api/cases/${opened.id}/facts`, { summary: 'Unused tote bag, delivered 6 days ago.' });
  await post(`/api/cases/${opened.id}/recommendation`, refund);
  return opened.id;
}

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'backroom-test-'));
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  if (server) await stop();
  statePath = join(mkdtempSync(join(tempDir, 'run-')), 'state.json');
  await start();
});

after(async () => {
  await stop();
});

test('a refund is refused until a person signs off', async () => {
  const id = await caseAwaitingSignOff();
  const refused = await post(`/api/cases/${id}/send`, {});
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /nobody has signed off/);

  const { body } = await get(`/api/cases/${id}`);
  assert.equal(body.sent, null);
  assert.equal(body.order.refundedCents, 0);
});

test('signing off needs the approver key', async () => {
  const id = await caseAwaitingSignOff();
  assert.equal((await post(`/api/cases/${id}/sign-off`, signOff)).status, 401);
  assert.equal(
    (await post(`/api/cases/${id}/sign-off`, signOff, { 'X-Approver-Key': 'wrong' })).status,
    401,
  );
  assert.equal((await get(`/api/cases/${id}`)).body.status, 'awaiting_sign_off');
});

test('a signed-off refund goes through once', async () => {
  const id = await caseAwaitingSignOff();
  assert.equal((await post(`/api/cases/${id}/sign-off`, signOff, asApprover)).status, 200);

  const sent = await post(`/api/cases/${id}/send`, {});
  assert.equal(sent.status, 200);
  assert.equal(sent.body.status, 'completed');
  assert.equal(sent.body.order.refundedCents, 3200);

  assert.equal((await post(`/api/cases/${id}/send`, {})).status, 409);
  assert.equal((await get(`/api/orders/ORD-1001`)).body.refundedCents, 3200);
});

test('the person can change the amount and reply', async () => {
  const id = await caseAwaitingSignOff();
  const changed = { ...signOff, amountCents: 1000, customerReply: 'Partial refund.' };
  const signed = await post(`/api/cases/${id}/sign-off`, changed, asApprover);
  assert.equal(signed.body.signOff.changed, true);

  const sent = await post(`/api/cases/${id}/send`, {});
  assert.equal(sent.body.sent.refundedCents, 1000);
  assert.equal(sent.body.sent.message, 'Partial refund.');
});

test('the person can overturn a refund into a denial', async () => {
  const id = await caseAwaitingSignOff();
  const denied = { decision: 'deny', amountCents: 0, customerReply: 'Sorry, no refund.', approver: 'Maya' };
  await post(`/api/cases/${id}/sign-off`, denied, asApprover);

  const sent = await post(`/api/cases/${id}/send`, {});
  assert.equal(sent.status, 200);
  assert.equal(sent.body.order.refundedCents, 0);
  assert.equal(sent.body.sent.message, 'Sorry, no refund.');
});

test('a refund can\'t be more than the order total', async () => {
  const { body: opened } = await post('/api/cases', { requestId: 'REQ-1005' });
  await post(`/api/cases/${opened.id}/facts`, { summary: 'Wallet.' });
  const tooMuch = await post(`/api/cases/${opened.id}/recommendation`, {
    ...refund,
    amountCents: 50000,
  });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.error, /\$500\.00 is more than the \$65\.00 left/);
  assert.equal((await get(`/api/cases/${opened.id}`)).body.status, 'checking');
});

test('invalid amounts are rejected', async () => {
  const { body: opened } = await post('/api/cases', { requestId: 'REQ-1001' });
  await post(`/api/cases/${opened.id}/facts`, { summary: 'Tote bag.' });
  const path = `/api/cases/${opened.id}/recommendation`;
  for (const amountCents of [0, -100, 10.5, '3200', null]) {
    assert.equal((await post(path, { ...refund, amountCents })).status, 400, `amount ${amountCents}`);
  }
  assert.equal((await post(path, { ...refund, decision: 'deny', amountCents: 100 })).status, 400);
  assert.equal((await post(path, { ...refund, decision: 'maybe' })).status, 400);
});

test('facts come before a recommendation', async () => {
  const { body: opened } = await post('/api/cases', { requestId: 'REQ-1001' });
  assert.equal((await post(`/api/cases/${opened.id}/recommendation`, refund)).status, 409);
});

test('agents can\'t change a case after sign-off', async () => {
  const id = await caseAwaitingSignOff();
  await post(`/api/cases/${id}/sign-off`, signOff, asApprover);
  assert.equal(
    (await post(`/api/cases/${id}/recommendation`, { ...refund, amountCents: 3700 })).status,
    409,
  );
  assert.equal((await post(`/api/cases/${id}/facts`, { summary: 'New facts.' })).status, 409);
  assert.equal((await post(`/api/cases/${id}/sign-off`, signOff, asApprover)).status, 409);
});

test('opening the same request twice returns the same case', async () => {
  const first = await post('/api/cases', { requestId: 'REQ-1001' });
  const second = await post('/api/cases', { requestId: 'REQ-1001' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(first.body.id, second.body.id);
});

test('cases and refunds survive a restart', async () => {
  const id = await caseAwaitingSignOff();
  await post(`/api/cases/${id}/sign-off`, signOff, asApprover);
  await post(`/api/cases/${id}/send`, {});

  await stop();
  await start();

  assert.equal((await get(`/api/cases/${id}`)).body.status, 'completed');
  assert.equal((await get('/api/orders/ORD-1001')).body.refundedCents, 3200);
});

test('bad requests get clear errors', async () => {
  const notJson = await fetch(`${base}/api/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(notJson.status, 415);

  const malformed = await fetch(`${base}/api/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(malformed.status, 400);

  assert.equal((await post('/api/cases', { requestId: 'REQ-9999' })).status, 404);
  assert.equal((await get('/api/cases/CASE-404')).status, 404);
  assert.equal((await get('/api/nope')).status, 404);
});

test('order data adds up', async () => {
  const { body } = await get('/api/orders/ORD-1003');
  assert.equal(body.itemsCents, 5800);
  assert.equal(body.totalCents, 6700);
  assert.equal(body.refundableCents, 6700);
  assert.equal(body.daysSinceDelivery, 12);
  assert.match(body.deliveredOn, /^\d{4}-\d{2}-\d{2}$/);
});
