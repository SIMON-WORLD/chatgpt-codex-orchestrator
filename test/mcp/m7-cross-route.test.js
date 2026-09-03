// chatgpt-codex-orchestrator: M7 mutation-lifecycle cross-route contract tests.
// Codex (workspace_write) -> authoritative terminal -> execution ownership released
// -> Direct Local (chatgpt) can take over. Also verifies that an active / unresolved
// codex unit keeps Direct Local / a new Codex mutation BLOCKED (fail-closed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { MutationOwner } from '../../src/state/mutation-owner.js';
import { OperationState } from '../../src/state/operation-state.js';
import { AppServerExecutor } from '../../src/executor/app-server-executor.js';
import { AppServerClient } from '../../src/executor/app-server-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, '..', '..', 'test-fixtures', 'executor', 'fake-app-server.mjs');
function textOf(res) { const t = res && res.content && res.content.find((c) => c.type === 'text'); return t ? t.text : ''; }
async function waitFor(fn, timeout = 3000) { const s = Date.now(); while (Date.now() - s < timeout) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)); } return false; }

function makeEnv(root, extra = {}) { return { ...process.env, FAKE_APP_SERVER_APPROVAL: '0', FAKE_APP_SERVER_STATE_DIR: root, ...extra }; }

async function setup(root, { slow = false, noConfirmInterrupt = false, turnFail = false, die = null } = {}) {
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'a.txt'), 'hello world', 'utf8');
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const shared = new MutationOwner();
  const ops = new OperationState({ dataRoot: root });
  const env = makeEnv(root, { ...(slow ? { FAKE_APP_SERVER_SLOW_TURN: '1' } : {}), ...(noConfirmInterrupt ? { FAKE_APP_SERVER_NO_CONFIRM_INTERRUPT: '1' } : {}), ...(turnFail ? { FAKE_APP_SERVER_TURN_FAIL: '1' } : {}), ...(die !== null ? { FAKE_APP_SERVER_DIE_MS: String(die) } : {}) });
  const exec = new AppServerExecutor({ dataRoot: root, client: new AppServerClient({ codexBin: process.execPath, spawnArgs: [fixture], env }), mutationOwner: shared });
  const srv = await startMcpServer({ workspaceRegistry: registry, appServerExecutor: exec, mutationOwner: shared, operationState: ops, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  const client = new Client({ name: 'm7-cross', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  return { shared, exec, srv, client, repo };
}

test('Codex workspace_write -> completed -> owner released -> Direct Local apply works', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm7x-'));
  const { shared, exec, srv, client, repo } = await setup(root);
  t.after(() => exec.shutdown()); t.after(() => client.close()); t.after(() => srv.close());
  const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repo } })));
  const started = JSON.parse(textOf(await client.callTool({ name: 'codex_start', arguments: { workspaceId: ws.workspaceId, prompt: 'do it', accessMode: 'workspace_write' } })));
  assert.ok(started.jobId);
  assert.equal(started.accessMode, 'workspace_write');
  assert.equal(started.sandbox, 'workspace-write');
  await waitFor(() => shared.owner === 'none'); // authoritative terminal releases execution ownership
  assert.equal(shared.owner, 'none');
  // Direct Local: read base hash, preview, apply.
  const rd = JSON.parse(textOf(await client.callTool({ name: 'read', arguments: { workspaceId: ws.workspaceId, path: 'a.txt' } })));
  const p = JSON.parse(textOf(await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'preview', change: { path: 'a.txt', baseHash: rd.sha256, replacements: [{ oldText: 'world', newText: 'there' }] } } })));
  assert.ok(p.changeSetId);
  const a = JSON.parse(textOf(await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'apply', changeSetId: p.changeSetId } })));
  assert.equal(a.status, 'applied');
});

test('Codex running -> interrupt confirmed -> owner released -> Direct Local apply works', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm7x-'));
  const { shared, exec, srv, client, repo } = await setup(root, { slow: true });
  t.after(() => exec.shutdown()); t.after(() => client.close()); t.after(() => srv.close());
  const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repo } })));
  const started = JSON.parse(textOf(await client.callTool({ name: 'codex_start', arguments: { workspaceId: ws.workspaceId, prompt: 'do it', accessMode: 'workspace_write' } })));
  assert.ok(started.jobId);
  assert.equal(shared.owner, 'codex');
  const ir = JSON.parse(textOf(await client.callTool({ name: 'codex_interrupt', arguments: { workspaceId: ws.workspaceId, jobId: started.jobId } })));
  assert.equal(ir.reconciliation, 'confirmed');
  assert.equal(ir.ownershipReleased, true);
  assert.equal(shared.owner, 'none');
  const rd = JSON.parse(textOf(await client.callTool({ name: 'read', arguments: { workspaceId: ws.workspaceId, path: 'a.txt' } })));
  const p = JSON.parse(textOf(await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'preview', change: { path: 'a.txt', baseHash: rd.sha256, replacements: [{ oldText: 'world', newText: 'there' }] } } })));
  const a = JSON.parse(textOf(await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'apply', changeSetId: p.changeSetId } })));
  assert.equal(a.status, 'applied');
});

test('Codex running -> interrupt unresolved -> Direct Local apply stays blocked', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm7x-'));
  const { shared, exec, srv, client, repo } = await setup(root, { slow: true, noConfirmInterrupt: true });
  t.after(() => exec.shutdown()); t.after(() => client.close()); t.after(() => srv.close());
  const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repo } })));
  const started = JSON.parse(textOf(await client.callTool({ name: 'codex_start', arguments: { workspaceId: ws.workspaceId, prompt: 'do it', accessMode: 'workspace_write' } })));
  const ir = JSON.parse(textOf(await client.callTool({ name: 'codex_interrupt', arguments: { workspaceId: ws.workspaceId, jobId: started.jobId } })));
  assert.equal(ir.reconciliation, 'unresolved');
  assert.equal(ir.ownershipReleased, false);
  assert.equal(shared.owner, 'codex'); // fail-closed: NOT released
  // Direct Local preview may succeed (read-only) but apply must be blocked (owned by codex).
  const rd = JSON.parse(textOf(await client.callTool({ name: 'read', arguments: { workspaceId: ws.workspaceId, path: 'a.txt' } })));
  const p = JSON.parse(textOf(await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'preview', change: { path: 'a.txt', baseHash: rd.sha256, replacements: [{ oldText: 'world', newText: 'there' }] } } })));
  assert.ok(p.changeSetId);
  const applyRes = await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'apply', changeSetId: p.changeSetId } });
  const applyText = textOf(applyRes);
  assert.ok(/owned by codex|MutationOwner/.test(applyText), 'Direct Local apply should stay blocked while codex owns, got: ' + applyText);
});

test('unexpected App Server death -> owner unknown -> Direct Local / new Codex stays blocked', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm7x-'));
  const { shared, exec, srv, client, repo } = await setup(root, { slow: true, die: 1500 });
  t.after(() => exec.shutdown()); t.after(() => client.close()); t.after(() => srv.close());
  const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repo } })));
  const started = JSON.parse(textOf(await client.callTool({ name: 'codex_start', arguments: { workspaceId: ws.workspaceId, prompt: 'do it', accessMode: 'workspace_write' } })));
  assert.equal(shared.owner, 'codex');
  // The fake App Server dies unexpectedly while the turn is still running.
  await waitFor(() => !exec.client.isRunning, 3000);
  assert.equal(shared.unitState, 'unknown'); // fail-closed, NOT released
  assert.equal(shared.owner, 'codex');
  assert.throws(() => shared.acquire('chatgpt', 'other'), /owned by codex|not reconciled/);
});


// ---- M7 hardening R2 -----------------------------------------------------

test('writer death -> codex_get -> codex_reconcile terminal -> release -> Direct Local apply works', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm7x-'));
  const { shared, exec, srv, client, repo } = await setup(root, { die: 1500 });
  t.after(() => exec.shutdown()); t.after(() => client.close()); t.after(() => srv.close());
  const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repo } })));
  const started = JSON.parse(textOf(await client.callTool({ name: 'codex_start', arguments: { workspaceId: ws.workspaceId, prompt: 'do it', accessMode: 'workspace_write' } })));
  assert.ok(started.jobId);
  // The fake App Server dies while the writer job is (or was) active.
  await waitFor(() => !exec.client.isRunning, 3000);
  // codex_get reports structured recovery guidance.
  const got = JSON.parse(textOf(await client.callTool({ name: 'codex_get', arguments: { workspaceId: ws.workspaceId, jobId: started.jobId } })));
  assert.equal(got.recoveryRequired, true);
  assert.equal(got.nextAction, 'codex_reconcile');
  // codex_reconcile reconnects + reattaches + sees terminal -> release.
  const rec = JSON.parse(textOf(await client.callTool({ name: 'codex_reconcile', arguments: { workspaceId: ws.workspaceId, jobId: started.jobId } })));
  assert.equal(rec.resolution, 'terminal');
  assert.equal(rec.ownershipReleased, true);
  await waitFor(() => shared.owner === 'none', 3000);
  assert.equal(shared.owner, 'none');
  // Direct Local apply now works.
  const rd = JSON.parse(textOf(await client.callTool({ name: 'read', arguments: { workspaceId: ws.workspaceId, path: 'a.txt' } })));
  const p = JSON.parse(textOf(await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'preview', change: { path: 'a.txt', baseHash: rd.sha256, replacements: [{ oldText: 'world', newText: 'there' }] } } })));
  const a = JSON.parse(textOf(await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'apply', changeSetId: p.changeSetId } })));
  assert.equal(a.status, 'applied');
});

test('reconcile inProgress -> writer retained -> Direct Local mutation rejected', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm7x-'));
  const { shared, exec, srv, client, repo } = await setup(root, { slow: true });
  t.after(() => exec.shutdown()); t.after(() => client.close()); t.after(() => srv.close());
  const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repo } })));
  const started = JSON.parse(textOf(await client.callTool({ name: 'codex_start', arguments: { workspaceId: ws.workspaceId, prompt: 'do it', accessMode: 'workspace_write' } })));
  assert.equal(shared.owner, 'codex');
  const rec = JSON.parse(textOf(await client.callTool({ name: 'codex_reconcile', arguments: { workspaceId: ws.workspaceId, jobId: started.jobId } })));
  assert.equal(rec.resolution, 'in_progress');
  assert.equal(rec.ownershipReleased, false);
  assert.equal(shared.owner, 'codex'); // writer retained
  // Direct Local apply stays blocked.
  const rd = JSON.parse(textOf(await client.callTool({ name: 'read', arguments: { workspaceId: ws.workspaceId, path: 'a.txt' } })));
  const p = JSON.parse(textOf(await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'preview', change: { path: 'a.txt', baseHash: rd.sha256, replacements: [{ oldText: 'world', newText: 'there' }] } } })));
  const applyRes = await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'apply', changeSetId: p.changeSetId } });
  assert.ok(/owned by codex|MutationOwner/.test(textOf(applyRes)), 'Direct Local apply must stay blocked while codex holds writer: ' + textOf(applyRes));
});

test('codex_reconcile is exposed with workspaceId+jobId schema', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm7x-'));
  const { exec, srv, client } = await setup(root);
  t.after(() => exec.shutdown()); t.after(() => client.close()); t.after(() => srv.close());
  const tools = await client.listTools();
  const reconcile = tools.tools.find((x) => x.name === 'codex_reconcile');
  assert.ok(reconcile, 'codex_reconcile must be a public tool');
  assert.ok(reconcile.inputSchema && reconcile.inputSchema.properties && reconcile.inputSchema.properties.workspaceId, 'requires workspaceId');
  assert.ok(reconcile.inputSchema.properties.jobId, 'requires jobId');
});
