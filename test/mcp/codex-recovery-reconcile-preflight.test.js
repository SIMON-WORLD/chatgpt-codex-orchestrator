import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { AppServerExecutor } from '../../src/executor/app-server-executor.js';
import { JobMap } from '../../src/executor/job-map.js';

const BINDING = {
  taskId: 'post-m7-brain-continuity-implementation',
  stepId: 'brain-continuity-implementation',
  identity: 'brain-continuity@main:c4088fd3',
};

class ReconcileOnlyClient {
  constructor(states = {}) { this.states = states; this.requests = []; this.isRunning = true; this._connected = true; this._closing = false; }
  onNotification() {}
  onServerRequest() {}
  onExit() {}
  async connect() { return this; }
  async close() { this.isRunning = false; this._connected = false; }
  async request(method, params) {
    this.requests.push(method);
    const state = this.states[params.threadId];
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'thread/read') return { thread: { id: params.threadId, turns: state.turns } };
    throw new Error(`unexpected request: ${method}`);
  }
}

function textOf(res) {
  const t = res && res.content && res.content.find((c) => c.type === 'text');
  return t ? t.text : '';
}

test('MCP exposes bounded recovery remediation and returns only the aggregate post-reconcile decision', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-remediation-mcp-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const clientBackend = new ReconcileOnlyClient();
  const executor = new AppServerExecutor({ client: clientBackend, jobMap: new JobMap({ dataRoot: root }) });
  const srv = await startMcpServer({ workspaceRegistry: registry, appServerExecutor: executor, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  const client = new Client({ name: 'recovery-remediation-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  t.after(() => client.close());
  t.after(() => srv.close());
  t.after(() => executor.shutdown());

  const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repo } })));
  for (const suffix of ['a', 'b']) {
    const job = executor.jobMap.create();
    const threadId = `thread-${suffix}`;
    const turnId = `turn-${suffix}`;
    const unitId = `unit-${suffix}`;
    executor.jobMap.update(job.jobId, {
      ...BINDING,
      workspaceId: ws.workspaceId,
      workspaceRoot: repo,
      state: 'recovery_required',
      accessMode: 'workspace_write',
      isWriter: true,
      threadId,
      turnId,
      mutationUnitId: unitId,
      turnUnits: { [turnId]: unitId },
    });
    clientBackend.states[threadId] = { turns: [{ id: turnId, status: 'completed' }] };
  }

  let res;
  try {
    res = await client.callTool({ name: 'codex_recovery_reconcile_preflight', arguments: { workspaceId: ws.workspaceId, ...BINDING } });
  } catch (e) {
    assert.fail(`codex_recovery_reconcile_preflight must be exposed: ${e.message}`);
  }
  assert.notEqual(res.isError, true);
  const body = JSON.parse(textOf(res));
  assert.deepEqual(body, {
    ok: true,
    status: 'safe_to_start',
    dangerousCandidateCount: 0,
    nextAction: 'codex_start_allowed',
  });
  assert.deepEqual(new Set(clientBackend.requests), new Set(['thread/resume', 'thread/read']));
  assert.equal('jobs' in body, false);
  assert.equal('candidates' in body, false);
});
