import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { createDurableGovernanceService } from '../../src/governance/durable.js';
import { MutationOwner } from '../../src/state/mutation-owner.js';

function textOf(res) { const t = res && res.content && res.content.find((c) => c.type === 'text'); return t ? t.text : ''; }

function fixture(prefix = 'govmcp-') {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(dataRoot, 'repo');
  fs.mkdirSync(workspace, { recursive: true });
  return { dataRoot, workspace, namespace: 'default' };
}

async function startDurableServer({ dataRoot, workspace, namespace = 'default', executor = null }) {
  const registry = new WorkspaceRegistry({ allowedRoots: [workspace] });
  const governance = createDurableGovernanceService({ dataRoot, namespace });
  const srv = await startMcpServer({ workspaceRegistry: registry, governanceService: governance, appServerExecutor: executor, host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  return { registry, governance, srv, client };
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return { res, text: textOf(res) };
}

async function closeAll(ctx) {
  try { await ctx.client.close(); } catch {}
  try { await ctx.srv.close(); } catch {}
  try { ctx.governance.close(); } catch {}
}

test('durable MCP lifecycle uses authority tokens; restart restores and takeover fences stale parent', async (t) => {
  const { dataRoot, workspace, namespace } = fixture();
  const ctx1 = await startDurableServer({ dataRoot, workspace, namespace });
  t.after(() => closeAll(ctx1));
  const tools = await ctx1.client.listTools();
  const names = tools.tools.map((x) => x.name);
  assert.ok(names.includes('governance_recover'));
  assert.ok(names.includes('governance_takeover'));

  const plan = await call(ctx1.client, 'governance_transition', { taskId: 't1', control: 'PLAN', projectKey: 'simon-world/repo', identity: 'issue-23' });
  const planJson = JSON.parse(plan.text);
  assert.equal(planJson.ok, true);
  const tokenA = planJson.authorityToken;
  assert.ok(tokenA);

  const task = await call(ctx1.client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }], route: 'CODEX_DELEGATE', authorityToken: tokenA });
  assert.equal(JSON.parse(task.text).ok, true);
  const res = await call(ctx1.client, 'governance_record_result', { taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }], authorityToken: tokenA });
  assert.equal(JSON.parse(res.text).machineGate, 'pass');
  const status1 = await call(ctx1.client, 'governance_status', {});
  assert.equal(JSON.parse(status1.text).currentStepId, 's1');

  // "restart": close server 1 + writer, reopen durable server 2 over the same root.
  await closeAll(ctx1);
  const ctx2 = await startDurableServer({ dataRoot, workspace, namespace });
  t.after(() => closeAll(ctx2));

  const rec = await call(ctx2.client, 'governance_recover', { projectKey: 'simon-world/repo', identity: 'issue-23' });
  const recJson = JSON.parse(rec.text);
  assert.equal(recJson.ok, true);
  assert.equal(recJson.taskId, 't1');

  const takeover = await call(ctx2.client, 'governance_takeover', { taskId: 't1' });
  const to = JSON.parse(takeover.text);
  assert.equal(to.ok, true);
  assert.equal(to.authority.generation, 1);
  const tokenB = to.authority.token;
  assert.ok(tokenB);
  assert.equal(to.capsule.taskId, 't1');
  assert.equal(to.capsule.capabilityFreshness.requiresRediscovery, true);
  assert.equal(to.capsule.step.machineGate, 'pass');

  const st2 = await call(ctx2.client, 'governance_status', {});
  assert.equal(JSON.parse(st2.text).currentStepId, 's1');

  // Old Parent A token is stale after takeover.
  const stale = await call(ctx2.client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'REVISE', authorityToken: tokenA });
  assert.equal(stale.res.isError, true);
  assert.match(stale.text, /stale_authority/);

  // Current token B works.
  const revise = await call(ctx2.client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'REVISE', authorityToken: tokenB });
  assert.equal(JSON.parse(revise.text).ok, true);
});

test('durable takeover does not cancel/duplicate delegated execution; only recovers via the executor', async (t) => {
  const { dataRoot, workspace, namespace } = fixture();
  const calls = [];
  const owner = new MutationOwner();
  const executor = {
    owner,
    async recover(opts) { calls.push(['recover', opts]); return { jobId: 'j1', reconciled: true }; },
    async start(opts) { calls.push(['start', opts]); return { jobId: 'jX' }; },
    async continue(opts) { calls.push(['continue', opts]); return {}; },
    async interrupt(opts) { calls.push(['interrupt', opts]); return {}; },
  };
  const ctx1 = await startDurableServer({ dataRoot, workspace, namespace, executor });
  t.after(() => closeAll(ctx1));
  await call(ctx1.client, 'workspace_open', { path: workspace });
  const plan = await call(ctx1.client, 'governance_transition', { taskId: 't1', control: 'PLAN', projectKey: 'repo/codex', identity: 'issue-codex' });
  const tokenA = JSON.parse(plan.text).authorityToken;
  await call(ctx1.client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }], route: 'CODEX_DELEGATE', authorityToken: tokenA });
  await closeAll(ctx1);

  const ctx2 = await startDurableServer({ dataRoot, workspace, namespace, executor });
  t.after(() => closeAll(ctx2));
  // The replacement runtime rebinds the workspace (no internal workspaceId relay): the
  // new session opens the same root and gets its own workspaceId for the reconcile hop.
  const ws2 = await call(ctx2.client, 'workspace_open', { path: workspace });
  const wsId2 = JSON.parse(ws2.text).workspaceId;
  const takeover = await call(ctx2.client, 'governance_takeover', { taskId: 't1', workspaceId: wsId2 });
  const to = JSON.parse(takeover.text);
  assert.equal(to.ok, true);
  assert.equal(to.execution.attempted, true);
  assert.equal(to.execution.action, 'recover');
  assert.deepEqual(calls.map((c) => c[0]), ['recover']);
  assert.equal(calls[0][1].identity, 'issue-codex');
  assert.equal(calls[0][1].taskId, 't1');
});

test('in-memory MCP server (no dataRoot) keeps the classic surface without tokens (regression)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'govmcp-mem-'));
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const srv = await startMcpServer({ workspaceRegistry: registry, host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  t.after(() => client.close());
  t.after(() => srv.close());
  const tools = await client.listTools();
  const names = tools.tools.map((x) => x.name);
  assert.ok(names.includes('governance_transition'));
  assert.ok(!names.includes('governance_recover'), 'in-memory governance has no durable recovery tool');
  assert.ok(!names.includes('governance_takeover'));
  await call(client, 'governance_transition', { taskId: 't1', control: 'PLAN' });
  const r = await call(client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  assert.equal(JSON.parse(r.text).ok, true);
});
