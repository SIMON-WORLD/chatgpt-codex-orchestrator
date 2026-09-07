import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDurableGovernanceService } from '../../src/governance/durable.js';

function fixture(prefix = 'execution-claim-') {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(dataRoot, 'repo');
  const otherWorkspace = path.join(dataRoot, 'other');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(otherWorkspace, { recursive: true });
  return { dataRoot, workspace, otherWorkspace, namespace: 'default' };
}

function createTask(service, { workspace, taskId = 't1', projectKey = 'repo/x', identity = 'issue-34', stepId = 's1', route = 'CHATGPT_DIRECT_LOCAL', localRoute = null } = {}) {
  const plan = service.transition({ taskId, control: 'PLAN', projectKey, identity, workspaceRoot: workspace });
  const parentToken = plan.authorityToken;
  assert.ok(parentToken);
  const task = service.transition({
    taskId,
    stepId,
    control: 'TASK',
    acceptance: [{ id: 'a1', required: true }],
    route,
    localRoute,
    authorityToken: parentToken,
    workspaceRoot: workspace,
  });
  assert.equal(task.ok, true);
  return { parentToken, taskId, projectKey, identity, stepId };
}

test('Issue #34: claim/re-claim fences bounded sessions while Parent authority stays unchanged', () => {
  const { dataRoot, workspace, namespace } = fixture();
  const d = createDurableGovernanceService({ dataRoot, namespace });
  const ids = createTask(d, { workspace });

  const before = d.store.loadTask(ids.taskId).authority;
  assert.equal(before.generation, 0);
  assert.equal(before.token, ids.parentToken);

  const c1 = d.claimExecution({ projectKey: ids.projectKey, identity: ids.identity, stepId: ids.stepId, workspaceRoot: workspace });
  assert.equal(c1.ok, true);
  assert.equal(c1.executionClaim.generation, 1);
  assert.equal(c1.executionClaim.active, true);
  assert.equal(c1.authority.generation, 0);
  assert.ok(c1.executionToken);

  const c2 = d.claimExecution({ taskId: ids.taskId, stepId: ids.stepId, workspaceRoot: workspace });
  assert.equal(c2.executionClaim.generation, 2);
  assert.notEqual(c2.executionToken, c1.executionToken);
  assert.equal(c2.authority.generation, 0);

  const durableAfterReclaim = d.store.loadTask(ids.taskId).authority;
  assert.equal(durableAfterReclaim.generation, 0);
  assert.equal(durableAfterReclaim.token, ids.parentToken, 'claim never rotates the Parent token');
  assert.equal(durableAfterReclaim.executionClaim.generation, 2);

  assert.throws(
    () => d.authorizeExecution({ taskId: ids.taskId, executionToken: c1.executionToken, workspaceRoot: workspace }),
    (e) => e.code === 'stale_execution_claim',
  );
  const auth = d.authorizeExecution({ taskId: ids.taskId, executionToken: c2.executionToken, workspaceRoot: workspace });
  assert.equal(auth.ok, true);
  assert.equal(auth.stepId, ids.stepId);

  assert.throws(
    () => d.recordResult({ taskId: 'wrong-task', stepId: ids.stepId, executionToken: c2.executionToken, executorStatus: 'success' }),
    (e) => e.code === 'task_mismatch',
  );
  assert.throws(
    () => d.recordResult({ taskId: ids.taskId, stepId: 'wrong-step', executionToken: c2.executionToken, executorStatus: 'success' }),
    (e) => e.code === 'step_mismatch',
  );

  const result = d.recordResult({
    taskId: ids.taskId,
    stepId: ids.stepId,
    executionToken: c2.executionToken,
    executorStatus: 'success',
    evidence: [{ acceptanceId: 'a1', status: 'pass' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.machineGate, 'pass');
  assert.equal(result.executionClaim.active, false, 'same-step RESULT fences the consumed claim');
  assert.throws(
    () => d.authorizeExecution({ taskId: ids.taskId, executionToken: c2.executionToken, workspaceRoot: workspace }),
    (e) => e.code === 'stale_execution_claim',
  );

  // Parent control still uses the original Parent token and re-opens the same step.
  const revise = d.transition({ taskId: ids.taskId, stepId: ids.stepId, control: 'REVISE', authorityToken: ids.parentToken, workspaceRoot: workspace });
  assert.equal(revise.ok, true);
  assert.equal(revise.authority.generation, 0);
  const c3 = d.claimExecution({ taskId: ids.taskId, stepId: ids.stepId, workspaceRoot: workspace });
  assert.equal(c3.executionClaim.active, true);

  // Any later Parent control is a conservative execution-authorization fence.
  const reviseAgain = d.transition({ taskId: ids.taskId, stepId: ids.stepId, control: 'REVISE', authorityToken: ids.parentToken, workspaceRoot: workspace });
  assert.equal(reviseAgain.ok, true);
  assert.equal(reviseAgain.authority.generation, 0);
  assert.throws(
    () => d.authorizeExecution({ taskId: ids.taskId, executionToken: c3.executionToken, workspaceRoot: workspace }),
    (e) => e.code === 'stale_execution_claim',
  );
  const durableFinal = d.store.loadTask(ids.taskId).authority;
  assert.equal(durableFinal.generation, 0);
  assert.equal(durableFinal.token, ids.parentToken);
  d.close();
});

test('Issue #34: execution claims fail closed on wrong step/workspace, ASK_USER, route mismatch and DONE', () => {
  const a = fixture('execution-claim-direct-');
  const d1 = createDurableGovernanceService({ dataRoot: a.dataRoot, namespace: a.namespace });
  const ids = createTask(d1, { workspace: a.workspace });

  assert.throws(
    () => d1.claimExecution({ taskId: ids.taskId, stepId: 'other-step', workspaceRoot: a.workspace }),
    (e) => e.code === 'step_mismatch',
  );
  assert.throws(
    () => d1.claimExecution({ taskId: ids.taskId, stepId: ids.stepId, workspaceRoot: a.otherWorkspace }),
    (e) => e.code === 'workspace_mismatch',
  );

  d1.transition({ taskId: ids.taskId, stepId: ids.stepId, control: 'ASK_USER', whyBlocked: 'need decision', minimalUserAction: 'choose', question: 'continue?', authorityToken: ids.parentToken, workspaceRoot: a.workspace });
  assert.throws(
    () => d1.claimExecution({ taskId: ids.taskId, stepId: ids.stepId, workspaceRoot: a.workspace }),
    (e) => e.code === 'execution_not_claimable',
  );
  d1.close();

  const b = fixture('execution-claim-route-');
  const d2 = createDurableGovernanceService({ dataRoot: b.dataRoot, namespace: b.namespace });
  const codex = createTask(d2, { workspace: b.workspace, identity: 'codex-route', route: 'CODEX_DELEGATE' });
  assert.throws(
    () => d2.claimExecution({ taskId: codex.taskId, stepId: codex.stepId, workspaceRoot: b.workspace }),
    (e) => e.code === 'route_mismatch',
  );
  d2.close();

  const c = fixture('execution-claim-done-');
  const d3 = createDurableGovernanceService({ dataRoot: c.dataRoot, namespace: c.namespace });
  const doneIds = createTask(d3, { workspace: c.workspace, identity: 'done-task' });
  d3.recordResult({
    taskId: doneIds.taskId,
    stepId: doneIds.stepId,
    authorityToken: doneIds.parentToken,
    executorStatus: 'success',
    evidence: [{ acceptanceId: 'a1', status: 'pass' }],
  });
  d3.transition({ taskId: doneIds.taskId, stepId: doneIds.stepId, control: 'DONE', authorityToken: doneIds.parentToken, workspaceRoot: c.workspace });
  assert.throws(
    () => d3.claimExecution({ taskId: doneIds.taskId, stepId: doneIds.stepId, workspaceRoot: c.workspace }),
    (e) => e.code === 'execution_not_claimable',
  );
  d3.close();
});

test('Issue #34: bounded semantic claim refuses missing and ambiguous durable tasks', () => {
  const { dataRoot, workspace, namespace } = fixture('execution-claim-semantic-');
  const d = createDurableGovernanceService({ dataRoot, namespace });

  assert.throws(
    () => d.claimExecution({ projectKey: 'repo/missing', identity: 'missing', stepId: 's1', workspaceRoot: workspace }),
    (e) => e.code === 'not_found',
  );

  const ids = createTask(d, { workspace, projectKey: 'repo/amb', identity: 'same' });
  const env = d.store.loadTask(ids.taskId);
  d.store.saveTask('t2', {
    taskId: 't2',
    projectKey: env.projectKey,
    identity: env.identity,
    workspaceRoot: env.workspaceRoot,
    authority: { ...env.authority, token: 'second-parent-token' },
    state: { ...structuredClone(env.state), taskId: 't2' },
  });

  assert.throws(
    () => d.claimExecution({ projectKey: 'repo/amb', identity: 'same', stepId: 's1', workspaceRoot: workspace }),
    (e) => e.code === 'ambiguous',
  );
  d.close();
});