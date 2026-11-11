import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDurableGovernanceService } from '../../src/governance/durable.js';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-admission-'));
const launch = (dataRoot, overrides = {}) => createDurableGovernanceService({ dataRoot, ...overrides });

function setup(t, options = {}) {
  const dataRoot = root();
  const workspaceRoot = fs.realpathSync(root());
  const service = launch(dataRoot, options);
  t.after(() => service.close());
  const taskId = 'task-235';
  const plan = service.transition({ taskId, projectKey: 'example/repository', control: 'PLAN', workspaceRoot });
  const authorityToken = plan.authorityToken;
  const ctl = (control = 'TASK') => service.transition({ taskId, control, stepId: 'step-1', route: 'CODEX_DELEGATE',
    workspaceRoot, authorityToken, acceptance: [{ id: 'evidence' }] });
  ctl();
  return { dataRoot, service, taskId, authorityToken, workspaceRoot, ctl };
}

test('accepted control and RESULT advance revision without any execution claim', (t) => {
  const h = setup(t);
  const initial = h.service.store.loadTask(h.taskId);
  assert.equal(initial.authority.executionClaim, null);
  assert.ok(initial.authorizationRevision > 0);
  h.ctl('REVISE');
  const revised = h.service.store.loadTask(h.taskId);
  assert.equal(revised.authorizationRevision, initial.authorizationRevision + 1);
  h.service.recordResult({ taskId: h.taskId, stepId: 'step-1', authorityToken: h.authorityToken,
    executorStatus: 'success', evidence: [{ acceptanceId: 'evidence', status: 'pass' }] });
  const result = h.service.store.loadTask(h.taskId);
  assert.equal(result.authorizationRevision, revised.authorizationRevision + 1);
  assert.equal(result.authority.executionClaim, null);
});
