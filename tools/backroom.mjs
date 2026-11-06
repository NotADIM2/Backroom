#!/usr/bin/env node
import { parseArgs } from 'node:util';

const baseUrl = process.env.BACKROOM_URL ?? 'http://localhost:4600';

const usage = `Usage: node tools/backroom.mjs <command>

  requests                    List incoming refund requests
  policy                      Show the refund policy
  order <ORD-ID>              Show an order
  open <REQ-ID>               Open a case for a request
  show <CASE-ID>              Show a case
  facts <CASE-ID> --summary "..."
  recommend <CASE-ID> --decision refund|deny --amount <dollars> --reason "..." --reply "..."
  send <CASE-ID>              Issue the refund and reply, only after a person signs off`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function toCents(value) {
  if (!/^\d+(\.\d{1,2})?$/.test(value ?? '')) {
    fail('--amount must be a dollar amount, for example 32.00');
  }
  return Math.round(Number(value) * 100);
}

async function call(method, path, body) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    fail(`Can't reach Backroom at ${baseUrl}. Ask a person to start it with "npm start".`);
  }
  const data = await response.json();
  if (!response.ok) fail(`Refused (${response.status}): ${data.error}`);
  return data;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    summary: { type: 'string' },
    decision: { type: 'string' },
    amount: { type: 'string' },
    reason: { type: 'string' },
    reply: { type: 'string' },
  },
});
const [command, id] = positionals;

const needsId = new Set(['order', 'open', 'show', 'facts', 'recommend', 'send']);
if (needsId.has(command) && !id) fail(usage);

let result;
switch (command) {
  case 'requests':
    result = await call('GET', '/api/requests');
    break;
  case 'policy':
    console.log((await call('GET', '/api/policy')).policy);
    process.exit(0);
    break;
  case 'order':
    result = await call('GET', `/api/orders/${encodeURIComponent(id)}`);
    break;
  case 'open':
    result = await call('POST', '/api/cases', { requestId: id });
    break;
  case 'show':
    result = await call('GET', `/api/cases/${encodeURIComponent(id)}`);
    break;
  case 'facts':
    result = await call('POST', `/api/cases/${encodeURIComponent(id)}/facts`, {
      summary: values.summary,
    });
    break;
  case 'recommend':
    result = await call('POST', `/api/cases/${encodeURIComponent(id)}/recommendation`, {
      decision: values.decision,
      amountCents: toCents(values.amount),
      reason: values.reason,
      customerReply: values.reply,
    });
    break;
  case 'send':
    result = await call('POST', `/api/cases/${encodeURIComponent(id)}/send`, {});
    break;
  default:
    fail(usage);
}
console.log(JSON.stringify(result, null, 2));
