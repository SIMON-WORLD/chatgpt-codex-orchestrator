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
const CURRENT_IDENTITY = 'brain-continuity@main:c4088fd3';

function textOf(res) {
  const t = res && res.content && res.content.find((c) => c.type === 'text');
  return t ? t.text : '';
}

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-preflight-mcp-'));
  const repoA = path.join(root, 'repoA');
  fs.mkdirSync(repoA);
  fs.writeFileSync(path.join(repoA, 'a.txt'), 'hi', 'utf8');
  const env = { ...process.env, FAKE_APP_SERVER_STATE_DIR: root };
  const executor = new AppServerExecutor({
    dataRoot: root,
    client: new AppServerClient({ codexBin: process.execPath, spawnArgs: [fixture], env }),
  });
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const srv = await startMcpServer({ workspaceRegistry: registry, appServerExecutor: executor, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  const client = new Client({ name: 'preflight-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repoA } })));
  return { root, repoA, executor, srv, client, workspaceId: ws.workspaceId };
}

async function callPreflight(client, args) {
  try {
    return await client.callTool({ name: 'codex_recovery_preflight', arguments: args });
  } catch (e) {
    assert.fail(`codex_recovery_preflight must be exposed: ${e.message}`);
  }
}

test('MCP recovery preflight reports safe_to_start with only terminal history', async (t) => {
  const x = await setup();
  t.after(() => x.client.close());
  t.after(() => x.srv.close());
  t.after(() => x.executor.shutdown());

  const old = x.executor.jobMap.create();
  x.executor.jobMap.update(old.jobId, {
    workspaceId: x.workspaceId,
    workspaceRoot: x.repoA,
    state: 'completed',
    identity: CURRENT_IDENTITY,
  });

  const res = await callPreflight(x.client, { workspaceId: x.workspaceId, identity: CURRENT_IDENTITY });
  assert.notEqual(res.isError, true);
  const body = JSON.parse(textOf(res));
  assert.equal(body.status, 'safe_to_start');
  assert.equal(body.dangerousCandidateCount, 0);
});

test('MCP recovery preflight returns one unique unbound risk candidate without becoming a job list', async (t) => {
  const x = await setup();
  t.after(() => x.client.close());
  t.after(() => x.srv.close());
  t.after(() => x.executor.shutdown());

  const risk = x.executor.jobMap.create();
  x.executor.jobMap.update(risk.jobId, {
    workspaceId: x.workspaceId,
    workspaceRoot: x.repoA,
    state: 'recovery_required',
    taskId: null,
    stepId: null,
    identity: null,
  });

  const res = await callPreflight(x.client, { workspaceId: x.workspaceId, identity: CURRENT_IDENTITY });
  assert.notEqual(res.isError, true);
  const body = JSON.parse(textOf(res));
  assert.equal(body.status, 'recover_existing');
  assert.equal(body.recovery.jobId, risk.jobId);
  assert.equal(body.nextAction, 'codex_reconcile');
  assert.equal('jobs' in body, false);
});

test('MCP recovery preflight fails closed on ambiguity and does not disclose candidate ids', async (t) => {
  const x = await setup();
  t.after(() => x.client.close());
  t.after(() => x.srv.close());
  t.after(() => x.executor.shutdown());

  for (let i = 0; i < 2; i++) {
    const risk = x.executor.jobMap.create();
    x.executor.jobMap.update(risk.jobId, {
      workspaceId: x.workspaceId,
      workspaceRoot: x.repoA,
      state: i === 0 ? 'running' : 'created',
      taskId: null,
      stepId: null,
      identity: null,
    });
  }

  const res = await callPreflight(x.client, { workspaceId: x.workspaceId, identity: CURRENT_IDENTITY });
  assert.equal(res.isError, true);
  const body = JSON.parse(textOf(res));
  assert.equal(body.error, 'ambiguous');
  assert.equal(body.dangerousCandidateCount, 2);
  assert.equal('jobId' in body, false);
  assert.equal('jobs' in body, false);
});
