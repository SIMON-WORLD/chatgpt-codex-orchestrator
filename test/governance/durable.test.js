import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDurableGovernanceService, GovernanceWriterError, GovernanceWriterGuard } from '../../src/governance/durable.js';
import { GovernanceStoreError } from '../../src/governance/store.js';
import { loadV02Config } from '../../src/config.js';
import { GovernanceError } from '../../src/governance/index.js';
import { createProofLedger } from '../../src/direct-governance.js';

function fixture(prefix = 'durable-') {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dataRoot, namespace: 'default' };
}

function statusCore(status) {
  return {
    taskId: status.taskId,
    control: status.control,
    route: status.route,
    localRoute: status.localRoute,
    currentStepId: status.currentStepId,
    previousStepId: status.previousStepId,
    steps: status.steps,
    acceptedSteps: status.acceptedSteps,
    publicationRequired: status.publicationRequired,
    published: status.published,
    awaitingUser: status.awaitingUser,
    planned: status.planned,
  };
}

function driveToResult(service, { taskId = 't1', projectKey = 'simon-world/repo', identity = 'issue-1', stepId = 's1', acceptanceId = 'a1', route = 'CODEX_DELEGATE' } = {}) {
  const plan = service.transition({ taskId, control: 'PLAN', projectKey, identity });
  const token = plan.authorityToken;
  assert.ok(token, 'PLAN mints an authority token');
  const task = service.transition({ taskId, stepId, control: 'TASK', acceptance: [{ id: acceptanceId, required: true }], route, authorityToken: token });
  assert.equal(task.ok, true);
  const res = service.recordResult({ taskId, stepId, executorStatus: 'success', evidence: [{ acceptanceId, status: 'pass' }], authorityToken: token });
  assert.equal(res.machineGate, 'pass');
  return { token };
}

test('restart restores authoritative Governance state (task/step/acceptance/evidence/gates)', () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  driveToResult(r1, {});
  const before = statusCore(r1.status());
  assert.equal(before.steps.s1.executorStatus, 'success');
  assert.equal(before.steps.s1.machineGate, 'pass');
  assert.equal(before.steps.s1.evidence.length, 1);
  r1.close();

  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  const ld = r2.loadTask('t1');
  assert.equal(ld.ok, true);
  assert.equal(ld.control, 'TASK');
  assert.equal(ld.terminal, false);
  assert.equal(ld.authority.generation, 0);
  const after = statusCore(r2.status());
  assert.deepEqual(after, before);
  // Semantic recovery also resolves the single in-progress task.
  const rec = r2.recoverSemantic({ projectKey: 'simon-world/repo', identity: 'issue-1' });
  assert.equal(rec.ok, true);
  assert.equal(rec.taskId, 't1');
  r2.close();
});

test('DONE remains terminal after restart; non-DONE mutations are rejected', () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  const { token } = driveToResult(r1, {});
  const done = r1.transition({ taskId: 't1', stepId: 's1', control: 'DONE', authorityToken: token });
  assert.equal(done.ok, true);
  r1.close();

  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  const ld = r2.loadTask('t1');
  assert.equal(ld.terminal, true);
  assert.equal(ld.control, 'DONE');
  const to = r2.takeover({ taskId: 't1' });
  assert.equal(to.ok, true);
  const tokenB = to.authority.token;
  const terminalState = statusCore(r2.status());
  // Repeated DONE is idempotent on the terminal task.
  const done2 = r2.transition({ taskId: 't1', stepId: 's1', control: 'DONE', authorityToken: tokenB });
  assert.equal(done2.ok, true);
  assert.equal(done2.control, 'DONE');
  assert.deepEqual(statusCore(r2.status()), terminalState);
  // Non-DONE mutations are rejected and the state stays unchanged.
  for (const ctl of ['TASK', 'REVISE', 'REPLAN', 'PUBLISH']) {
    assert.throws(() => r2.transition({ taskId: 't1', stepId: 's1', control: ctl, authorityToken: tokenB }), /DONE is terminal|terminal/);
  }
  assert.throws(() => r2.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }], authorityToken: tokenB }), /terminal after DONE/);
  assert.deepEqual(statusCore(r2.status()), terminalState);
  r2.close();
});

test('a RESULT-bearing step is not silently re-executed after restart (TASK reissue blocked)', () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  driveToResult(r1, {});
  r1.close();

  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  r2.loadTask('t1');
  const to = r2.takeover({ taskId: 't1' });
  const tokenB = to.authority.token;
  const reissue = r2.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }], authorityToken: tokenB });
  assert.equal(reissue.blocked, true);
  assert.equal(reissue.nextAction, 'blocked_task_reissue');
  const st = r2.status();
  assert.equal(st.steps.s1.executorStatus, 'success');
  assert.equal(st.steps.s1.machineGate, 'pass');
  assert.equal(st.steps.s1.evidence.length, 1);
  r2.close();
});

test('ASK_USER survives restart and remains blocked (not fresh executable state)', () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  const plan = r1.transition({ taskId: 't1', control: 'PLAN', projectKey: 'simon-world/repo', identity: 'issue-1' });
  const token = plan.authorityToken;
  r1.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }], authorityToken: token });
  r1.transition({ taskId: 't1', stepId: 's1', control: 'ASK_USER', whyBlocked: 'need a decision', minimalUserAction: 'pick an option', question: 'which approach?', authorityToken: token });
  assert.equal(r1.status().awaitingUser, true);
  r1.close();

  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  r2.loadTask('t1');
  const st = r2.status();
  assert.equal(st.awaitingUser, true);
  assert.equal(st.control, 'ASK_USER');
  assert.equal(st.askUser.question, 'which approach?');
  assert.equal(st.askUser.minimalUserAction, 'pick an option');
  assert.equal(st.currentStepId, 's1');
  assert.equal(st.steps.s1.executorStatus, 'unknown'); // not silently executed
  const to = r2.takeover({ taskId: 't1' });
  const tokenB = to.authority.token;
  assert.equal(to.capsule.nextSafeAction, 'await_user_decision');
  assert.equal(r2.status().awaitingUser, true); // takeover does not un-block ASK_USER
  // The ASK_USER step stays non-executable: no executor RESULT exists, so the Brain
  // cannot advance to a new step and DONE cannot pass without a machine-gated RESULT.
  assert.throws(() => r2.transition({ taskId: 't1', stepId: 's2', control: 'TASK', authorityToken: tokenB }), /cannot advance from step/);
  const st2 = r2.status();
  assert.equal(st2.steps.s1.executorStatus, 'unknown');
  assert.equal(st2.steps.s1.machineGate, 'pending');
  r2.close();
});

test('recovery-required (unfinished delegated execution) survives restart and stays blocked', () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  const plan = r1.transition({ taskId: 't1', control: 'PLAN', projectKey: 'simon-world/repo', identity: 'issue-exec' });
  const token = plan.authorityToken;
  r1.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }], route: 'CODEX_DELEGATE', authorityToken: token });
  r1.close();

  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  const ld = r2.loadTask('t1');
  assert.equal(ld.ok, true);
  const st = r2.status();
  assert.equal(st.steps.s1.executorStatus, 'unknown'); // execution may still be running
  const to = r2.takeover({ taskId: 't1' });
  assert.equal(to.capsule.nextSafeAction, 'reconcile');
  const done = r2.transition({ taskId: 't1', stepId: 's1', control: 'DONE', authorityToken: to.authority.token });
  assert.equal(done.blocked, true); // no authoritative executor RESULT => DONE blocked
  assert.equal(r2.status().steps.s1.machineGate, 'pending');
  r2.close();
});

test('primary corruption with valid backup recovers at the durable-service level', () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  driveToResult(r1, {});
  const storeDir = r1.store.dir;
  r1.close();
  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  fs.writeFileSync(path.join(storeDir, 't1.json'), '{{{{corrupted', 'utf8'); // primary corrupt; .bak valid
  const ld = r2.loadTask('t1');
  assert.equal(ld.ok, true);
  assert.equal(ld.control, 'TASK');
  assert.equal(r2.status().steps.s1.machineGate, 'pass');
  r2.close();
});

test('primary + backup corruption fails closed: no fresh trusted task, named corrupt error', () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  driveToResult(r1, {});
  const storeDir = r1.store.dir;
  r1.close();
  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  fs.writeFileSync(path.join(storeDir, 't1.json'), 'broken', 'utf8');
  fs.writeFileSync(path.join(storeDir, 't1.json.bak'), 'broken too', 'utf8');
  assert.throws(() => r2.loadTask('t1'), (e) => e instanceof GovernanceStoreError && e.code === 'corrupt');
  const rec = r2.recoverSemantic({ projectKey: 'simon-world/repo', identity: 'issue-1' });
  assert.equal(rec.ok, false);
  assert.equal(rec.error, 'corrupt');
  assert.equal(r2.status().taskId, null); // no silent fresh task
  r2.close();
});

test('future schema fails closed with a named error and no fallback to backup', () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  driveToResult(r1, {});
  const storeDir = r1.store.dir;
  r1.close();
  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  const file = path.join(storeDir, 't1.json');
  const env = JSON.parse(fs.readFileSync(file, 'utf8'));
  env.schemaVersion = 99;
  fs.writeFileSync(file, JSON.stringify(env), 'utf8');
  assert.throws(() => r2.loadTask('t1'), (e) => e instanceof GovernanceStoreError && e.code === 'schema_unsupported');
  r2.close();
});

test('bounded semantic recovery: not_found / unique / ambiguous, never most-recent', () => {
  const { dataRoot, namespace } = fixture();
  // t1 created by runtime A (stays active).
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  r1.transition({ taskId: 't1', control: 'PLAN', projectKey: 'repo/a', identity: 'task-one' });
  r1.close();

  // not_found
  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  assert.equal(r2.recoverSemantic({ projectKey: 'repo/nope' }).error, 'not_found');
  const uniq = r2.recoverSemantic({ projectKey: 'repo/a', identity: 'task-one' });
  assert.equal(uniq.ok, true);
  assert.equal(uniq.taskId, 't1');
  r2.close();

  // t2 created by runtime B in the same project (also active) -> ambiguous on projectKey.
  const r3 = createDurableGovernanceService({ dataRoot, namespace });
  r3.transition({ taskId: 't2', control: 'PLAN', projectKey: 'repo/a', identity: 'task-two' });
  const amb = r3.recoverSemantic({ projectKey: 'repo/a' });
  assert.equal(amb.ok, false);
  assert.equal(amb.error, 'ambiguous');
  assert.equal(amb.matchCount, 2);
  assert.equal('taskId' in amb, false); // never guesses
  const dis = r3.recoverSemantic({ projectKey: 'repo/a', identity: 'task-two' });
  assert.equal(dis.ok, true);
  assert.equal(dis.taskId, 't2');
  r3.close();

  // Terminal DONE task in project b is not a continuation candidate, but is readable.
  const r4 = createDurableGovernanceService({ dataRoot, namespace });
  const planT3 = r4.transition({ taskId: 't3', control: 'PLAN', projectKey: 'repo/b', identity: 'task-three' });
  const tok3 = planT3.authorityToken;
  r4.transition({ taskId: 't3', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }], authorityToken: tok3 });
  r4.recordResult({ taskId: 't3', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }], authorityToken: tok3 });
  r4.transition({ taskId: 't3', stepId: 's1', control: 'DONE', authorityToken: tok3 });
  const term = r4.recoverSemantic({ projectKey: 'repo/b', identity: 'task-three' });
  assert.equal(term.ok, false);
  assert.equal(term.error, 'not_found');
  assert.equal(term.terminalMatches, 1);
  const resolved = r4.resolveSemantic({ projectKey: 'repo/b', identity: 'task-three' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.terminal, true);
  assert.equal(resolved.taskId, 't3');
  r4.close();
});

test('stale Parent fencing: takeover increments generation; old tokens are stale_authority', () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  const { token } = driveToResult(r1, {});
  assert.equal(r1.transition({ taskId: 't1', stepId: 's1', control: 'REVISE', authorityToken: token }).ok, true);
  r1.close();

  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  const to = r2.takeover({ taskId: 't1' });
  assert.equal(to.authority.generation, 1);
  const tokenB = to.authority.token;
  assert.throws(() => r2.transition({ taskId: 't1', stepId: 's1', control: 'TASK', authorityToken: token }), (e) => e instanceof GovernanceError && e.code === 'stale_authority');
  assert.throws(() => r2.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }], authorityToken: token }), (e) => e.code === 'stale_authority');
  assert.throws(() => r2.takeover({ taskId: 't1', authorityToken: token }), (e) => e.code === 'stale_authority');
  const res = r2.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }], authorityToken: tokenB });
  assert.equal(res.ok, true);
  const toC = r2.takeover({ taskId: 't1' });
  assert.equal(toC.authority.generation, 2);
  const tokenC = toC.authority.token;
  assert.throws(() => r2.transition({ taskId: 't1', stepId: 's1', control: 'TASK', authorityToken: tokenB }), (e) => e.code === 'stale_authority');
  assert.equal(r2.transition({ taskId: 't1', stepId: 's1', control: 'REVISE', authorityToken: tokenC }).ok, true);
  r2.close();
});

test('a second canonical Governance runtime writer for the same namespace is rejected/fails closed', () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  assert.throws(() => createDurableGovernanceService({ dataRoot, namespace }), (e) => e instanceof GovernanceWriterError && e.code === 'writer_conflict');
  const rOther = createDurableGovernanceService({ dataRoot, namespace: 'other-ns' });
  rOther.transition({ taskId: 'x', control: 'PLAN' });
  r1.close();
  rOther.close();
  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  assert.equal(r2.status().taskId, null);
  r2.close();
});

test('loss of the non-authoritative proof-reuse cache only forces conservative re-verification', () => {
  const { dataRoot, namespace } = fixture();
  const ledger1 = createProofLedger();
  const r1 = createDurableGovernanceService({ dataRoot, namespace, proofLedger: ledger1 });
  const plan = r1.transition({ taskId: 't1', control: 'PLAN', projectKey: 'repo/x', identity: 'id-1' });
  const token = plan.authorityToken;
  r1.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true, proof: { dependencyFree: true, verificationId: 'v1' } }], authorityToken: token });
  r1.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass', verificationId: 'v1' }], authorityToken: token });
  assert.equal(ledger1.isReusable('a1', { verificationId: 'v1' }), true);
  r1.close();

  const ledger2 = createProofLedger();
  const r2 = createDurableGovernanceService({ dataRoot, namespace, proofLedger: ledger2 });
  r2.loadTask('t1');
  assert.equal(ledger2.count(), 0);
  assert.equal(ledger2.isReusable('a1', { verificationId: 'v1' }), false); // conservative re-verification required
  const st = r2.status();
  assert.equal(st.steps.s1.acceptance[0].status, 'pass');
  assert.equal(st.steps.s1.machineGate, 'pass');
  r2.close();
});

test('proof-cache loss cannot create PASS for acceptance that was never durably evidenced', () => {
  const { dataRoot, namespace } = fixture();
  const ledger1 = createProofLedger();
  const r1 = createDurableGovernanceService({ dataRoot, namespace, proofLedger: ledger1 });
  const plan = r1.transition({ taskId: 't1', control: 'PLAN', projectKey: 'repo/x', identity: 'id-2' });
  const token = plan.authorityToken;
  r1.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }, { id: 'a2', required: true }], authorityToken: token });
  // a2 has only a cache-level proof (never durable evidence); the cache must never create truth.
  ledger1.record({ acceptanceId: 'a2', status: 'pass', dependencyFree: true, verificationId: 'v2' });
  r1.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }], authorityToken: token });
  r1.close();

  const ledger2 = createProofLedger();
  const r2 = createDurableGovernanceService({ dataRoot, namespace, proofLedger: ledger2 });
  r2.loadTask('t1');
  const st = r2.status();
  assert.equal(st.steps.s1.acceptance.find((a) => a.id === 'a1').status, 'pass');
  assert.equal(st.steps.s1.acceptance.find((a) => a.id === 'a2').status, 'missing');
  assert.equal(st.steps.s1.machineGate, 'fail'); // missing required a2 keeps the gate failed
  r2.close();
});

test('takeover returns a bounded Context Capsule derived from durable state (never transcript)', () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  const { token } = driveToResult(r1, { identity: 'issue-23', route: 'CODEX_DELEGATE' });
  const done = r1.transition({ taskId: 't1', stepId: 's1', control: 'DONE', authorityToken: token });
  assert.equal(done.ok, true);
  r1.close();

  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  const to = r2.takeover({ taskId: 't1' });
  const cap = to.capsule;
  assert.equal(cap.kind, 'brain-continuity.context-capsule');
  assert.equal(cap.taskId, 't1');
  assert.equal(cap.projectKey, 'simon-world/repo');
  assert.equal(cap.identity, 'issue-23');
  assert.equal(cap.control, 'DONE');
  assert.equal(cap.terminal, true);
  assert.equal(cap.nextSafeAction, 'done');
  assert.equal(cap.authority.generation, 1);
  assert.equal(cap.capabilityFreshness.requiresRediscovery, true);
  assert.equal(cap.execution.delegated, true);
  assert.equal(typeof cap.execution.binding.identity, 'string');
  assert.ok(Object.keys(cap).length < 30, 'capsule stays bounded');
  r2.close();
});

test('takeover does not duplicate/cancel/restart delegated execution; only reconciles via recover', async () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  const plan = r1.transition({ taskId: 't1', control: 'PLAN', projectKey: 'repo/codex', identity: 'issue-codex' });
  const token = plan.authorityToken;
  r1.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }], route: 'CODEX_DELEGATE', authorityToken: token });
  r1.close();

  const calls = [];
  const executor = {
    async recover(opts) { calls.push(['recover', opts]); return { jobId: 'j1', state: 'running' }; },
    async start(opts) { calls.push(['start', opts]); return { jobId: 'jX' }; },
    async continue(opts) { calls.push(['continue', opts]); return {}; },
    async interrupt(opts) { calls.push(['interrupt', opts]); return {}; },
  };

  const { performContinuityTakeover } = await import('../../src/governance/durable.js');
  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  const result = await performContinuityTakeover({ service: r2, executor, scope: { projectKey: 'repo/codex', identity: 'issue-codex' } });
  assert.equal(result.ok, true);
  assert.equal(result.execution.attempted, true);
  assert.equal(result.execution.action, 'recover');
  assert.equal(result.execution.reconciled, true);
  assert.deepEqual(calls.map((c) => c[0]), ['recover']);
  assert.equal(calls[0][1].taskId, 't1');
  assert.equal(calls[0][1].stepId, 's1');
  assert.equal(calls[0][1].identity, 'issue-codex');
  r2.close();
});

test('semantic re-entry reuses the durable binding/reconciliation path even with no executor', async () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  const plan = r1.transition({ taskId: 't1', control: 'PLAN', projectKey: 'repo/codex', identity: 'issue-codex' });
  const token = plan.authorityToken;
  r1.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }], route: 'CODEX_DELEGATE', authorityToken: token });
  r1.close();

  const { performContinuityTakeover } = await import('../../src/governance/durable.js');
  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  const result = await performContinuityTakeover({ service: r2, executor: null, scope: { taskId: 't1' } });
  assert.equal(result.ok, true);
  assert.equal(result.execution.attempted, false);
  assert.equal(result.capsule.taskId, 't1');
  assert.equal(result.capsule.step.executorStatus, 'unknown');
  r2.close();
});


test('an ousted writer cannot persist any subsequent Governance mutation/state change (fail closed before write)', () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  const plan = r1.transition({ taskId: 't1', control: 'PLAN', projectKey: 'repo/x', identity: 'id-lost' });
  const token = plan.authorityToken;
  r1.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }], authorityToken: token });
  const file = path.join(r1.store.dir, 't1.json');
  const before = fs.readFileSync(file, 'utf8');

  // The slot is reclaimed by another runtime (this writer's recorded PID is dead).
  const guard2 = new GovernanceWriterGuard({ dataRoot, namespace, pidAlive: () => false });
  const acq = guard2.acquire();
  assert.equal(acq.reclaimed, true);

  // Every subsequent durable mutation fails closed BEFORE any state change.
  assert.throws(() => r1.transition({ taskId: 't1', stepId: 's1', control: 'REVISE', authorityToken: token }), (e) => e instanceof GovernanceWriterError && e.code === 'writer_conflict');
  assert.throws(() => r1.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }], authorityToken: token }), (e) => e.code === 'writer_conflict');
  assert.throws(() => r1.takeover({ taskId: 't1' }), (e) => e.code === 'writer_conflict');
  assert.throws(() => r1.transition({ taskId: 't2', control: 'PLAN' }), (e) => e.code === 'writer_conflict');
  assert.equal(r1.store.hasTask('t2'), false, 'no new task state was written by the ousted writer');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'existing durable state was not mutated by the ousted writer');
  assert.equal(r1.status().control, 'TASK'); // in-memory lifecycle unchanged (no partial mutation)

  r1.close();
  guard2.release();
});


test('unique semantic recovery resolves a task with corrupt primary + valid backup', () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  const plan = r1.transition({ taskId: 't1', control: 'PLAN', projectKey: 'repo/backup', identity: 'issue-backup' });
  const token = plan.authorityToken;
  r1.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }], authorityToken: token });
  const storeDir = r1.store.dir;
  r1.close();

  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  fs.writeFileSync(path.join(storeDir, 't1.json'), '{{corrupt primary', 'utf8'); // .bak valid
  const rec = r2.recoverSemantic({ projectKey: 'repo/backup', identity: 'issue-backup' });
  assert.equal(rec.ok, true);
  assert.equal(rec.taskId, 't1');
  const to = r2.takeover({ projectKey: 'repo/backup', identity: 'issue-backup' });
  assert.equal(to.ok, true);
  assert.equal(to.capsule.taskId, 't1');
  assert.equal(r2.status().steps.s1.machineGate, 'pending');
  r2.close();
});

test('unique semantic recovery resolves a backup-only task when the primary is missing', () => {
  const { dataRoot, namespace } = fixture();
  const r1 = createDurableGovernanceService({ dataRoot, namespace });
  r1.transition({ taskId: 't1', control: 'PLAN', projectKey: 'repo/backup-only', identity: 'issue-backup-only' });
  const storeDir = r1.store.dir;
  r1.close();

  const r2 = createDurableGovernanceService({ dataRoot, namespace });
  fs.rmSync(path.join(storeDir, 't1.json')); // only .bak remains
  const rec = r2.recoverSemantic({ projectKey: 'repo/backup-only', identity: 'issue-backup-only' });
  assert.equal(rec.ok, true);
  assert.equal(rec.taskId, 't1');
  r2.close();
});

test('governanceNamespace config-file and runtime-override injection fails closed (invalid_component)', () => {
  const { dataRoot } = fixture();
  // Runtime-override injection path (loadV02Config override -> durable service).
  const over = loadV02Config({ dataRoot, governanceNamespace: '..' });
  assert.equal(over.governanceNamespace, '..');
  assert.throws(() => createDurableGovernanceService({ dataRoot, namespace: over.governanceNamespace }), (e) => e instanceof GovernanceStoreError && e.code === 'invalid_component');
  // Config-file injection path.
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'govcfg-'));
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ dataRoot, governanceNamespace: 'CON' }), 'utf8');
  const fromFile = loadV02Config({}, { configPath: cfgPath });
  assert.equal(fromFile.governanceNamespace, 'CON');
  assert.throws(() => createDurableGovernanceService({ dataRoot, namespace: fromFile.governanceNamespace }), (e) => e instanceof GovernanceStoreError && e.code === 'invalid_component');
});
