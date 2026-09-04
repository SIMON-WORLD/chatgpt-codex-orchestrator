import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { AppServerExecutor } from '../../src/executor/app-server-executor.js';
import { AppServerClient } from '../../src/executor/app-server-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, '..', '..', 'test-fixtures', 'executor', 'fake-app-server.mjs');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, timeout = 2000) { const s = Date.now(); while (Date.now() - s < timeout) { if (fn()) return true; await sleep(5); } return false; }
function textOf(res) { const t = res && res.content && res.content.find((c) => c.type === 'text'); return t ? t.text : ''; }

function makeExecutor(root, { approval = '0', nonBinary = false, slowTurn = false } = {}) {
  const env = { ...process.env, FAKE_APP_SERVER_APPROVAL: approval, FAKE_APP_SERVER_STATE_DIR: root };
  if (nonBinary) env.FAKE_APP_SERVER_APPROVAL_NONBINARY = '1';
  if (slowTurn) env.FAKE_APP_SERVER_SLOW_TURN = '1';
  const client = new AppServerClient({ codexBin: process.execPath, spawnArgs: [fixture], env });
  return new AppServerExecutor({ dataRoot: root, client });
}

async function setup(root, opts) {
  const executor = makeExecutor(root, opts);
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const srv = await startMcpServer({ workspaceRegistry: registry, appServerExecutor: executor, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  return { executor, registry, srv, client };
}

test('codex_delegate MCP facade: schema-specific result, truthful approvals, workspace auth', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-'));
  const repoA = path.join(root, 'repoA'); fs.mkdirSync(repoA); fs.writeFileSync(path.join(repoA, 'a.txt'), 'hi', 'utf8');
  const repoB = path.join(root, 'repoB'); fs.mkdirSync(repoB); fs.writeFileSync(path.join(repoB, 'b.txt'), 'yo', 'utf8');

  const { executor, srv, client } = await setup(root, { approval: '1' });
  t.after(() => srv.close());
  t.after(() => executor.shutdown());
  t.after(() => client.close());

  const wsA = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repoA } })));
  const wsB = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repoB } })));
  assert.ok(wsA.workspaceId && wsB.workspaceId);

  const started = JSON.parse(textOf(await client.callTool({ name: 'codex_start', arguments: { workspaceId: wsA.workspaceId, prompt: 'do it', accessMode: 'workspace_write' } })));
  assert.ok(started.jobId && started.threadId && started.turnId);

  let approvalId = null;
  for (let i = 0; i < 500; i++) {
    const g = JSON.parse(textOf(await client.callTool({ name: 'codex_get', arguments: { workspaceId: wsA.workspaceId, jobId: started.jobId } })));
    if (g.pendingApprovals && g.pendingApprovals.length) { approvalId = g.pendingApprovals[0].approvalId; break; }
    await sleep(5);
  }
  assert.ok(approvalId, 'approval not found through codex_get');

  // Cross-workspace authorization: all four ops must fail BEFORE the App Server action.
  const byWs = (name, args) => client.callTool({ name, arguments: { ...args, workspaceId: wsB.workspaceId } });
  assert.equal((await byWs('codex_get', { jobId: started.jobId })).isError, true);
  assert.equal((await byWs('codex_continue', { jobId: started.jobId, instruction: 'x' })).isError, true);
  assert.equal((await byWs('codex_interrupt', { jobId: started.jobId })).isError, true);
  assert.equal((await byWs('codex_respond_approval', { jobId: started.jobId, approvalId, decision: 'approve' })).isError, true);

  const resp = JSON.parse(textOf(await client.callTool({ name: 'codex_respond_approval', arguments: { workspaceId: wsA.workspaceId, jobId: started.jobId, approvalId, decision: 'approve' } })));
  assert.equal(resp.ok, true);
  const afterResp = JSON.parse(textOf(await client.callTool({ name: 'codex_get', arguments: { workspaceId: wsA.workspaceId, jobId: started.jobId } })));
  assert.equal(Array.isArray(afterResp.pendingApprovals) && afterResp.pendingApprovals.length, 0);

  let got = null;
  for (let i = 0; i < 500; i++) {
    got = JSON.parse(textOf(await client.callTool({ name: 'codex_get', arguments: { workspaceId: wsA.workspaceId, jobId: started.jobId } })));
    if (got.result && got.result.includes('TASK_DONE_MARKER')) break;
    await sleep(5);
  }
  assert.equal(typeof got.workspaceRoot, 'string');
  assert.ok(got.result);
  assert.ok(got.result.includes('TASK_DONE_MARKER'));
  assert.ok(got.result.includes('ASSISTANT_OUTPUT_TEXT_MARKER'));
  for (const neg of ['USER_INPUT_MARKER', 'USER_OUTPUT_TEXT_MARKER', 'REASONING_MARKER', 'FUNCTION_CALL_MARKER', 'TOOL_OUTPUT_MARKER', 'TOOL_INPUT_MARKER']) {
    assert.equal(got.result.includes(neg), false, 'result must not contain ' + neg);
  }


  const cont = JSON.parse(textOf(await client.callTool({ name: 'codex_continue', arguments: { workspaceId: wsA.workspaceId, jobId: started.jobId, instruction: 'more' } })));
  assert.equal(cont.threadId, started.threadId);
  assert.notEqual(cont.turnId, started.turnId);

  const ir = JSON.parse(textOf(await client.callTool({ name: 'codex_interrupt', arguments: { workspaceId: wsA.workspaceId, jobId: started.jobId } })));
  assert.equal(ir.state, 'interrupted');

});

test('codex_get reports non-binary approvals truthfully (approve/deny not advertised)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nb-'));
  const repoA = path.join(root, 'repoA'); fs.mkdirSync(repoA); fs.writeFileSync(path.join(repoA, 'a.txt'), 'hi', 'utf8');
  const { executor, srv, client } = await setup(root, { nonBinary: true });
  t.after(() => srv.close());
  t.after(() => executor.shutdown());
  t.after(() => client.close());

  const wsA = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repoA } })));
  const started = JSON.parse(textOf(await client.callTool({ name: 'codex_start', arguments: { workspaceId: wsA.workspaceId, prompt: 'do it', accessMode: 'workspace_write' } })));

  let approvalId = null;
  let approvalInfo = null;
  for (let i = 0; i < 500; i++) {
    const g = JSON.parse(textOf(await client.callTool({ name: 'codex_get', arguments: { workspaceId: wsA.workspaceId, jobId: started.jobId } })));
    if (g.pendingApprovals && g.pendingApprovals.length) { approvalInfo = g.pendingApprovals[0]; approvalId = approvalInfo.approvalId; break; }
    await sleep(5);
  }
  assert.ok(approvalId);
  assert.equal(approvalInfo.method, 'item/permissions/requestApproval');
  assert.equal(approvalInfo.supportedDecisionMode, null);
  assert.equal(approvalInfo.requiresStructuredResponse, true);

  const resp = await client.callTool({ name: 'codex_respond_approval', arguments: { workspaceId: wsA.workspaceId, jobId: started.jobId, approvalId, decision: 'approve' } });
  assert.equal(resp.isError, true);
});

test('legacy/unbound Codex job (no workspaceRoot) fails closed through MCP', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-legacy-'));
  const repoA = path.join(root, 'repoA'); fs.mkdirSync(repoA); fs.writeFileSync(path.join(repoA, 'a.txt'), 'hi', 'utf8');
  const { executor, srv, client } = await setup(root, {});
  t.after(() => srv.close());
  t.after(() => executor.shutdown());
  t.after(() => client.close());
  const wsA = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repoA } })));
  // Create a job WITHOUT workspaceRoot (legacy path) directly on the executor.
  const legacy = await executor.start({ prompt: 'legacy', cwd: repoA, accessMode: 'workspace_write' });
  const legacyRes = await client.callTool({ name: 'codex_get', arguments: { workspaceId: wsA.workspaceId, jobId: legacy.jobId } });
  assert.equal(legacyRes.isError, true);
  assert.ok(textOf(legacyRes).includes('predates workspace authorization'));
});

// --- v0.2 M7-C: codex_recover bounded recovery facade -----------------

test('codex_recover resolves the exact bound Codex job by durable identity', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rec-'));
  const repoA = path.join(root, 'repoA'); fs.mkdirSync(repoA); fs.writeFileSync(path.join(repoA, 'a.txt'), 'hi', 'utf8');
  const { executor, srv, client } = await setup(root, {});
  t.after(() => srv.close()); t.after(() => executor.shutdown()); t.after(() => client.close());
  const wsA = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repoA } })));
  const started = JSON.parse(textOf(await client.callTool({ name: 'codex_start', arguments: { workspaceId: wsA.workspaceId, prompt: 'do it', accessMode: 'workspace_write', taskId: 'task-1', identity: 'build' } })));
  await waitFor(() => { const j = executor.load(started.jobId); return j && j.state === 'completed'; });
  const rec = JSON.parse(textOf(await client.callTool({ name: 'codex_recover', arguments: { workspaceId: wsA.workspaceId, taskId: 'task-1' } })));
  assert.equal(rec.jobId, started.jobId);
  assert.equal(rec.threadId, started.threadId);
  assert.equal(rec.workspaceId, wsA.workspaceId);
});

test('codex_recover fails closed (ambiguous) when multiple jobs share an identity', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-amb-'));
  const repoA = path.join(root, 'repoA'); fs.mkdirSync(repoA); fs.writeFileSync(path.join(repoA, 'a.txt'), 'hi', 'utf8');
  const { executor, srv, client } = await setup(root, {});
  t.after(() => srv.close()); t.after(() => executor.shutdown()); t.after(() => client.close());
  const wsA = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repoA } })));
  const a = JSON.parse(textOf(await client.callTool({ name: 'codex_start', arguments: { workspaceId: wsA.workspaceId, prompt: 'a', accessMode: 'workspace_write', taskId: 'task-x', identity: 'same' } })));
  await waitFor(() => { const j = executor.load(a.jobId); return j && j.state === 'completed'; });
  const b = JSON.parse(textOf(await client.callTool({ name: 'codex_start', arguments: { workspaceId: wsA.workspaceId, prompt: 'b', accessMode: 'workspace_write', taskId: 'task-x', identity: 'same' } })));
  const res = await client.callTool({ name: 'codex_recover', arguments: { workspaceId: wsA.workspaceId, taskId: 'task-x' } });
  assert.equal(res.isError, true);
  const err = JSON.parse(textOf(res));
  assert.equal(err.error, 'ambiguous');
  assert.ok(err.matchCount >= 2);
  assert.notEqual(a.jobId, b.jobId);
});

test('codex_recover fails closed for a wrong-workspace match', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ws-'));
  const repoA = path.join(root, 'repoA'); fs.mkdirSync(repoA); fs.writeFileSync(path.join(repoA, 'a.txt'), 'hi', 'utf8');
  const repoB = path.join(root, 'repoB'); fs.mkdirSync(repoB); fs.writeFileSync(path.join(repoB, 'b.txt'), 'yo', 'utf8');
  const { executor, srv, client } = await setup(root, {});
  t.after(() => srv.close()); t.after(() => executor.shutdown()); t.after(() => client.close());
  const wsA = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repoA } })));
  const wsB = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repoB } })));
  const started = JSON.parse(textOf(await client.callTool({ name: 'codex_start', arguments: { workspaceId: wsA.workspaceId, prompt: 'do it', accessMode: 'workspace_write', taskId: 'task-1', identity: 'build' } })));
  await waitFor(() => { const j = executor.load(started.jobId); return j && j.state === 'completed'; });
  const res = await client.callTool({ name: 'codex_recover', arguments: { workspaceId: wsB.workspaceId, taskId: 'task-1' } });
  assert.equal(res.isError, true);
  const err = JSON.parse(textOf(res));
  assert.equal(err.error, 'wrong_workspace');
});

test('codex_recover rejects a stale / unreconcilable binding (no thread identity)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stale-'));
  const repoA = path.join(root, 'repoA'); fs.mkdirSync(repoA); fs.writeFileSync(path.join(repoA, 'a.txt'), 'hi', 'utf8');
  const { executor, srv, client } = await setup(root, {});
  t.after(() => srv.close()); t.after(() => executor.shutdown()); t.after(() => client.close());
  const wsA = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repoA } })));
  const j = executor.jobMap.create();
  executor.jobMap.update(j.jobId, { taskId: 'task-s', identity: 'stale', workspaceRoot: repoA, workspaceId: wsA.workspaceId, threadId: null, turnId: null, state: 'recovery_required' });
  const res = await client.callTool({ name: 'codex_recover', arguments: { workspaceId: wsA.workspaceId, taskId: 'task-s' } });
  assert.equal(res.isError, true);
  const err = JSON.parse(textOf(res));
  assert.equal(err.error, 'stale');
});

test('codex_recover requires at least one identity key (bad_request)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bad-'));
  const repoA = path.join(root, 'repoA'); fs.mkdirSync(repoA); fs.writeFileSync(path.join(repoA, 'a.txt'), 'hi', 'utf8');
  const { executor, srv, client } = await setup(root, {});
  t.after(() => srv.close()); t.after(() => executor.shutdown()); t.after(() => client.close());
  const wsA = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repoA } })));
  const res = await client.callTool({ name: 'codex_recover', arguments: { workspaceId: wsA.workspaceId } });
  assert.equal(res.isError, true);
  assert.ok(textOf(res).includes('requires at least one of taskId, stepId, or identity'));
});

test('codex_recover reconciles the bound job after a local MCP restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-restart-'));
  const repoA = path.join(root, 'repoA'); fs.mkdirSync(repoA); fs.writeFileSync(path.join(repoA, 'a.txt'), 'hi', 'utf8');
  // First runtime binds a job and keeps the turn in progress (slowTurn) so recovery retains writer ownership.
  const r1 = await setup(root, { slowTurn: true });
  const wsA = JSON.parse(textOf(await r1.client.callTool({ name: 'workspace_open', arguments: { path: repoA } })));
  const started = JSON.parse(textOf(await r1.client.callTool({ name: 'codex_start', arguments: { workspaceId: wsA.workspaceId, prompt: 'do it', accessMode: 'workspace_write', taskId: 'task-r', identity: 'build r' } })));
  assert.ok(started.jobId);
  await r1.client.close();
  await r1.srv.close();
  await r1.executor.shutdown();
  // Second runtime over the same dataRoot recovers the same execution.
  const r2 = await setup(root, { slowTurn: true });
  t.after(() => r2.client.close()); t.after(() => r2.srv.close()); t.after(() => r2.executor.shutdown());
  const wsB = JSON.parse(textOf(await r2.client.callTool({ name: 'workspace_open', arguments: { path: repoA } })));
  const rec = JSON.parse(textOf(await r2.client.callTool({ name: 'codex_recover', arguments: { workspaceId: wsB.workspaceId, taskId: 'task-r' } })));
  assert.equal(rec.jobId, started.jobId);
  assert.equal(rec.threadId, started.threadId);
  assert.equal(r2.executor.owner.owner, 'codex');
});
