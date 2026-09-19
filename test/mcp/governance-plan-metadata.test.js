import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { createDurableGovernanceService } from '../../src/governance/durable.js';

function textOf(res) {
  const t = res && res.content && res.content.find((c) => c.type === 'text');
  return t ? t.text : '';
}

function fixture(prefix = 'govplan-') {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoA = path.join(dataRoot, 'repoA');
  const repoB = path.join(dataRoot, 'repoB');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  return { dataRoot, repoA, repoB };
}

async function startDurable({ dataRoot, roots }) {
  const registry = new WorkspaceRegistry({ allowedRoots: roots });
  const governance = createDurableGovernanceService({ dataRoot, namespace: 'default' });
  const srv = await startMcpServer({
    workspaceRegistry: registry,
    governanceService: governance,
    host: '127.0.0.1',
    port: 0,
  });
  const client = new Client({ name: 'issue-111-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  return { governance, srv, client };
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

test('Issue #111: governance_plan is risk-homogeneous and persists the same durable PLAN state', async (t) => {
  const f = fixture();
  const ctx = await startDurable({ dataRoot: f.dataRoot, roots: [f.repoA, f.repoB] });
  t.after(() => closeAll(ctx));

  const listed = await ctx.client.listTools();
  const planTool = listed.tools.find((x) => x.name === 'governance_plan');
  const transitionTool = listed.tools.find((x) => x.name === 'governance_transition');
  assert.ok(planTool);
  assert.deepEqual(planTool.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  });
  assert.equal(planTool.annotations.idempotentHint, undefined);
  assert.ok(transitionTool);
  assert.deepEqual(transitionTool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });

  const ws = JSON.parse((await call(ctx.client, 'workspace_open', { path: f.repoA })).text);
  const plan = JSON.parse((await call(ctx.client, 'governance_plan', {
    taskId: 'issue-111-plan',
    projectKey: 'simon-world/repo',
    identity: 'issue-111',
    workspaceId: ws.workspaceId,
    route: 'CODEX_DELEGATE',
  })).text);

  assert.equal(plan.ok, true);
  assert.equal(plan.control, 'PLAN');
  assert.equal(plan.nextAction, 'task');
  assert.equal(plan.workspaceRoot, fs.realpathSync.native(f.repoA));
  assert.ok(plan.authorityToken);
  assert.equal(plan.authority.generation, 0);

  const status = JSON.parse((await call(ctx.client, 'governance_status', {})).text);
  assert.equal(status.taskId, 'issue-111-plan');
  assert.equal(status.control, 'PLAN');
  assert.equal(status.planned, true);
  assert.equal(status.route, 'CODEX_DELEGATE');
  assert.equal(status.workspaceRoot, fs.realpathSync.native(f.repoA));
  assert.equal(status.authority.generation, 0);

  await closeAll(ctx);
  const ctx2 = await startDurable({ dataRoot: f.dataRoot, roots: [f.repoA, f.repoB] });
  t.after(() => closeAll(ctx2));
  const recovered = JSON.parse((await call(ctx2.client, 'governance_recover', {
    projectKey: 'simon-world/repo',
    identity: 'issue-111',
  })).text);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.taskId, 'issue-111-plan');
  assert.equal(recovered.control, 'PLAN');
});

test('Issue #111: fresh PLAN admission conflict and repeated unauthorized calls still fail closed', async (t) => {
  const f = fixture('govplan-conflict-');
  const ctx1 = await startDurable({ dataRoot: f.dataRoot, roots: [f.repoA] });
  const first = JSON.parse((await call(ctx1.client, 'governance_plan', {
    taskId: 'active-task',
    projectKey: 'repo/x',
    identity: 'active',
  })).text);
  assert.ok(first.authorityToken);
  await closeAll(ctx1);

  const ctx2 = await startDurable({ dataRoot: f.dataRoot, roots: [f.repoA] });
  t.after(() => closeAll(ctx2));

  const conflict = await call(ctx2.client, 'governance_plan', {
    taskId: 'new-task',
    projectKey: 'repo/x',
    identity: 'new',
  });
  assert.equal(conflict.res.isError, true);
  assert.match(conflict.text, /recovery_required/);

  const repeatedUnauthorized = await call(ctx2.client, 'governance_plan', {
    taskId: 'active-task',
    projectKey: 'repo/x',
    identity: 'active',
  });
  assert.equal(repeatedUnauthorized.res.isError, true);
  assert.match(repeatedUnauthorized.text, /stale_authority/);

  const recovered = JSON.parse((await call(ctx2.client, 'governance_recover', {
    taskId: 'active-task',
  })).text);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.control, 'PLAN');

  const repeatedAuthorized = JSON.parse((await call(ctx2.client, 'governance_plan', {
    taskId: 'active-task',
    projectKey: 'repo/x',
    identity: 'active',
    authorityToken: first.authorityToken,
  })).text);
  assert.equal(repeatedAuthorized.ok, true);
  assert.equal(repeatedAuthorized.nextAction, 'task');
  assert.equal(repeatedAuthorized.authority.generation, 0);
  const repeatedStatus = JSON.parse((await call(ctx2.client, 'governance_status', {})).text);
  assert.equal(repeatedStatus.history.filter((entry) => entry.control === 'PLAN').length, 2);
});

test('Issue #111: bounded execution claims cannot authorize governance_plan', async (t) => {
  const f = fixture('govplan-claim-');
  const ctx = await startDurable({ dataRoot: f.dataRoot, roots: [f.repoA] });
  t.after(() => closeAll(ctx));

  const ws = JSON.parse((await call(ctx.client, 'workspace_open', { path: f.repoA })).text);
  const plan = JSON.parse((await call(ctx.client, 'governance_plan', {
    taskId: 'task-claim',
    projectKey: 'repo/x',
    identity: 'claim',
    workspaceId: ws.workspaceId,
  })).text);

  const task = JSON.parse((await call(ctx.client, 'governance_transition', {
    taskId: 'task-claim',
    stepId: 's1',
    control: 'TASK',
    acceptance: [{ id: 'a1', required: true }],
    route: 'CHATGPT_DIRECT_LOCAL',
    authorityToken: plan.authorityToken,
    workspaceId: ws.workspaceId,
  })).text);
  assert.equal(task.ok, true);

  const claim = JSON.parse((await call(ctx.client, 'governance_claim_execution', {
    taskId: 'task-claim',
    stepId: 's1',
    workspaceId: ws.workspaceId,
  })).text);
  assert.ok(claim.executionToken);

  const smuggled = await call(ctx.client, 'governance_plan', {
    taskId: 'task-claim',
    workspaceId: ws.workspaceId,
    authorityToken: claim.executionToken,
  });
  assert.equal(smuggled.res.isError, true);
  assert.match(smuggled.text, /stale_authority/);

  const explicitExecutionField = await call(ctx.client, 'governance_plan', {
    taskId: 'task-claim',
    workspaceId: ws.workspaceId,
    executionToken: claim.executionToken,
  });
  assert.equal(explicitExecutionField.res.isError, true);

  const status = JSON.parse((await call(ctx.client, 'governance_status', {})).text);
  assert.equal(status.taskId, 'task-claim');
  assert.equal(status.control, 'TASK');
  assert.equal(status.planned, true);
});

test('Issue #111: unsafe identity and workspace rebinding remain rejected before PLAN mutation', async (t) => {
  const f = fixture('govplan-identity-');
  const ctx = await startDurable({ dataRoot: f.dataRoot, roots: [f.repoA, f.repoB] });
  t.after(() => closeAll(ctx));

  const unsafe = await call(ctx.client, 'governance_plan', {
    taskId: '..',
    projectKey: 'repo/x',
    identity: 'unsafe',
  });
  assert.equal(unsafe.res.isError, true);

  const wsA = JSON.parse((await call(ctx.client, 'workspace_open', { path: f.repoA })).text);
  const wsB = JSON.parse((await call(ctx.client, 'workspace_open', { path: f.repoB })).text);
  const plan = JSON.parse((await call(ctx.client, 'governance_plan', {
    taskId: 'bound-task',
    projectKey: 'repo/x',
    identity: 'bound',
    workspaceId: wsA.workspaceId,
  })).text);

  const wrongWorkspace = await call(ctx.client, 'governance_plan', {
    taskId: 'bound-task',
    projectKey: 'repo/x',
    identity: 'bound',
    workspaceId: wsB.workspaceId,
    authorityToken: plan.authorityToken,
  });
  assert.equal(wrongWorkspace.res.isError, true);
  assert.match(wrongWorkspace.text, /workspace_mismatch/);

  const missingWorkspace = await call(ctx.client, 'governance_plan', {
    taskId: 'other-task',
    workspaceId: 'missing-workspace',
  });
  assert.equal(missingWorkspace.res.isError, true);
  assert.match(missingWorkspace.text, /workspace/i);

  const status = JSON.parse((await call(ctx.client, 'governance_status', {})).text);
  assert.equal(status.taskId, 'bound-task');
  assert.equal(status.control, 'PLAN');
  assert.equal(status.planned, true);
  assert.equal(status.workspaceRoot, fs.realpathSync.native(f.repoA));
});
