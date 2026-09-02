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
import { ChangeSetService } from '../../src/local/change-set.js';
import { VerifyService } from '../../src/local/verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, '..', '..', 'test-fixtures', 'executor', 'fake-app-server.mjs');
function textOf(res) { const t = res && res.content && res.content.find((c) => c.type === 'text'); return t ? t.text : ''; }

test('MCP edit (preview/apply/idempotent) + verify with shared owner', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'a.txt'), 'hello world', 'utf8');
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const shared = new MutationOwner();
  const ops = new OperationState({ dataRoot: root });
  const env = { ...process.env, FAKE_APP_SERVER_APPROVAL: '0', FAKE_APP_SERVER_STATE_DIR: root };
  const exec = new AppServerExecutor({ dataRoot: root, client: new AppServerClient({ codexBin: process.execPath, spawnArgs: [fixture], env }), mutationOwner: shared });
  const verifyChecks = { syntax: { command: process.execPath, args: ['-e', 'process.exit(0)'], effect: 'read_only', timeoutMs: 5000 } };
  const srv = await startMcpServer({ workspaceRegistry: registry, appServerExecutor: exec, mutationOwner: shared, operationState: ops, verifyChecks, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  t.after(() => exec.shutdown());
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  t.after(() => client.close());
  t.after(() => srv.close());

  const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repo } })));
  const rd = JSON.parse(textOf(await client.callTool({ name: 'read', arguments: { workspaceId: ws.workspaceId, path: 'a.txt' } })));
  assert.ok(rd.sha256);

  const p = JSON.parse(textOf(await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'preview', change: { path: 'a.txt', baseHash: rd.sha256, replacements: [{ oldText: 'world', newText: 'there' }] } } })));
  assert.ok(p.changeSetId && p.proposedHash);
  const a = JSON.parse(textOf(await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'apply', changeSetId: p.changeSetId } })));
  assert.equal(a.status, 'applied');
  // Idempotent replay.
  const replay = JSON.parse(textOf(await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'apply', changeSetId: p.changeSetId } })));
  assert.equal(replay.idempotentReplay, true);
  const rd2 = JSON.parse(textOf(await client.callTool({ name: 'read', arguments: { workspaceId: ws.workspaceId, path: 'a.txt' } })));
  assert.equal(rd2.content, 'hello there');

  const v = JSON.parse(textOf(await client.callTool({ name: 'verify', arguments: { workspaceId: ws.workspaceId, check: 'syntax' } })));
  assert.equal(v.passed, true);
});

// ---- r1: shared-owner authority is enforced at wiring time ------------------

test('createToolsServer refuses a changeSetService with an independent mutation owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-owner-'));
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const ownerA = new MutationOwner();
  const ownerB = new MutationOwner();
  const exec = new AppServerExecutor({ dataRoot: root, client: new AppServerClient({ codexBin: process.execPath, spawnArgs: [fixture] }), mutationOwner: ownerB });
  const cs = new ChangeSetService({ workspaceRegistry: registry, operationState: new OperationState({ dataRoot: root }), mutationOwner: ownerA });
  // Direct wiring-time validation: an injected changeSetService that does NOT share the
  // executor's mutation owner must fail closed.
  const { createToolsServer } = await import('../../src/mcp/tools.js');
  assert.throws(() => createToolsServer({ workspaceRegistry: registry, appServerExecutor: exec, changeSetService: cs }), /changeSetService\.mutationOwner must be shared/);
  await exec.shutdown();
});

test('createToolsServer refuses a verifyService with an independent mutation owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-owner2-'));
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const ownerA = new MutationOwner();
  const ownerB = new MutationOwner();
  const exec = new AppServerExecutor({ dataRoot: root, client: new AppServerClient({ codexBin: process.execPath, spawnArgs: [fixture] }), mutationOwner: ownerB });
  const vs = new VerifyService({ workspaceRegistry: registry, mutationOwner: ownerA, verifyChecks: { syntax: { command: process.execPath, args: ['-e', 'process.exit(0)'], effect: 'read_only', timeoutMs: 5000 } } });
  const { createToolsServer } = await import('../../src/mcp/tools.js');
  assert.throws(() => createToolsServer({ workspaceRegistry: registry, appServerExecutor: exec, verifyService: vs }), /verifyService\.mutationOwner must be shared/);
  await exec.shutdown();
});

test('codex_owned workspace blocks Direct Local edit apply (fail before mutation)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-x-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'a.txt'), 'hello world', 'utf8');
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const shared = new MutationOwner();
  const ops = new OperationState({ dataRoot: root });
  const env = { ...process.env, FAKE_APP_SERVER_APPROVAL: '0', FAKE_APP_SERVER_STATE_DIR: root };
  const exec = new AppServerExecutor({ dataRoot: root, client: new AppServerClient({ codexBin: process.execPath, spawnArgs: [fixture], env }), mutationOwner: shared });
  const srv = await startMcpServer({ workspaceRegistry: registry, appServerExecutor: exec, mutationOwner: shared, operationState: ops, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  t.after(() => exec.shutdown());
  t.after(() => srv.close());
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  t.after(() => client.close());

  const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repo } })));
  const rd = JSON.parse(textOf(await client.callTool({ name: 'read', arguments: { workspaceId: ws.workspaceId, path: 'a.txt' } })));
  const p = JSON.parse(textOf(await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'preview', change: { path: 'a.txt', baseHash: rd.sha256, replacements: [{ oldText: 'world', newText: 'there' }] } } })));

  // A Codex turn is running -> codex owns the workspace.
  const started = JSON.parse(textOf(await client.callTool({ name: 'codex_start', arguments: { workspaceId: ws.workspaceId, prompt: 'do it' } })));
  assert.ok(started.jobId);
  assert.equal(shared.owner, 'codex');

  const apply = await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'apply', changeSetId: p.changeSetId } });
  assert.equal(apply.isError, true);
  assert.match(textOf(apply), /already owned by codex|cannot acquire chatgpt/);
  // Target file is untouched.
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'hello world');
});

test('chatgpt_owned workspace blocks codex_start (fail before App Server action)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-y-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'a.txt'), 'hello world', 'utf8');
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const shared = new MutationOwner();
  const ops = new OperationState({ dataRoot: root });
  const env = { ...process.env, FAKE_APP_SERVER_APPROVAL: '0', FAKE_APP_SERVER_STATE_DIR: root };
  const exec = new AppServerExecutor({ dataRoot: root, client: new AppServerClient({ codexBin: process.execPath, spawnArgs: [fixture], env }), mutationOwner: shared });
  const srv = await startMcpServer({ workspaceRegistry: registry, appServerExecutor: exec, mutationOwner: shared, operationState: ops, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  t.after(() => exec.shutdown());
  t.after(() => srv.close());
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  t.after(() => client.close());

  const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repo } })));

  // Simulate a Direct Local (chatgpt) mutation unit currently holding the workspace.
  shared.acquire('chatgpt', 'direct-local-unit');
  const started = await client.callTool({ name: 'codex_start', arguments: { workspaceId: ws.workspaceId, prompt: 'do it' } });
  assert.equal(started.isError, true);
  assert.match(textOf(started), /workspace already owned by chatgpt|cannot acquire codex/);
  assert.equal(shared.owner, 'chatgpt');
});
