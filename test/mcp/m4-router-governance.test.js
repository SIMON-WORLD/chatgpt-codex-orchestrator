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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-'));
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const srv = await startMcpServer({ workspaceRegistry: registry, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  return { srv, client };
}

test('MCP surface exposes route_decide / governance_transition / governance_status', async (t) => {
  const { srv, client } = await setup();
  t.after(() => client.close());
  t.after(() => srv.close());
  const tools = await client.listTools();
  const names = tools.tools.map((x) => x.name);
  assert.ok(names.includes('route_decide'));
  assert.ok(names.includes('governance_transition'));
  assert.ok(names.includes('governance_status'));
});

test('route_decide is read-only and returns the deterministic route', async (t) => {
  const { srv, client } = await setup();
  t.after(() => client.close());
  t.after(() => srv.close());

  async function decide(facts) {
    const res = await client.callTool({ name: 'route_decide', arguments: facts });
    assert.ok(res.content, 'route_decide should return content');
    return JSON.parse(textOf(res));
  }

  assert.equal((await decide({ requiresNative: true, requiresLocal: false })).route, 'CHATGPT_NATIVE');
  assert.equal((await decide({ requiresLocal: true, readOnly: true, mutationRequired: false })).route, 'CHATGPT_DIRECT_LOCAL');
  assert.equal((await decide({ requiresLocal: true, mutationRequired: true, boundedChange: true, exactChangeKnown: true })).route, 'CHATGPT_DIRECT_LOCAL');
  assert.equal((await decide({ requiresLocal: true, mutationRequired: true, multiFile: true })).route, 'CODEX_DELEGATE');
  assert.equal((await decide({ requiresLocal: true, mutationRequired: true, unknownRootCause: true })).route, 'CODEX_DELEGATE');
  const hybrid = await decide({ requiresNative: true, requiresLocal: true, mutationRequired: true, boundedChange: true, exactChangeKnown: true });
  assert.equal(hybrid.route, 'HYBRID');
  assert.equal(hybrid.localRoute, 'CHATGPT_DIRECT_LOCAL');
  assert.notEqual(hybrid.mutationOwnerExpected, 'hybrid');
  const hybrid2 = await decide({ requiresNative: true, requiresLocal: true, mutationRequired: true, multiFile: true });
  assert.equal(hybrid2.route, 'HYBRID');
  assert.equal(hybrid2.localRoute, 'CODEX_DELEGATE');
});

test('governance state persists across MCP calls (transition -> status)', async (t) => {
  const { srv, client } = await setup();
  t.after(() => client.close());
  t.after(() => srv.close());

  const plan = JSON.parse(textOf(await client.callTool({ name: 'governance_transition', arguments: { taskId: 't1', stepId: 's1', control: 'PLAN', route: 'CHATGPT_NATIVE' } })));
  assert.equal(plan.ok, true);
  const st = JSON.parse(textOf(await client.callTool({ name: 'governance_status', arguments: {} })));
  assert.equal(st.taskId, 't1');
  assert.equal(st.stepId, 's1');
  assert.equal(st.control, 'PLAN');
  assert.equal(st.planned, true);
});

test('DONE is blocked then accepted only when governance gate satisfied', async (t) => {
  const { srv, client } = await setup();
  t.after(() => client.close());
  t.after(() => srv.close());

  // Establish task with incomplete evidence.
  const task = JSON.parse(textOf(await client.callTool({ name: 'governance_transition', arguments: { taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }] } })));
  assert.equal(task.machineGate, 'fail');

  const done1 = JSON.parse(textOf(await client.callTool({ name: 'governance_transition', arguments: { taskId: 't1', stepId: 's1', control: 'DONE' } })));
  assert.equal(done1.blocked, true);
  assert.equal(done1.nextAction, 'blocked_done');

  // Now supply complete evidence and re-issue DONE.
  const task2 = JSON.parse(textOf(await client.callTool({ name: 'governance_transition', arguments: { taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }], evidence: [{ acceptanceId: 'a1', status: 'pass' }] } })));
  assert.equal(task2.machineGate, 'pass');

  const done2 = JSON.parse(textOf(await client.callTool({ name: 'governance_transition', arguments: { taskId: 't1', stepId: 's1', control: 'DONE' } })));
  assert.equal(done2.blocked, false);
  assert.equal(done2.ok, true);
  const st = JSON.parse(textOf(await client.callTool({ name: 'governance_status', arguments: {} })));
  assert.equal(st.control, 'DONE');
  assert.equal(st.brainAcceptance, 'accepted');
});

test('REVISE keeps identity through MCP', async (t) => {
  const { srv, client } = await setup();
  t.after(() => client.close());
  t.after(() => srv.close());

  await client.callTool({ name: 'governance_transition', arguments: { taskId: 't1', stepId: 's1', control: 'PLAN' } });
  const rev = JSON.parse(textOf(await client.callTool({ name: 'governance_transition', arguments: { taskId: 't1', stepId: 's1', control: 'REVISE', reviseDelta: { invalidate: ['a1'] } } })));
  assert.equal(rev.ok, true);
  assert.equal(rev.taskId, 't1');
  assert.equal(rev.stepId, 's1');
  const st = JSON.parse(textOf(await client.callTool({ name: 'governance_status', arguments: {} })));
  assert.equal(st.taskId, 't1');
  assert.equal(st.stepId, 's1');
  assert.equal(st.control, 'REVISE');
});
