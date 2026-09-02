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
