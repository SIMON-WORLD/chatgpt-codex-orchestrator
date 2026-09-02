import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';

function textOf(res) { const t = res && res.content && res.content.find((c) => c.type === 'text'); return t ? t.text : ''; }

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm4r1-'));
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const srv = await startMcpServer({ workspaceRegistry: registry, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  return { srv, client, root };
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const t = textOf(res);
  assert.ok(t, name + ' should return text content');
  return JSON.parse(t);
}

test('MCP surface exposes route_decide / governance_transition / governance_record_result / governance_status', async (t) => {
  const { srv, client } = await setup();
  t.after(() => client.close());
  t.after(() => srv.close());
  const tools = await client.listTools();
  const names = tools.tools.map((x) => x.name);
  assert.ok(names.includes('route_decide'));
  assert.ok(names.includes('governance_transition'));
  assert.ok(names.includes('governance_record_result'));
  assert.ok(names.includes('governance_status'));
});

test('route_decide is read-only and returns the deterministic route', async (t) => {
  const { srv, client } = await setup();
  t.after(() => client.close());
  t.after(() => srv.close());

  assert.equal((await call(client, 'route_decide', { requiresNative: true, requiresLocal: false })).route, 'CHATGPT_NATIVE');
  assert.equal((await call(client, 'route_decide', { requiresLocal: true, readOnly: true, mutationRequired: false })).route, 'CHATGPT_DIRECT_LOCAL');
  assert.equal((await call(client, 'route_decide', { requiresLocal: true, mutationRequired: true, boundedChange: true, exactChangeKnown: true })).route, 'CHATGPT_DIRECT_LOCAL');
  assert.equal((await call(client, 'route_decide', { requiresLocal: true, mutationRequired: true, multiFile: true })).route, 'CODEX_DELEGATE');
  assert.equal((await call(client, 'route_decide', { requiresLocal: true, mutationRequired: true, unknownRootCause: true })).route, 'CODEX_DELEGATE');
  const hybrid = await call(client, 'route_decide', { requiresNative: true, requiresLocal: true, mutationRequired: true, boundedChange: true, exactChangeKnown: true });
  assert.equal(hybrid.route, 'HYBRID');
  assert.equal(hybrid.localRoute, 'CHATGPT_DIRECT_LOCAL');
  assert.notEqual(hybrid.mutationOwnerExpected, 'hybrid');
});

test('full MCP lifecycle: PLAN -> TASK s1 -> RESULT s1 -> TASK s2 -> RESULT s2 -> DONE', async (t) => {
  const { srv, client } = await setup();
  t.after(() => client.close());
  t.after(() => srv.close());

  await call(client, 'governance_transition', { taskId: 't1', control: 'PLAN' });
  const task1 = await call(client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }], route: 'CODEX_DELEGATE' });
  assert.equal(task1.nextAction, 'execute');
  assert.equal(task1.machineGate, 'pending');

  const res1 = await call(client, 'governance_record_result', { taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  assert.equal(res1.machineGate, 'pass');

  const task2 = await call(client, 'governance_transition', { taskId: 't1', stepId: 's2', control: 'TASK', acceptance: [{ id: 'a2', required: true }] });
  assert.equal(task2.ok, true);
  const st = await call(client, 'governance_status', {});
  assert.equal(st.previousStepId, 's1');
  assert.equal(st.currentStepId, 's2');
  assert.ok(st.acceptedSteps.includes('s1'));
  assert.equal(st.steps.s1.brainAcceptance, 'accepted');
  assert.equal(st.steps.s2.machineGate, 'pending');

  await call(client, 'governance_record_result', { taskId: 't1', stepId: 's2', executorStatus: 'success', evidence: [{ acceptanceId: 'a2', status: 'pass' }] });
  const done = await call(client, 'governance_transition', { taskId: 't1', stepId: 's2', control: 'DONE' });
  assert.equal(done.blocked, false);
  assert.equal((await call(client, 'governance_status', {})).control, 'DONE');
});

test('RESULT failure -> DONE blocked', async (t) => {
  const { srv, client } = await setup();
  t.after(() => client.close());
  t.after(() => srv.close());

  await call(client, 'governance_transition', { taskId: 't1', control: 'PLAN' });
  await call(client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  await call(client, 'governance_record_result', { taskId: 't1', stepId: 's1', executorStatus: 'failure', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  const done = await call(client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'DONE' });
  assert.equal(done.blocked, true);
  assert.equal(done.nextAction, 'blocked_done');
});

test('REVISE preserves step identity through MCP', async (t) => {
  const { srv, client } = await setup();
  t.after(() => client.close());
  t.after(() => srv.close());

  await call(client, 'governance_transition', { taskId: 't1', control: 'PLAN' });
  await call(client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  const rev = await call(client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'REVISE', reviseDelta: { invalidate: ['a1'] } });
  assert.equal(rev.ok, true);
  const st = await call(client, 'governance_status', {});
  assert.equal(st.currentStepId, 's1');
  assert.equal(st.steps.s1.brainAcceptance, 'revise');
});

test('publication required but no readback result -> DONE blocked', async (t) => {
  const { srv, client } = await setup();
  t.after(() => client.close());
  t.after(() => srv.close());

  await call(client, 'governance_transition', { taskId: 't1', control: 'PLAN' });
  await call(client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  await call(client, 'governance_record_result', { taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  const pub = await call(client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'PUBLISH' });
  assert.equal(pub.ok, true);
  assert.equal((await call(client, 'governance_status', {})).publicationRequired, true);
  const done = await call(client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'DONE' });
  assert.equal(done.blocked, true);
  assert.equal(done.nextAction, 'blocked_done_publication');
});

test('contradictory router facts -> isError through MCP', async (t) => {
  const { srv, client } = await setup();
  t.after(() => client.close());
  t.after(() => srv.close());

  const res = await client.callTool({ name: 'route_decide', arguments: { requiresLocal: true, readOnly: true, mutationRequired: true } });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /readOnly and mutationRequired are contradictory/);
});
