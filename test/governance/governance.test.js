import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { GovernanceService, GovernanceError, GOV_CONTROLS, governanceGateOk } from '../../src/governance/index.js';
import { createProofLedger } from '../../src/direct-governance.js';

function setup(opts = {}) { return new GovernanceService(opts); }

test('governance control surface is the canonical Brain control set', () => {
  assert.deepEqual([...GOV_CONTROLS].sort(), ['ASK_USER', 'DONE', 'PLAN', 'PUBLISH', 'REPLAN', 'REVISE', 'TASK'].sort());
});

test('PLAN establishes a task and yields a task next action (no step yet)', () => {
  const g = setup();
  const r = g.transition({ taskId: 't1', control: 'PLAN', route: 'CHATGPT_NATIVE' });
  assert.equal(r.ok, true);
  assert.equal(r.nextAction, 'task');
  assert.equal(r.stepId, null);
  assert.equal(g.status().planned, true);
});

test('TASK authorizes execution and does NOT require evidence (gates pending)', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  const r = g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }], route: 'CODEX_DELEGATE' });
  assert.equal(r.ok, true);
  assert.equal(r.nextAction, 'execute');
  assert.equal(r.executorStatus, 'unknown');
  assert.equal(r.machineGate, 'pending');
  assert.equal(r.brainAcceptance, 'pending');
  assert.equal(g.status().currentStepId, 's1');
});

test('recordResult ingests success + passing evidence -> machine gate pass, brainAcceptance pending', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }] });
  const r = g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  assert.equal(r.executorStatus, 'success');
  assert.equal(r.machineGate, 'pass');
  assert.equal(r.brainAcceptance, 'pending'); // acceptance only on advancement/DONE/PUBLISH
  assert.equal(g.status().steps.s1.machineGate, 'pass');
});

test('full lifecycle: PLAN -> TASK s1 -> RESULT s1 -> TASK s2 (s1 accepted, s2 pending) -> RESULT s2 -> DONE', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }] });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  // Advance to s2.
  const t2 = g.transition({ taskId: 't1', stepId: 's2', control: 'TASK', acceptance: [{ id: 'a2', required: true }] });
  assert.equal(t2.ok, true);
  const st = g.status();
  assert.equal(st.previousStepId, 's1');
  assert.equal(st.currentStepId, 's2');
  assert.ok(st.acceptedSteps.includes('s1'));
  assert.equal(st.steps.s1.brainAcceptance, 'accepted');
  assert.equal(st.steps.s2.machineGate, 'pending');
  // RESULT s2.
  g.recordResult({ taskId: 't1', stepId: 's2', executorStatus: 'success', evidence: [{ acceptanceId: 'a2', status: 'pass' }] });
  const done = g.transition({ taskId: 't1', stepId: 's2', control: 'DONE' });
  assert.equal(done.blocked, false);
  assert.equal(done.ok, true);
  assert.equal(g.status().control, 'DONE');
  assert.equal(g.status().steps.s2.brainAcceptance, 'accepted');
});

test('RESULT failure -> DONE blocked even if some evidence passes', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }] });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'failure', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  const r = g.transition({ taskId: 't1', stepId: 's1', control: 'DONE' });
  assert.equal(r.blocked, true);
  assert.equal(r.nextAction, 'blocked_done');
  assert.equal(g.status().control, 'TASK');
});

test('cannot advance from a step whose result was not success', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'failure', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  assert.throws(() => g.transition({ taskId: 't1', stepId: 's2', control: 'TASK', acceptance: [{ id: 'a2' }] }), /cannot advance from step/);
});

test('REVISE keeps step identity and reopens invalidated acceptance', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }] });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  assert.equal(g.status().steps.s1.machineGate, 'pass');
  const r = g.transition({ taskId: 't1', stepId: 's1', control: 'REVISE', reviseDelta: { invalidate: ['a1'] } });
  assert.equal(r.ok, true);
  const st = g.status();
  assert.equal(st.currentStepId, 's1'); // identity preserved
  assert.equal(st.steps.s1.brainAcceptance, 'revise');
  assert.equal(st.steps.s1.machineGate, 'pending'); // reverted to executable
  assert.equal(st.steps.s1.executorStatus, 'unknown');
  assert.equal(st.steps.s1.evidence.length, 0);
});

test('PUBLISH sets publicationRequired; DONE blocked without readback result', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  const pub = g.transition({ taskId: 't1', stepId: 's1', control: 'PUBLISH', publication: null });
  assert.equal(pub.ok, true);
  assert.equal(g.status().publicationRequired, true);
  // No successful readback result recorded.
  const done = g.transition({ taskId: 't1', stepId: 's1', control: 'DONE' });
  assert.equal(done.blocked, true);
  assert.equal(done.nextAction, 'blocked_done_publication');
});

test('DONE after successful publication result is terminal', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  g.transition({ taskId: 't1', stepId: 's1', control: 'PUBLISH' });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', publication: { ok: true, externalReadback: { remoteMainSha: 'x' } } });
  const done = g.transition({ taskId: 't1', stepId: 's1', control: 'DONE' });
  assert.equal(done.blocked, false);
  assert.equal(g.status().control, 'DONE');
  assert.equal(g.status().published, true);
});

test('ASK_USER does not silently accept; sets awaiting_user', () => {
  const g = setup();
  const r = g.transition({ taskId: 't1', stepId: 's1', control: 'ASK_USER', whyBlocked: 'need decision', minimalUserAction: 'pick', question: 'which?' });
  assert.equal(r.blocked, true);
  assert.equal(r.nextAction, 'awaiting_user');
  assert.equal(g.status().awaitingUser, true);
});

test('after terminal DONE, a further non-DONE control is rejected', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  g.transition({ taskId: 't1', stepId: 's1', control: 'DONE' });
  assert.throws(() => g.transition({ taskId: 't1', stepId: 's2', control: 'TASK' }), GovernanceError);
});

test('recordResult must target the active step', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  assert.throws(() => g.recordResult({ taskId: 't1', stepId: 's9', executorStatus: 'success' }), /must target the active step/);
});

test('governanceGateOk requires executor success + machine gate pass + Brain acceptance', () => {
  assert.equal(governanceGateOk({ executorStatus: 'success', machineGate: 'pass', brainAcceptance: 'accepted' }), true);
  assert.equal(governanceGateOk({ executorStatus: 'success', machineGate: 'pass', brainAcceptance: 'pending' }), false);
  assert.equal(governanceGateOk({ executorStatus: 'failure', machineGate: 'pass', brainAcceptance: 'accepted' }), false);
  assert.equal(governanceGateOk({ executorStatus: 'success', machineGate: 'fail', brainAcceptance: 'accepted' }), false);
});

test('proof is recorded on passing evidence, reused, then invalidated on changed file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-proof-'));
  const f = path.join(root, 'a.js');
  fs.writeFileSync(f, 'version1', 'utf8');
  const computeFingerprint = (p) => { const content = fs.readFileSync(p, 'utf8'); return 'fp:' + content; };
  const proofLedger = createProofLedger({ computeFingerprint });
  const g = new GovernanceService({ proofLedger });
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true, proof: { relevantFiles: [f] } }] });
  const r1 = g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass', evidenceLevel: 'observed', kind: 'verify' }] });
  assert.equal(r1.recordedProofs, 1);
  assert.equal(proofLedger.isReusable('a1'), true);
  assert.equal(r1.proofReusableByAcceptance[0].reusable, true);
  // Change a relevant file and ingest a result that touches the file but does NOT
  // re-verify the acceptance -> the prior proof is invalidated (stale).
  fs.writeFileSync(f, 'version2', 'utf8');
  const r2 = g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [], changed: [f] });
  assert.equal(proofLedger.isReusable('a1'), false);
  assert.equal(r2.proofReusableByAcceptance.length, 0);
});

test('transition returns a valid compact handoff and per-step state is isolated', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }], route: 'CODEX_DELEGATE' });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  g.transition({ taskId: 't1', stepId: 's2', control: 'TASK', acceptance: [{ id: 'a2' }], route: 'CODEX_DELEGATE' });
  const st = g.status();
  assert.deepEqual(Object.keys(st.steps).sort(), ['s1', 's2']);
  // s1 and s2 hold independent acceptance/evidence/gate.
  assert.equal(st.steps.s1.acceptance[0].id, 'a1');
  assert.equal(st.steps.s2.acceptance[0].id, 'a2');
  assert.equal(st.steps.s2.machineGate, 'pending');
});

// ---- r1/phaseA: taskId binding, TASK reissue idempotency, authority contract ----

test('taskId is bound once and stays stable across transition/recordResult', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  // Omitted taskId uses the bound one.
  const r = g.recordResult({ stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  assert.equal(r.taskId, 't1');
});

test('taskId mismatch raises GovernanceError on transition and recordResult', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  // A different taskId is only allowed at a terminal-DONE + PLAN boundary; elsewhere rejected.
  assert.throws(() => g.transition({ taskId: 't2', stepId: 's1', control: 'TASK' }), /cannot start new task t2/);
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK' });
  assert.throws(() => g.recordResult({ taskId: 't9', stepId: 's1', executorStatus: 'success' }), /taskId mismatch/);
});

test('a fresh step TASK reissue is idempotent and keeps executorStatus/gate', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  const r2 = g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  assert.equal(r2.ok, true);
  assert.equal(r2.nextAction, 'execute');
  const st = g.status();
  assert.equal(st.steps.s1.executorStatus, 'unknown');
  assert.equal(st.steps.s1.machineGate, 'pending');
});

test('TASK reissue on a step that already has a RESULT does NOT clear it and blocks', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  assert.equal(g.status().steps.s1.machineGate, 'pass');
  const r = g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  assert.equal(r.blocked, true);
  assert.equal(r.nextAction, 'blocked_task_reissue');
  // RESULT is preserved, not wiped.
  const st = g.status();
  assert.equal(st.steps.s1.executorStatus, 'success');
  assert.equal(st.steps.s1.machineGate, 'pass');
  assert.equal(st.steps.s1.evidence.length, 1);
});

// ---- M5 final closure: DONE immutability, acceptance truth, sequential tasks ----

test('DONE is terminal: post-DONE recordResult is rejected and state is immutable', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }] });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  const done = g.transition({ taskId: 't1', stepId: 's1', control: 'DONE' });
  assert.equal(done.ok, true);
  const stA = g.status();
  assert.equal(stA.control, 'DONE');
  assert.equal(stA.steps.s1.brainAcceptance, 'accepted');
  assert.ok(stA.acceptedSteps.includes('s1'));
  const snapA = JSON.stringify(stA);
  assert.throws(() => g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] }), /terminal after DONE/);
  const snapB = JSON.stringify(g.status());
  assert.equal(snapA, snapB); // state unchanged
});

test('repeated DONE is idempotent (terminal state stable)', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  const d1 = g.transition({ taskId: 't1', stepId: 's1', control: 'DONE' });
  const snap = JSON.stringify(g.status());
  const d2 = g.transition({ taskId: 't1', stepId: 's1', control: 'DONE' });
  assert.equal(d2.ok, true);
  assert.equal(d2.control, 'DONE');
  assert.equal(JSON.stringify(g.status()), snap);
});

test('same taskId after DONE rejects TASK/REVISE/REPLAN/PUBLISH', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }] });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  g.transition({ taskId: 't1', stepId: 's1', control: 'DONE' });
  assert.throws(() => g.transition({ taskId: 't1', stepId: 's2', control: 'TASK' }), /DONE is terminal/);
  assert.throws(() => g.transition({ taskId: 't1', stepId: 's1', control: 'REVISE' }), /DONE is terminal/);
  assert.throws(() => g.transition({ taskId: 't1', stepId: 's1', control: 'REPLAN' }), /DONE is terminal/);
  assert.throws(() => g.transition({ taskId: 't1', stepId: 's1', control: 'PUBLISH' }), /DONE is terminal/);
});

test('acceptance.status is truthful against evidence (no missing/pass contradiction)', () => {
  const g = setup();
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }] });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  const st = g.status();
  assert.equal(st.steps.s1.acceptance[0].status, 'pass');
  assert.equal(st.steps.s1.machineGate, 'pass');
  assert.notEqual(st.steps.s1.acceptance[0].status, 'missing');
});

test('sequential tasks in one persistent runtime: t1 DONE then t2 PLAN/TASK/RESULT/DONE', () => {
  const g = setup();
  // t1
  g.transition({ taskId: 't1', control: 'PLAN' });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }] });
  g.recordResult({ taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  g.transition({ taskId: 't1', stepId: 's1', control: 'DONE' });
  const st1 = g.status();
  assert.equal(st1.control, 'DONE');
  assert.ok(st1.acceptedSteps.includes('s1'));
  // t2 starts via PLAN
  const plan2 = g.transition({ taskId: 't2', control: 'PLAN' });
  assert.equal(plan2.ok, true);
  const st2 = g.status();
  assert.equal(st2.taskId, 't2');
  assert.equal(st2.currentStepId, null);
  assert.deepEqual(st2.steps, {});
  assert.deepEqual(st2.acceptedSteps, []);
  assert.equal(st2.publicationRequired, false);
  assert.equal(st2.awaitingUser, false);
  // t2 lifecycle
  g.transition({ taskId: 't2', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }] });
  g.recordResult({ taskId: 't2', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  const done2 = g.transition({ taskId: 't2', stepId: 's1', control: 'DONE' });
  assert.equal(done2.ok, true);
  assert.equal(g.status().control, 'DONE');
});
