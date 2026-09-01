import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from '../../src/executor/app-server-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, '..', '..', 'test-fixtures', 'executor', 'fake-app-server.mjs');

function makeClient(extra = {}) {
  return new AppServerClient({ codexBin: process.execPath, spawnArgs: [fixture], ...extra });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}

test('client initializes fake App Server', async (t) => {
  const client = makeClient();
  t.after(() => client.close());
  const init = await client.connect();
  assert.equal(init.userAgent, 'fake-app-server');
  assert.ok(init.codexHome);
  assert.equal(client.isRunning, true);
});

test('thread/start returns a thread id', async (t) => {
  const client = makeClient();
  t.after(() => client.close());
  await client.connect();
  const res = await client.request('thread/start', {});
  assert.ok(res.thread.id);
  assert.match(res.thread.id, /^thread-/);
});

test('notification handler receives turn/started and turn/completed', async (t) => {
  const client = makeClient();
  t.after(() => client.close());
  await client.connect();
  const seen = [];
  client.onNotification((n) => seen.push(n.method));
  const tr = await client.request('thread/start', {});
  const threadId = tr.thread.id;
  const trn = await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'hi', text_elements: [] }] });
  assert.ok(trn.turn.id);
  assert.equal(await waitFor(() => seen.includes('turn/completed')), true);
  assert.ok(seen.includes('turn/started'));
});

test('server request (approval) is surfaced', async (t) => {
  const client = makeClient({ env: { ...process.env, FAKE_APP_SERVER_APPROVAL: '1' } });
  t.after(() => client.close());
  await client.connect();
  let approval = null;
  client.onServerRequest((req) => { if (req.method === 'item/commandExecution/requestApproval') approval = req; });
  const tr = await client.request('thread/start', {});
  await client.request('turn/start', { threadId: tr.thread.id, input: [{ type: 'text', text: 'hi', text_elements: [] }] });
  assert.equal(await waitFor(() => !!approval), true);
  assert.equal(approval.method, 'item/commandExecution/requestApproval');
  assert.ok(approval.id);
  assert.equal(approval.params.availableDecisions.includes('approve'), true);
});

test('process death is detected', async (t) => {
  const client = makeClient({ env: { ...process.env, FAKE_APP_SERVER_DIE_MS: '20' } });
  await client.connect();
  t.after(() => client.close());
  assert.equal(await waitFor(() => client.isRunning === false, 2000), true);
});
