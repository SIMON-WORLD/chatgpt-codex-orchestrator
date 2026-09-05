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
  constructor(states = {}) {
    this.states = states;
    this.requests = [];
    this.isRunning = true;
    this._connected = true;
    this._closing = false;
  }
  onNotification() {}
  onServerRequest() {}
  onExit() {}
  async connect() { return this; }
  async close() { this.isRunning = false; this._connected = false; }
  async request(method, params) {
    this.requests.push(method);
    const state = this.states[params.threadId];
    if (method === 'thread/resume') {
      if (state.failResume) throw new Error(`RAW_MCP_RESUME:${params.threadId}`);
      return { thread: { id: params.threadId } };
    }
    if (method === 'thread/read') {
      if (state.failRead) throw new Error(`RAW_MCP_READ:${params.threadId}`);
      return { thread: { id: params.threadId, turns: state.turns } };
    }
    throw new Error(`unexpected request: ${method}`);
  }
}

function textOf(res) {
  const item = res && res.content && res.content.find((c) => c.type === 'text');
  return item ? item.text : '';
}

function addCandidate(executor, clientBackend, ws, repo, suffix, stateSpec = {}) {
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
  clientBackend.states[threadId] = { turns: [{ id: turnId, status: stateSpec.status || 'completed' }], ...stateSpec };
  return { jobId: job.jobId, threadId, turnId };
}

test('MCP unresolved recovery diagnostics expose aggregate reasonCounts only from authoritative executor path', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-diagnostics-mcp-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const clientBackend = new DiagnosticClient();
  const executor = new AppServerExecutor({ client: clientBackend, jobMap: new JobMap({ dataRoot: root }) });
  const srv = await startMcpServer({ workspaceRegistry: registry, appServerExecutor: executor, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  const client = new Client({ name: 'recovery-diagnostics-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  t.after(() => client.close());
  t.after(() => srv.close());
  t.after(() => executor.shutdown());

  const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repo } })));
  const resumeFailed = addCandidate(executor, clientBackend, ws, repo, 'resume-failed', { failResume: true });
  const readFailed = addCandidate(executor, clientBackend, ws, repo, 'read-failed', { failRead: true });
  const unreadable = addCandidate(executor, clientBackend, ws, repo, 'unreadable', { status: 'waitingOnApproval' });

  const res = await client.callTool({ name: 'codex_recovery_reconcile_preflight', arguments: { workspaceId: ws.workspaceId, ...BINDING } });
  assert.equal(res.isError, true);
  const body = JSON.parse(textOf(res));
  assert.equal(body.ok, false);
  assert.equal(body.error, 'reconciliation_unresolved');
  assert.equal(body.unresolvedCandidateCount, 3);
  assert.deepEqual(body.reasonCounts, {
    resume_failed: 1,
    read_failed: 1,
    lifecycle_unreadable: 1,
  });
  assert.equal(Object.values(body.reasonCounts).reduce((a, b) => a + b, 0), body.unresolvedCandidateCount);

  const publicText = JSON.stringify(body);
  assert.equal(publicText.includes('RAW_MCP_RESUME'), false);
  assert.equal(publicText.includes('RAW_MCP_READ'), false);
  for (const candidate of [resumeFailed, readFailed, unreadable]) {
    assert.equal(publicText.includes(candidate.jobId), false);
    assert.equal(publicText.includes(candidate.threadId), false);
    assert.equal(publicText.includes(candidate.turnId), false);
  }
  for (const forbiddenKey of ['jobId', 'threadId', 'turnId', 'createdAt', 'updatedAt', 'jobs', 'candidates']) {
    assert.equal(Object.prototype.hasOwnProperty.call(body, forbiddenKey), false);
  }
  assert.ok(clientBackend.requests.every((method) => method === 'thread/resume' || method === 'thread/read'));
  assert.equal(clientBackend.requests.includes('thread/start'), false);
  assert.equal(clientBackend.requests.includes('turn/start'), false);
  assert.equal(clientBackend.requests.includes('turn/interrupt'), false);
});
