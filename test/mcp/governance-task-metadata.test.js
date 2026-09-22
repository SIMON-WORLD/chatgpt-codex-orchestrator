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

function fixture(prefix = 'issue149-governance-task-') {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoA = path.join(dataRoot, 'repoA');
  const repoB = path.join(dataRoot, 'repoB');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  return { dataRoot, repoA, repoB };
}

async function startDurable(f) {
  const registry = new WorkspaceRegistry({ allowedRoots: [f.repoA, f.repoB] });
  const governance = createDurableGovernanceService({ dataRoot: f.dataRoot, namespace: 'default' });
  const srv = await startMcpServer({
    workspaceRegistry: registry,
    governanceService: governance,
    host: '127.0.0.1',
    port: 0,
  });
  const client = new Client({ name: 'issue149-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  return { governance, srv, client };
}

async function closeAll(ctx, dataRoot) {
  try { await ctx.client.close(); } catch {}
  try { await ctx.srv.close(); } catch {}
  try { ctx.governance.close(); } catch {}
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {}
}

test('Issue #149: governance_task exposes only the TASK schema with truthful destructive metadata', async (t) => {
  const f = fixture('issue149-descriptor-');
  const ctx = await startDurable(f);
  t.after(() => closeAll(ctx, f.dataRoot));

  const listed = await ctx.client.listTools();
  const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
  const taskTool = byName.governance_task;

  assert.ok(taskTool, 'governance_task must be exposed through the real MCP listTools path');
  assert.deepEqual(taskTool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });
  assert.equal(taskTool.annotations.idempotentHint, undefined);

  assert.deepEqual(
    Object.keys(taskTool.inputSchema.properties || {}).sort(),
    ['acceptance', 'authorityToken', 'localRoute', 'route', 'stepId', 'taskId', 'workspaceId'].sort(),
  );
  assert.deepEqual(
    [...(taskTool.inputSchema.required || [])].sort(),
    ['authorityToken', 'stepId', 'taskId'].sort(),
  );
  assert.equal(taskTool.inputSchema.additionalProperties, false);

  assert.match(taskTool.description, /hard-ready/iu);
  assert.match(taskTool.description, /executorStatus=success/iu);
  assert.match(taskTool.description, /machineGate=pass/iu);
  assert.match(taskTool.description, /brainAcceptance='accepted'/iu);
  assert.match(taskTool.description, /mutates durable Governance control\/task-step state/iu);
  assert.match(taskTool.description, /fences any prior bounded execution claim/iu);
  assert.match(taskTool.description, /does not directly mutate workspace file contents/iu);

  assert.ok(byName.governance_transition, 'generic governance_transition must remain exposed');
  assert.deepEqual(byName.governance_transition.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(
    byName.governance_transition.inputSchema.properties.control.enum,
    ['PLAN', 'TASK', 'REVISE', 'REPLAN', 'ASK_USER', 'PUBLISH', 'DONE'],
  );
  assert.ok(byName.governance_transition.inputSchema.properties.reviseDelta);
  assert.ok(byName.governance_plan);
  assert.ok(byName.governance_record_result);
  assert.ok(byName.governance_claim_execution);
  assert.ok(byName.governance_recover);
  assert.ok(byName.governance_takeover);
});

test('Issue #149: TASK-only wrapper preserves durable TASK authority, lifecycle, routing, and fencing semantics', async (t) => {
  const f = fixture('issue149-lifecycle-');
  const ctx = await startDurable(f);
  t.after(() => closeAll(ctx, f.dataRoot));

  const wsA = parse(await call(ctx.client, 'workspace_open', { path: f.repoA }));
  const wsB = parse(await call(ctx.client, 'workspace_open', { path: f.repoB }));

  const plan = parse(await call(ctx.client, 'governance_plan', {
    taskId: 'issue-149-task',
    projectKey: 'simon-world/chatgpt-codex-orchestrator',
    identity: 'issue-149',
    workspaceId: wsA.workspaceId,
    route: 'CHATGPT_DIRECT_LOCAL',
  }));
  const parentToken = plan.authorityToken;
  assert.ok(parentToken);

  // Keep the heterogeneous action live and unchanged: it creates the first TASK.
  const first = parse(await call(ctx.client, 'governance_transition', {
    taskId: 'issue-149-task',
    stepId: 's1',
    control: 'TASK',
    acceptance: [{ id: 'a1', required: true }],
    route: 'CHATGPT_DIRECT_LOCAL',
    authorityToken: parentToken,
    workspaceId: wsA.workspaceId,
  }));
  assert.equal(first.ok, true);

  const claim1 = parse(await call(ctx.client, 'governance_claim_execution', {
    taskId: 'issue-149-task',
    stepId: 's1',
    workspaceId: wsA.workspaceId,
  }));
  assert.ok(claim1.executionToken);

  const notReady = await call(ctx.client, 'governance_task', {
    taskId: 'issue-149-task',
    stepId: 's2',
    authorityToken: parentToken,
    workspaceId: wsA.workspaceId,
    acceptance: [{ id: 'a2', required: true }],
  });
  assert.equal(notReady.res.isError, true, 'prior step must be hard-ready before advancing');

  const missingAuthority = await call(ctx.client, 'governance_task', {
    taskId: 'issue-149-task',
    stepId: 's2',
    workspaceId: wsA.workspaceId,
  });
  assert.equal(missingAuthority.res.isError, true, 'missing Parent authority must fail closed');

  const executionAsParent = await call(ctx.client, 'governance_task', {
    taskId: 'issue-149-task',
    stepId: 's2',
    authorityToken: claim1.executionToken,
    workspaceId: wsA.workspaceId,
  });
  assert.equal(executionAsParent.res.isError, true);
  assert.match(executionAsParent.text, /stale_authority/);

  const explicitExecutionField = await call(ctx.client, 'governance_task', {
    taskId: 'issue-149-task',
    stepId: 's2',
    authorityToken: parentToken,
    executionToken: claim1.executionToken,
    workspaceId: wsA.workspaceId,
  });
  assert.equal(explicitExecutionField.res.isError, true, 'executionToken is not in the public TASK schema');

  const wrongWorkspace = await call(ctx.client, 'governance_task', {
    taskId: 'issue-149-task',
    stepId: 's2',
    authorityToken: parentToken,
    workspaceId: wsB.workspaceId,
  });
  assert.equal(wrongWorkspace.res.isError, true);
  assert.match(wrongWorkspace.text, /workspace_mismatch/);

  const result1 = parse(await call(ctx.client, 'governance_record_result', {
    taskId: 'issue-149-task',
    stepId: 's1',
    executionToken: claim1.executionToken,
    executorStatus: 'success',
    evidence: [{ acceptanceId: 'a1', status: 'pass' }],
  }));
  assert.equal(result1.machineGate, 'pass');
  assert.equal(result1.executionClaim.active, false);

  const second = parse(await call(ctx.client, 'governance_task', {
    taskId: 'issue-149-task',
    stepId: 's2',
    authorityToken: parentToken,
    workspaceId: wsA.workspaceId,
    route: 'HYBRID',
    localRoute: 'CHATGPT_DIRECT_LOCAL',
    acceptance: [{ id: 'a2', required: true, requiredEvidenceLevel: 'independent' }],
  }));
  assert.equal(second.ok, true);
  assert.equal(second.control, 'TASK');
  assert.equal(second.executionClaim.active, false);

  const status = parse(await call(ctx.client, 'governance_status', {}));
  assert.equal(status.previousStepId, 's1');
  assert.equal(status.currentStepId, 's2');
  assert.ok(status.acceptedSteps.includes('s1'));
  assert.equal(status.steps.s1.brainAcceptance, 'accepted');
  assert.equal(status.steps.s2.executorStatus, 'unknown');
  assert.equal(status.steps.s2.machineGate, 'pending');
  assert.equal(status.route, 'HYBRID');
  assert.equal(status.localRoute, 'CHATGPT_DIRECT_LOCAL');
  assert.equal(status.history.at(-1).control, 'TASK');

  const fencedOldClaim = await call(ctx.client, 'governance_record_result', {
    taskId: 'issue-149-task',
    stepId: 's1',
    executionToken: claim1.executionToken,
    executorStatus: 'success',
  });
  assert.equal(fencedOldClaim.res.isError, true);
  assert.match(fencedOldClaim.text, /stale_execution_claim/);

  const recovered = parse(await call(ctx.client, 'governance_recover', {
    projectKey: 'simon-world/chatgpt-codex-orchestrator',
    identity: 'issue-149',
  }));
  assert.equal(recovered.taskId, 'issue-149-task');
  assert.equal(recovered.control, 'TASK');

  const claim2 = parse(await call(ctx.client, 'governance_claim_execution', {
    taskId: 'issue-149-task',
    stepId: 's2',
    workspaceId: wsA.workspaceId,
  }));
  assert.ok(claim2.executionToken);
  assert.equal(claim2.executionClaim.active, true);

  const result2 = parse(await call(ctx.client, 'governance_record_result', {
    taskId: 'issue-149-task',
    stepId: 's2',
    executionToken: claim2.executionToken,
    executorStatus: 'success',
    evidence: [{ acceptanceId: 'a2', status: 'pass', evidenceLevel: 'independent' }],
  }));
  assert.equal(result2.machineGate, 'pass');

  const resultBearingReissue = await call(ctx.client, 'governance_task', {
    taskId: 'issue-149-task',
    stepId: 's2',
    authorityToken: parentToken,
    workspaceId: wsA.workspaceId,
    route: 'CHATGPT_DIRECT_LOCAL',
  });
  assert.equal(resultBearingReissue.res.isError, true, 'TASK reissue on a result-bearing current step must remain blocked');

  const takeover = parse(await call(ctx.client, 'governance_takeover', {
    taskId: 'issue-149-task',
    authorityToken: parentToken,
    workspaceId: wsA.workspaceId,
  }));
  assert.equal(takeover.ok, true);
  assert.equal(takeover.authority.generation, 1);
  assert.ok(takeover.authority.token);

  const staleParent = await call(ctx.client, 'governance_task', {
    taskId: 'issue-149-task',
    stepId: 's3',
    authorityToken: parentToken,
    workspaceId: wsA.workspaceId,
  });
  assert.equal(staleParent.res.isError, true);
  assert.match(staleParent.text, /stale_authority/);

  const finalStatus = parse(await call(ctx.client, 'governance_status', {}));
  assert.equal(finalStatus.currentStepId, 's2');
  assert.equal(finalStatus.steps.s2.machineGate, 'pass');
});
