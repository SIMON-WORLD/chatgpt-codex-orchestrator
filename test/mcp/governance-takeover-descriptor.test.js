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
  const item = res && res.content && res.content.find((c) => c.type === 'text');
  return item ? item.text : '';
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return { res, text: textOf(res) };
}

function parse(result) {
  return JSON.parse(result.text);
}

function fixture(prefix = 'issue153-governance-takeover-') {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoA = path.join(dataRoot, 'repoA');
  const repoB = path.join(dataRoot, 'repoB');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  return { dataRoot, repoA, repoB };
}

async function startDurable(f, { appServerExecutor = null } = {}) {
  const registry = new WorkspaceRegistry({ allowedRoots: [f.repoA, f.repoB] });
  const governance = createDurableGovernanceService({ dataRoot: f.dataRoot, namespace: 'default' });
  const srv = await startMcpServer({
    workspaceRegistry: registry,
    governanceService: governance,
    appServerExecutor,
    host: '127.0.0.1',
    port: 0,
  });
  const client = new Client({ name: 'issue153-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  return { registry, governance, srv, client };
}

async function closeAll(ctx, dataRoot) {
  try { await ctx.client.close(); } catch {}
  try { await ctx.srv.close(); } catch {}
  try { ctx.governance.close(); } catch {}
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {}
}

test('Issue #153: governance_takeover exposes truthful destructive closed-world metadata and a strict five-field schema', async (t) => {
  const f = fixture('issue153-descriptor-');
  const ctx = await startDurable(f);
  t.after(() => closeAll(ctx, f.dataRoot));

  const listed = await ctx.client.listTools();
  const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
  const takeover = byName.governance_takeover;

  assert.ok(takeover, 'governance_takeover must be exposed through the real MCP listTools path');
  assert.deepEqual(takeover.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });
  assert.equal(takeover.annotations.idempotentHint, undefined);

  assert.deepEqual(
    Object.keys(takeover.inputSchema.properties || {}).sort(),
    ['taskId', 'projectKey', 'identity', 'authorityToken', 'workspaceId'].sort(),
  );
  assert.deepEqual([...(takeover.inputSchema.required || [])].sort(), []);
  assert.equal(takeover.inputSchema.additionalProperties, false);

  assert.match(takeover.description, /Parent continuity re-entry/iu);
  assert.match(takeover.description, /exactly one uniquely resolved durable Governance task/iu);
  assert.match(takeover.description, /at least one semantic selector among taskId\/projectKey\/identity/iu);
  assert.match(takeover.description, /increments\/rotates the durable Parent authority generation/iu);
  assert.match(takeover.description, /mints a new opaque Parent token/iu);
  assert.match(takeover.description, /fences prior Parent authority/iu);
  assert.match(takeover.description, /fences any prior bounded Direct Local execution claim/iu);
  assert.match(takeover.description, /authorityToken is optional/iu);
  assert.match(takeover.description, /current\/stale-authority guard/iu);
  assert.match(takeover.description, /not a required Human handoff credential/iu);
  assert.match(takeover.description, /workspaceId is optional/iu);
  assert.match(takeover.description, /canonical workspace validation\/binding selector/iu);
  assert.match(takeover.description, /existing bounded Codex recovery path/iu);
  assert.match(takeover.description, /bounded Context Capsule and execution summary/iu);
  assert.match(takeover.description, /uses only the existing recover path/iu);
  assert.match(takeover.description, /failure\/recovery-required after authority rotation is already committed/iu);
  assert.match(takeover.description, /authority rotation is not rolled back/iu);
  assert.match(takeover.description, /Bounded execution claims never authorize takeover/iu);

  const unknown = await call(ctx.client, 'governance_takeover', {
    taskId: 'issue-153-unknown',
    unexpectedTopLevelField: true,
  });
  assert.equal(unknown.res.isError, true, 'unknown top-level fields must fail at the MCP schema boundary');

  assert.ok(byName.governance_recover);
  assert.deepEqual(byName.governance_recover.annotations, { readOnlyHint: true });
  assert.deepEqual(
    Object.keys(byName.governance_recover.inputSchema.properties || {}).sort(),
    ['identity', 'projectKey', 'taskId'].sort(),
  );

  assert.ok(byName.governance_claim_execution);
  assert.deepEqual(byName.governance_claim_execution.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
  });
  assert.deepEqual(
    Object.keys(byName.governance_claim_execution.inputSchema.properties || {}).sort(),
    ['identity', 'projectKey', 'stepId', 'taskId', 'workspaceId'].sort(),
  );

  assert.ok(byName.governance_task);
  assert.deepEqual(byName.governance_task.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(
    Object.keys(byName.governance_task.inputSchema.properties || {}).sort(),
    ['acceptance', 'authorityToken', 'localRoute', 'route', 'stepId', 'taskId', 'workspaceId'].sort(),
  );

  assert.ok(byName.governance_transition);
  assert.deepEqual(byName.governance_transition.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(
    byName.governance_transition.inputSchema.properties.control.enum,
    ['PLAN', 'TASK', 'REVISE', 'REPLAN', 'ASK_USER', 'PUBLISH', 'DONE'],
  );
});

test('Issue #153: takeover preserves selector, Parent/execution-claim fencing, workspace binding, and Context Capsule semantics', async (t) => {
  const f = fixture('issue153-lifecycle-');
  const ctx = await startDurable(f);
  t.after(() => closeAll(ctx, f.dataRoot));

  const wsA = parse(await call(ctx.client, 'workspace_open', { path: f.repoA }));
  const wsB = parse(await call(ctx.client, 'workspace_open', { path: f.repoB }));

  const plan = parse(await call(ctx.client, 'governance_plan', {
    taskId: 'issue-153-task',
    projectKey: 'simon-world/chatgpt-codex-orchestrator',
    identity: 'issue-153',
    workspaceId: wsA.workspaceId,
    route: 'CHATGPT_DIRECT_LOCAL',
  }));
  const parentTokenA = plan.authorityToken;
  assert.ok(parentTokenA);

  const task = parse(await call(ctx.client, 'governance_transition', {
    taskId: 'issue-153-task',
    stepId: 's1',
    control: 'TASK',
    acceptance: [{ id: 'a1', required: true }],
    route: 'CHATGPT_DIRECT_LOCAL',
    authorityToken: parentTokenA,
    workspaceId: wsA.workspaceId,
  }));
  assert.equal(task.ok, true);

  const claimA = parse(await call(ctx.client, 'governance_claim_execution', {
    taskId: 'issue-153-task',
    stepId: 's1',
    workspaceId: wsA.workspaceId,
  }));
  assert.ok(claimA.executionToken);
  assert.equal(claimA.executionClaim.active, true);

  const exact = parse(await call(ctx.client, 'governance_takeover', {
    taskId: 'issue-153-task',
    authorityToken: parentTokenA,
    workspaceId: wsA.workspaceId,
  }));
  assert.equal(exact.ok, true);
  assert.equal(exact.taskId, 'issue-153-task');
  assert.equal(exact.authority.generation, 1);
  assert.ok(exact.authority.token);
  assert.equal(exact.executionClaim.active, false, 'takeover must fence the prior bounded execution claim');
  assert.equal(exact.capsule.kind, 'brain-continuity.context-capsule');
  assert.equal(exact.capsule.taskId, 'issue-153-task');
  assert.equal(exact.capsule.authority.generation, 1);
  assert.ok(exact.execution, 'takeover returns the execution summary alongside the Context Capsule');
  const parentTokenB = exact.authority.token;

  const fencedClaim = await call(ctx.client, 'governance_record_result', {
    taskId: 'issue-153-task',
    stepId: 's1',
    executionToken: claimA.executionToken,
    executorStatus: 'success',
    evidence: [{ acceptanceId: 'a1', status: 'pass' }],
  });
  assert.equal(fencedClaim.res.isError, true);
  assert.match(fencedClaim.text, /stale_execution_claim/iu);

  const staleParent = await call(ctx.client, 'governance_takeover', {
    taskId: 'issue-153-task',
    authorityToken: parentTokenA,
    workspaceId: wsA.workspaceId,
  });
  assert.equal(staleParent.res.isError, true);
  assert.match(staleParent.text, /stale_authority/iu);

  const wrongWorkspace = await call(ctx.client, 'governance_takeover', {
    taskId: 'issue-153-task',
    authorityToken: parentTokenB,
    workspaceId: wsB.workspaceId,
  });
  assert.equal(wrongWorkspace.res.isError, true);
  assert.match(wrongWorkspace.text, /workspace_mismatch/iu);

  const semantic = parse(await call(ctx.client, 'governance_takeover', {
    projectKey: 'simon-world/chatgpt-codex-orchestrator',
    identity: 'issue-153',
    authorityToken: parentTokenB,
    workspaceId: wsA.workspaceId,
  }));
  assert.equal(semantic.ok, true);
  assert.equal(semantic.taskId, 'issue-153-task');
  assert.equal(semantic.authority.generation, 2);
  const parentTokenC = semantic.authority.token;

  const missingSelector = await call(ctx.client, 'governance_takeover', {
    authorityToken: parentTokenC,
    workspaceId: wsA.workspaceId,
  });
  assert.equal(missingSelector.res.isError, true);
  assert.match(missingSelector.text, /bad_request|semantic recovery requires/iu);

  const claimC = parse(await call(ctx.client, 'governance_claim_execution', {
    projectKey: 'simon-world/chatgpt-codex-orchestrator',
    identity: 'issue-153',
    stepId: 's1',
    workspaceId: wsA.workspaceId,
  }));
  assert.ok(claimC.executionToken);

  const executionClaimAsParent = await call(ctx.client, 'governance_takeover', {
    taskId: 'issue-153-task',
    authorityToken: claimC.executionToken,
    workspaceId: wsA.workspaceId,
  });
  assert.equal(executionClaimAsParent.res.isError, true);
  assert.match(executionClaimAsParent.text, /stale_authority/iu);

  const status = parse(await call(ctx.client, 'governance_status', {}));
  assert.equal(status.authority.generation, 2, 'failed guards must not rotate Parent authority');
  assert.equal(status.executionClaim.active, true, 'failed takeover must not fence a still-current execution claim');
});

test('Issue #153: MCP takeover keeps Codex reconciliation on recover and commits authority rotation before reconciliation failure', async (t) => {
  const f = fixture('issue153-reconcile-');
  const registry = new WorkspaceRegistry({ allowedRoots: [f.repoA, f.repoB] });
  const governance = createDurableGovernanceService({ dataRoot: f.dataRoot, namespace: 'default' });

  const plan = governance.transition({
    taskId: 'issue-153-codex',
    control: 'PLAN',
    projectKey: 'simon-world/chatgpt-codex-orchestrator',
    identity: 'issue-153-codex',
    workspaceRoot: f.repoA,
  });
  governance.transition({
    taskId: 'issue-153-codex',
    stepId: 's1',
    control: 'TASK',
    acceptance: [{ id: 'a1', required: true }],
    route: 'CODEX_DELEGATE',
    authorityToken: plan.authorityToken,
    workspaceRoot: f.repoA,
  });

  const calls = [];
  const executor = {
    owner: null,
    async recover(opts) {
      calls.push({
        action: 'recover',
        opts,
        authorityGenerationAtRecover: governance.status().authority.generation,
      });
      throw new Error('expected reconciliation failure');
    },
    async start(opts) { calls.push({ action: 'start', opts }); return { jobId: 'unexpected-start' }; },
    async continue(opts) { calls.push({ action: 'continue', opts }); return {}; },
    async interrupt(opts) { calls.push({ action: 'interrupt', opts }); return {}; },
  };

  const srv = await startMcpServer({
    workspaceRegistry: registry,
    governanceService: governance,
    appServerExecutor: executor,
    host: '127.0.0.1',
    port: 0,
  });
  const client = new Client({ name: 'issue153-reconcile-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  const ctx = { registry, governance, srv, client };
  t.after(() => closeAll(ctx, f.dataRoot));

  const wsA = parse(await call(client, 'workspace_open', { path: f.repoA }));
  const takeover = parse(await call(client, 'governance_takeover', {
    projectKey: 'simon-world/chatgpt-codex-orchestrator',
    identity: 'issue-153-codex',
    authorityToken: plan.authorityToken,
    workspaceId: wsA.workspaceId,
  }));

  assert.equal(takeover.ok, true);
  assert.equal(takeover.authority.generation, 1);
  assert.equal(takeover.execution.attempted, true);
  assert.equal(takeover.execution.reconciled, false);
  assert.equal(takeover.execution.action, 'recover');
  assert.match(takeover.execution.error.message, /expected reconciliation failure/iu);
  assert.deepEqual(calls.map((entry) => entry.action), ['recover'], 'takeover reconciliation must use only recover');
  assert.equal(calls[0].authorityGenerationAtRecover, 1, 'authority rotation must commit before recover reconciliation starts');
  assert.equal(calls[0].opts.taskId, 'issue-153-codex');
  assert.equal(calls[0].opts.stepId, 's1');
  assert.equal(calls[0].opts.identity, 'issue-153-codex');

  const status = parse(await call(client, 'governance_status', {}));
  assert.equal(status.authority.generation, 1, 'reconciliation failure must not roll back the committed authority rotation');
});
