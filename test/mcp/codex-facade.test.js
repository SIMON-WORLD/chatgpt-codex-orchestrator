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
function normalizePath(p) { return String(p || '').toLowerCase().replace(/\\/g, '/'); }

function makeExecutor(root, { approval = '0' } = {}) {
  const env = { ...process.env, FAKE_APP_SERVER_APPROVAL: approval, FAKE_APP_SERVER_STATE_DIR: root };
  const client = new AppServerClient({ codexBin: process.execPath, spawnArgs: [fixture], env });
  return new AppServerExecutor({ dataRoot: root, client });
}

test('codex_delegate MCP facade works against fake App Server (v2)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-'));
  const repoA = path.join(root, 'repoA'); fs.mkdirSync(repoA); fs.writeFileSync(path.join(repoA, 'a.txt'), 'hi', 'utf8');
  const repoB = path.join(root, 'repoB'); fs.mkdirSync(repoB); fs.writeFileSync(path.join(repoB, 'b.txt'), 'yo', 'utf8');

  const executor = makeExecutor(root, { approval: '1' });
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const srv = await startMcpServer({ workspaceRegistry: registry, appServerExecutor: executor, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  t.after(() => srv.close());
  t.after(() => executor.shutdown());

  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  t.after(() => client.close());

  const wsA = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repoA } })));
  const wsB = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repoB } })));
  assert.ok(wsA.workspaceId && wsB.workspaceId);

  const started = JSON.parse(textOf(await client.callTool({ name: 'codex_start', arguments: { workspaceId: wsA.workspaceId, prompt: 'do it' } })));
  assert.ok(started.jobId && started.threadId && started.turnId);

  // Approval surfaced via codex_get (through MCP), then respond.
  let approvalId = null;
  for (let i = 0; i < 40; i++) {
    const g = JSON.parse(textOf(await client.callTool({ name: 'codex_get', arguments: { workspaceId: wsA.workspaceId, jobId: started.jobId } })));
    if (g.pendingApprovals && g.pendingApprovals.length) { approvalId = g.pendingApprovals[0].approvalId; break; }
    await sleep(5);
  }
  assert.ok(approvalId, 'approval not found through codex_get');
  const resp = JSON.parse(textOf(await client.callTool({ name: 'codex_respond_approval', arguments: { workspaceId: wsA.workspaceId, jobId: started.jobId, approvalId, decision: 'approve' } })));
  assert.equal(resp.ok, true);

  // After resolution, codex_get no longer reports it.
  const afterResp = JSON.parse(textOf(await client.callTool({ name: 'codex_get', arguments: { workspaceId: wsA.workspaceId, jobId: started.jobId } })));
  assert.equal(Array.isArray(afterResp.pendingApprovals) && afterResp.pendingApprovals.length, 0);

  // codex_get returns bounded assistant/result (fake emits 'task done').
  const got = JSON.parse(textOf(await client.callTool({ name: 'codex_get', arguments: { workspaceId: wsA.workspaceId, jobId: started.jobId } })));
  assert.ok(got.threadId && got.turnId);
  assert.equal(typeof got.workspaceRoot, 'string');

  const cont = JSON.parse(textOf(await client.callTool({ name: 'codex_continue', arguments: { workspaceId: wsA.workspaceId, jobId: started.jobId, instruction: 'more' } })));
  assert.equal(cont.threadId, started.threadId);
  assert.notEqual(cont.turnId, started.turnId);

  const ir = JSON.parse(textOf(await client.callTool({ name: 'codex_interrupt', arguments: { workspaceId: wsA.workspaceId, jobId: started.jobId } })));
  assert.equal(ir.state, 'interrupted');

  // Cross-workspace authorization: job A cannot be accessed via workspace B.
  const cross = await client.callTool({ name: 'codex_get', arguments: { workspaceId: wsB.workspaceId, jobId: started.jobId } });
  assert.equal(cross.isError, true);
  const crossC = await client.callTool({ name: 'codex_continue', arguments: { workspaceId: wsB.workspaceId, jobId: started.jobId, instruction: 'x' } });
  assert.equal(crossC.isError, true);
});
