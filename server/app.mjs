import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 4000;
const DAY_MS = 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sameKey(a, b) {
  const hash = (value) => createHash('sha256').update(String(value)).digest();
  return timingSafeEqual(hash(a), hash(b));
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required.`);
  }
  if (value.length > MAX_TEXT_LENGTH) {
    throw new HttpError(400, `${field} must be ${MAX_TEXT_LENGTH} characters or fewer.`);
  }
  return value.trim();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      reject(new HttpError(415, 'Send JSON.'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request is too large.'));
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          reject(new HttpError(400, 'Send a JSON object.'));
          return;
        }
        resolve(body);
      } catch {
        reject(new HttpError(400, 'Send valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

export function createApp({ rootDir, statePath, approverKey }) {
  if (!approverKey) throw new Error('approverKey is required.');

  const orders = JSON.parse(readFileSync(join(rootDir, 'data', 'orders.json'), 'utf8'));
  const requests = JSON.parse(readFileSync(join(rootDir, 'data', 'requests.json'), 'utf8'));
  const policy = readFileSync(join(rootDir, 'policy', 'refund-policy.md'), 'utf8');
  const page = readFileSync(join(rootDir, 'public', 'index.html'));

  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { nextCase: 1, cases: [], refunds: [], outbox: [] };

  function save() {
    mkdirSync(dirname(statePath), { recursive: true });
    const temp = `${statePath}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2));
    renameSync(temp, statePath);
  }

  function refundedCents(orderId) {
    return state.refunds
      .filter((refund) => refund.orderId === orderId)
      .reduce((sum, refund) => sum + refund.amountCents, 0);
  }

  function orderView(order) {
    const itemsCents = order.items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);
    const totalCents = itemsCents + order.shippingCents;
    const refunded = refundedCents(order.id);
    const { deliveredDaysAgo, ...rest } = order;
    return {
      ...rest,
      itemsCents,
      totalCents,
      refundedCents: refunded,
      refundableCents: totalCents - refunded,
      daysSinceDelivery: deliveredDaysAgo,
      deliveredOn: new Date(Date.now() - deliveredDaysAgo * DAY_MS).toISOString().slice(0, 10),
    };
  }

  function findOrder(id) {
    const order = orders.find((candidate) => candidate.id === id);
    if (!order) throw new HttpError(404, `No order called ${id}.`);
    return order;
  }

  function findCase(id) {
    const found = state.cases.find((candidate) => candidate.id === id);
    if (!found) throw new HttpError(404, `No case called ${id}.`);
    return found;
  }

  function caseView(item) {
    return { ...item, order: orderView(findOrder(item.orderId)) };
  }

  function log(item, actor, event) {
    item.history.push({ at: new Date().toISOString(), actor, event });
  }

  function validateOutcome(item, decision, amountCents) {
    if (decision !== 'refund' && decision !== 'deny') {
      throw new HttpError(400, 'decision must be "refund" or "deny".');
    }
    if (decision === 'deny') {
      if (amountCents !== 0) throw new HttpError(400, 'A denial must have an amount of 0.');
      return;
    }
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new HttpError(400, 'A refund needs an amount above 0.');
    }
    const { refundableCents } = orderView(findOrder(item.orderId));
    if (amountCents > refundableCents) {
      const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
      throw new HttpError(
        400,
        `A refund of ${dollars(amountCents)} is more than the ${dollars(refundableCents)} left on this order.`,
      );
    }
  }

  const routes = [
    ['GET', /^\/api\/requests$/, () => requests],
    ['GET', /^\/api\/policy$/, () => ({ policy })],
    ['GET', /^\/api\/orders\/([\w-]+)$/, ({ params }) => orderView(findOrder(params[0]))],
    ['GET', /^\/api\/cases$/, () => state.cases.map(caseView)],
    ['GET', /^\/api\/cases\/([\w-]+)$/, ({ params }) => caseView(findCase(params[0]))],

    ['POST', /^\/api\/cases$/, ({ body }) => {
      const request = requests.find((candidate) => candidate.id === body.requestId);
      if (!request) throw new HttpError(404, `No request called ${body.requestId}.`);
      const existing = state.cases.find((candidate) => candidate.requestId === request.id);
      if (existing) return caseView(existing);

      const order = findOrder(request.orderId);
      const item = {
        id: `CASE-${state.nextCase++}`,
        requestId: request.id,
        orderId: order.id,
        customerMessage: request.message,
        status: 'checking',
        facts: null,
        recommendation: null,
        signOff: null,
        sent: null,
        history: [],
      };
      log(item, 'agent', 'Case opened');
      state.cases.push(item);
      save();
      return { status: 201, data: caseView(item) };
    }],

    ['POST', /^\/api\/cases\/([\w-]+)\/facts$/, ({ params, body }) => {
      const item = findCase(params[0]);
      if (item.status !== 'checking') {
        throw new HttpError(409, `${item.id} has moved past the checking stage.`);
      }
      item.facts = requireText(body.summary, 'summary');
      log(item, 'agent', 'Facts recorded');
      save();
      return caseView(item);
    }],

    ['POST', /^\/api\/cases\/([\w-]+)\/recommendation$/, ({ params, body }) => {
      const item = findCase(params[0]);
      if (!item.facts) throw new HttpError(409, `Record the facts for ${item.id} first.`);
      if (item.status !== 'checking' && item.status !== 'awaiting_sign_off') {
        throw new HttpError(409, `${item.id} has already been signed off.`);
      }
      validateOutcome(item, body.decision, body.amountCents);
      item.recommendation = {
        decision: body.decision,
        amountCents: body.amountCents,
        reason: requireText(body.reason, 'reason'),
        customerReply: requireText(body.customerReply, 'customerReply'),
      };
      item.status = 'awaiting_sign_off';
      log(item, 'agent', `Recommended: ${body.decision}`);
      save();
      return caseView(item);
    }],

    ['POST', /^\/api\/cases\/([\w-]+)\/sign-off$/, ({ params, body, req }) => {
      const key = req.headers['x-approver-key'];
      if (!key || !sameKey(key, approverKey)) {
        throw new HttpError(401, 'Only a person with the approver link can sign off.');
      }
      const item = findCase(params[0]);
      if (item.status !== 'awaiting_sign_off') {
        throw new HttpError(409, `${item.id} isn't waiting for sign-off.`);
      }
      validateOutcome(item, body.decision, body.amountCents);
      const customerReply = requireText(body.customerReply, 'customerReply');
      const approver = requireText(body.approver, 'approver');
      const recommended = item.recommendation;
      const changed =
        body.decision !== recommended.decision ||
        body.amountCents !== recommended.amountCents ||
        customerReply !== recommended.customerReply;

      item.signOff = {
        decision: body.decision,
        amountCents: body.amountCents,
        customerReply,
        approver,
        note: typeof body.note === 'string' ? body.note.trim().slice(0, MAX_TEXT_LENGTH) : '',
        changed,
        at: new Date().toISOString(),
      };
      item.status = 'signed_off';
      log(item, approver, changed ? 'Signed off with changes' : 'Signed off');
      save();
      return caseView(item);
    }],

    ['POST', /^\/api\/cases\/([\w-]+)\/send$/, ({ params }) => {
      const item = findCase(params[0]);
      if (item.status === 'completed') {
        throw new HttpError(409, `${item.id} has already been sent. Nothing was sent again.`);
      }
      if (item.status !== 'signed_off') {
        throw new HttpError(403, `Refused: nobody has signed off on ${item.id}. Nothing was sent.`);
      }
      const { decision, amountCents, customerReply } = item.signOff;
      validateOutcome(item, decision, amountCents);

      const at = new Date().toISOString();
      if (decision === 'refund') {
        state.refunds.push({ caseId: item.id, orderId: item.orderId, amountCents, at });
      }
      state.outbox.push({ caseId: item.id, orderId: item.orderId, message: customerReply, at });
      item.sent = { refundedCents: amountCents, message: customerReply, at };
      item.status = 'completed';
      log(item, 'agent', decision === 'refund' ? 'Refund issued and reply sent' : 'Reply sent');
      save();
      return caseView(item);
    }],
  ];

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      });
      res.end(page);
      return;
    }

    for (const [method, pattern, handler] of routes) {
      const match = req.method === method && pathname.match(pattern);
      if (!match) continue;
      const body = method === 'POST' ? await readBody(req) : {};
      const result = handler({ req, body, params: match.slice(1) });
      const hasStatus = result && !Array.isArray(result) && 'status' in result && 'data' in result;
      res.writeHead(hasStatus ? result.status : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(hasStatus ? result.data : result));
      return;
    }
    throw new HttpError(404, 'Not found.');
  }

  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong.' : error.message }));
    });
  });
}
