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
import { OperationState } from '../../src/state/operation-state.js';
import { ChangeSetService, computeSha256 } from '../../src/local/change-set.js';
import { VerifyService } from '../../src/local/verify.js';

function textOf(res) { const t = res && res.content && res.content.find((c) => c.type === 'text'); return t ? t.text : ''; }

function makeStubExecutor(owner) {
  const jobs = new Map();
  const calls = [];
  return {
    owner,
    calls,
    jobs,
    async start(o) {
      calls.push(['start', o]);
      const jobId = 'stub-' + (jobs.size + 1);
      jobs.set(jobId, { jobId, workspaceRoot: o.workspaceRoot || null, workspaceId: o.workspaceId || null, taskId: o.taskId || null, stepId: o.stepId || null, identity: o.identity || null, accessMode: o.accessMode, threadId: 'th' });
      return { jobId, threadId: 'th', turnId: 't1', state: 'running' };
    },
    async continue(o) {
      calls.push(['continue', o]);
      const job = jobs.get(o.jobId);
      if (!job) throw new Error('unknown job: ' + o.jobId);
      if (o.taskId != null) job.taskId = o.taskId;
      return { jobId: o.jobId, state: 'running' };
    },
    load(jobId) { return jobs.get(jobId) || null; },
    seed(job) { jobs.set(job.jobId, job); },
  };
}

const VERIFY_CHECKS = {
  noop: { effect: 'read_only', command: process.execPath, args: ['-e', ''], timeoutMs: 15000 },
  touch_marker: { effect: 'workspace_effect', command: process.execPath, args: ['-e', "require('fs').appendFileSync('verify-marker.txt','x')"], timeoutMs: 15000 },
};

function fixtureDirs(prefix = 'mutauth-') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = fs.realpathSync.native(tmp);
  const repoA = path.join(root, 'repoA'); fs.mkdirSync(repoA); fs.writeFileSync(path.join(repoA, 'a.txt'), 'hello', 'utf8');
  const repoB = path.join(root, 'repoB'); fs.mkdirSync(repoB); fs.writeFileSync(path.join(repoB, 'b.txt'), 'yo', 'utf8');
  return { root, repoA, repoB };
}

async function startDurableMcp({ dataRoot, roots, executor }) {
  const owner = (executor && executor.owner) || new MutationOwner();
  const registry = new WorkspaceRegistry({ allowedRoots: roots });
  const operationState = new OperationState({ dataRoot });
  const governance = createDurableGovernanceService({ dataRoot, namespace: 'default' });
  const changeSet = new ChangeSetService({ workspaceRegistry: registry, operationState, mutationOwner: owner });
  const verify = new VerifyService({ workspaceRegistry: registry, mutationOwner: owner, verifyChecks: VERIFY_CHECKS });
  const srv = await startMcpServer({
    workspaceRegistry: registry,
    governanceService: governance,
    appServerExecutor: executor || null,
    mutationOwner: owner,
    operationState,
    changeSetService: changeSet,
    verifyService: verify,
    verifyChecks: VERIFY_CHECKS,
    host: '127.0.0.1',
    port: 0,
    allowedRoots: roots,
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  return { owner, registry, governance, changeSet, verify, srv, client };
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

test('Issue #29: a new Codex turn requires current durable task + canonical root + Parent token; stale handles fail closed', async (t) => {
  const { root, repoA, repoB } = fixtureDirs();
  const owner = new MutationOwner();
  const stub = makeStubExecutor(owner);
  const ctx = await startDurableMcp({ dataRoot: root, roots: [repoA, repoB], executor: stub });
  t.after(() => closeAll(ctx));
  const wsA = JSON.parse((await call(ctx.client, 'workspace_open', { path: repoA })).text);
  const wsB = JSON.parse((await call(ctx.client, 'workspace_open', { path: repoB })).text);

  const plan = JSON.parse((await call(ctx.client, 'governance_transition', { taskId: 't1', control: 'PLAN', projectKey: 'repo/codex', identity: 'issue-auth', workspaceId: wsA.workspaceId })).text);
  const tokenA = plan.authorityToken;
  assert.ok(tokenA);
  assert.equal(plan.workspaceRoot, path.resolve(repoA));
  const task = await call(ctx.client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }], route: 'CODEX_DELEGATE', authorityToken: tokenA });
  assert.equal(JSON.parse(task.text).ok, true);

  // Authorized start binds the active governance task and reaches the executor.
  const start = JSON.parse((await call(ctx.client, 'codex_start', { workspaceId: wsA.workspaceId, prompt: 'do it', accessMode: 'workspace_write', taskId: 't1', authorityToken: tokenA })).text);
  assert.equal(start.jobId, 'stub-1');
  assert.deepEqual(stub.calls.map((c) => c[0]), ['start']);
  assert.equal(stub.calls[0][1].taskId, 't1');
  const jobId = start.jobId;

  // Stale / missing token, wrong task, and cross-workspace handle all fail BEFORE the executor.
  const stale = await call(ctx.client, 'codex_start', { workspaceId: wsA.workspaceId, prompt: 'x', accessMode: 'workspace_write', taskId: 't1', authorityToken: 'old-token' });
  assert.equal(stale.res.isError, true); assert.match(stale.text, /stale_authority/);
  const noToken = await call(ctx.client, 'codex_start', { workspaceId: wsA.workspaceId, prompt: 'x', accessMode: 'workspace_write', taskId: 't1' });
  assert.equal(noToken.res.isError, true); assert.match(noToken.text, /stale_authority/);
  const wrongTask = await call(ctx.client, 'codex_start', { workspaceId: wsA.workspaceId, prompt: 'x', accessMode: 'workspace_write', taskId: 'other-task', authorityToken: tokenA });
  assert.equal(wrongTask.res.isError, true); assert.match(wrongTask.text, /task_mismatch/);
  const wrongWs = await call(ctx.client, 'codex_start', { workspaceId: wsB.workspaceId, prompt: 'x', accessMode: 'workspace_write', taskId: 't1', authorityToken: tokenA });
  assert.equal(wrongWs.res.isError, true); assert.match(wrongWs.text, /workspace_mismatch/);
  assert.deepEqual(stub.calls.map((c) => c[0]), ['start'], 'no executor start on any rejected turn');

  // New turn (continue) with the current token is authorized; stale token is rejected.
  const cont = await call(ctx.client, 'codex_continue', { workspaceId: wsA.workspaceId, jobId, instruction: 'more', taskId: 't1', authorityToken: tokenA });
  assert.notEqual(cont.res.isError, true);
  assert.deepEqual(stub.calls.map((c) => c[0]), ['start', 'continue']);
  const contStale = await call(ctx.client, 'codex_continue', { workspaceId: wsA.workspaceId, jobId, instruction: 'more', taskId: 't1', authorityToken: 'old' });
  assert.equal(contStale.res.isError, true); assert.match(contStale.text, /stale_authority/);

  // A job bound to a DIFFERENT governance task cannot be continued under the active task.
  stub.seed({ jobId: 'legacy-job', workspaceRoot: path.resolve(repoA), workspaceId: wsA.workspaceId, taskId: 'old-task', threadId: 'th', accessMode: 'workspace_write' });
  const cross = await call(ctx.client, 'codex_continue', { workspaceId: wsA.workspaceId, jobId: 'legacy-job', instruction: 'x', taskId: 't1', authorityToken: tokenA });
  assert.equal(cross.res.isError, true); assert.match(cross.text, /cross-task/);
});

test('Issue #29: stale Parent/task + old handles cannot authorize Direct Local apply / workspace-effect; restart uses refreshed workspaceId', async (t) => {
  const { root, repoA } = fixtureDirs('mutapply-');
  const owner = new MutationOwner();
  const stub = makeStubExecutor(owner);
  const ctx1 = await startDurableMcp({ dataRoot: root, roots: [repoA], executor: stub });
  t.after(() => closeAll(ctx1));
  const wsA = JSON.parse((await call(ctx1.client, 'workspace_open', { path: repoA })).text);
  const wsIdA = wsA.workspaceId;
  const file = path.join(repoA, 'a.txt');
  const baseHash = computeSha256(fs.readFileSync(file));

  const plan = JSON.parse((await call(ctx1.client, 'governance_transition', { taskId: 't1', control: 'PLAN', projectKey: 'repo/local', identity: 'issue-apply', workspaceId: wsIdA })).text);
  const tokenA = plan.authorityToken;
  const task = await call(ctx1.client, 'governance_transition', { taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }], route: 'CHATGPT_DIRECT_LOCAL', authorityToken: tokenA });
  assert.equal(JSON.parse(task.text).ok, true);

  const change = { path: 'a.txt', baseHash, replacements: [{ oldText: 'hello', newText: 'hello2', expectedOccurrences: 1 }] };
  const preview = JSON.parse((await call(ctx1.client, 'edit', { workspaceId: wsIdA, mode: 'preview', change })).text);
  assert.ok(preview.changeSetId);

  // Apply without the current Parent token fails closed before any file mutation.
  const applyNoToken = await call(ctx1.client, 'edit', { workspaceId: wsIdA, mode: 'apply', changeSetId: preview.changeSetId });
  assert.equal(applyNoToken.res.isError, true);
  assert.match(applyNoToken.text, /stale_authority/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');

  const apply = await call(ctx1.client, 'edit', { workspaceId: wsIdA, mode: 'apply', changeSetId: preview.changeSetId, taskId: 't1', authorityToken: tokenA });
  assert.notEqual(apply.res.isError, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello2');

  // New Parent authority: takeover increments generation; old token A is now stale.
  const to = JSON.parse((await call(ctx1.client, 'governance_takeover', { taskId: 't1', workspaceId: wsIdA })).text);
  assert.equal(to.authority.generation, 1);
  const tokenB = to.authority.token;

  const staleApply = await call(ctx1.client, 'edit', { workspaceId: wsIdA, mode: 'apply', changeSetId: preview.changeSetId, taskId: 't1', authorityToken: tokenA });
  assert.equal(staleApply.res.isError, true);
  assert.match(staleApply.text, /stale_authority/);

  // workspace_effect verify requires the current Parent token; read_only verify does not.
  const verifyNoToken = await call(ctx1.client, 'verify', { workspaceId: wsIdA, check: 'touch_marker' });
  assert.equal(verifyNoToken.res.isError, true);
  assert.match(verifyNoToken.text, /stale_authority/);
  const verifyOk = JSON.parse((await call(ctx1.client, 'verify', { workspaceId: wsIdA, check: 'touch_marker', taskId: 't1', authorityToken: tokenB })).text);
  assert.equal(verifyOk.passed, true);
  assert.ok(fs.existsSync(path.join(repoA, 'verify-marker.txt')));
  const roOk = JSON.parse((await call(ctx1.client, 'verify', { workspaceId: wsIdA, check: 'noop' })).text);
  assert.equal(roOk.passed, true);

  // "Restart": old workspace handle (wsIdA) no longer exists; the same canonical root
  // with a refreshed workspaceId + takeover token authorizes a new apply.
  await closeAll(ctx1);
  const ctx2 = await startDurableMcp({ dataRoot: root, roots: [repoA], executor: stub });
  t.after(() => closeAll(ctx2));
  const staleHandle = await call(ctx2.client, 'edit', { workspaceId: wsIdA, mode: 'apply', changeSetId: preview.changeSetId, taskId: 't1', authorityToken: tokenB });
  assert.equal(staleHandle.res.isError, true);
  assert.match(staleHandle.text, /unknown workspaceId|workspaceId/);
  const wsA2 = JSON.parse((await call(ctx2.client, 'workspace_open', { path: repoA })).text);
  assert.notEqual(wsA2.workspaceId, wsIdA);
  assert.equal(path.resolve(wsA2.root), path.resolve(repoA));
  const to2 = JSON.parse((await call(ctx2.client, 'governance_takeover', { taskId: 't1', workspaceId: wsA2.workspaceId })).text);
  const tokenC = to2.authority.token;
  const base2 = computeSha256(fs.readFileSync(file));
  const preview2 = JSON.parse((await call(ctx2.client, 'edit', { workspaceId: wsA2.workspaceId, mode: 'preview', change: { path: 'a.txt', baseHash: base2, replacements: [{ oldText: 'hello2', newText: 'hello3', expectedOccurrences: 1 }] } })).text);
  const apply2 = await call(ctx2.client, 'edit', { workspaceId: wsA2.workspaceId, mode: 'apply', changeSetId: preview2.changeSetId, taskId: 't1', authorityToken: tokenC });
  assert.notEqual(apply2.res.isError, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello3');
});
