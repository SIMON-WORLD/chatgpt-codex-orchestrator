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

class DiagnosticClient {
  constructor() { this.states = {}; this.requests = []; this.isRunning = true; this._connected = true; this._closing = false; }
  onNotification() {}
  onServerRequest() {}
  onExit() {}
  async connect() { return this; }
  async close() { this.isRunning = false; this._connected = false; }
  async request(method, params) {
    this.requests.push(method);
    const state = this.states[params.threadId] || {};
    if (method === 'thread/resume') {
      if (state.resumeError) throw new Error(state.resumeError);
      return { thread: { id: params.threadId } };
    }
    if (method === 'thread/read') {
      if (state.readError) throw new Error(state.readError);
      return { thread: { id: params.threadId, turns: state.turns || [] } };
    }
    throw new Error(`unexpected request: ${method}`);
  }
}

function textOf(res) {
  const t = res && res.content && res.content.find((c) => c.type === 'text');
  return t ? t.text : '';
}

function addBrokenCandidate(executor, backend, { workspaceId, workspaceRoot, suffix, resumeError = null, readError = null }) {
  const created = executor.jobMap.create();
  const threadId = `thread-${suffix}`;
  const turnId = `turn-${suffix}`;
  const unitId = `unit-${suffix}`;
  executor.jobMap.update(created.jobId, {
    ...BINDING,
    workspaceId,
    workspaceRoot,
    state: 'recovery_required',
    accessMode: 'workspace_write',
    isWriter: true,
    threadId,
    turnId,
    mutationUnitId: unitId,
    turnUnits: { [turnId]: unitId },
  });
  backend.states[threadId] = {
    turns: [{ id: turnId, status: 'completed' }],
    resumeError,
    readError,
  };
  return { jobId: created.jobId, threadId, turnId };
}

test('MCP reconciliation_unresolved response exposes only aggregate reasonCounts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-diagnostics-mcp-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const backend = new DiagnosticClient();
  const executor = new AppServerExecutor({ client: backend, jobMap: new JobMap({ dataRoot: root }) });
  const srv = await startMcpServer({ workspaceRegistry: registry, appServerExecutor: executor, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  const client = new Client({ name: 'recovery-diagnostics-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  t.after(() => client.close());
  t.after(() => srv.close());
  t.after(() => executor.shutdown());

  const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repo } })));
  const hidden = [
    addBrokenCandidate(executor, backend, { workspaceId: ws.workspaceId, workspaceRoot: repo, suffix: 'resume', resumeError: 'RAW_SECRET_RESUME_ERROR' }),
    addBrokenCandidate(executor, backend, { workspaceId: ws.workspaceId, workspaceRoot: repo, suffix: 'read', readError: 'RAW_SECRET_READ_ERROR' }),
  ];

  const res = await client.callTool({ name: 'codex_recovery_reconcile_preflight', arguments: { workspaceId: ws.workspaceId, ...BINDING } });
  assert.equal(res.isError, true);
  const body = JSON.parse(textOf(res));
  assert.deepEqual(body, {
    ok: false,
    error: 'reconciliation_unresolved',
    reason: 'one or more hidden recovery-risk executions could not be authoritatively reconciled; refusing to infer safety',
    unresolvedCandidateCount: 2,
    reasonCounts: {
      resume_failed: 1,
      read_failed: 1,
    },
  });

  const publicJson = JSON.stringify(body);
  assert.equal(publicJson.includes('RAW_SECRET_RESUME_ERROR'), false);
  assert.equal(publicJson.includes('RAW_SECRET_READ_ERROR'), false);
  assert.equal('jobId' in body, false);
  assert.equal('threadId' in body, false);
  assert.equal('turnId' in body, false);
  assert.equal('jobs' in body, false);
  assert.equal('candidates' in body, false);
  assert.equal('createdAt' in body, false);
  assert.equal('updatedAt' in body, false);
  for (const value of hidden.flatMap((x) => [x.jobId, x.threadId, x.turnId])) assert.equal(publicJson.includes(value), false);
  assert.ok(backend.requests.every((method) => method === 'thread/resume' || method === 'thread/read'));
});
