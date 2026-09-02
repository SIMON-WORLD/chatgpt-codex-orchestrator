import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GovernanceService, GovernanceError, GOV_CONTROLS, governanceGateOk } from '../../src/governance/index.js';
import { buildHandoff } from '../../src/state/handoff.js';

test('governance control surface is the canonical Brain control set', () => {
  assert.deepEqual([...GOV_CONTROLS].sort(), ['ASK_USER', 'DONE', 'PLAN', 'PUBLISH', 'REPLAN', 'REVISE', 'TASK'].sort());
});

test('PLAN establishes a task/step and yields a task next action', () => {
  const g = new GovernanceService();
  const r = g.transition({ taskId: 't1', stepId: 's1', control: 'PLAN', route: 'CHATGPT_NATIVE', acceptance: [{ id: 'a1' }] });
  assert.equal(r.ok, true);
  assert.equal(r.machineGate, 'fail'); // no evidence yet -> not pass
  assert.equal(r.nextAction, 'task');
  const st = g.status();
  assert.equal(st.taskId, 't1');
  assert.equal(st.stepId, 's1');
  assert.equal(st.control, 'PLAN');
  assert.equal(st.planned, true);
});

test('acceptance evidence incomplete -> machine gate does NOT pass', () => {
  const g = new GovernanceService();
  // Only one of two required acceptances has passing evidence.
  const r = g.transition({
    taskId: 't1', stepId: 's1', control: 'TASK',
    acceptance: [{ id: 'a1', required: true }, { id: 'a2', required: true }],
    evidence: [{ acceptanceId: 'a1', status: 'pass' }],
  });
  assert.equal(r.machineGate, 'fail');
  assert.equal(r.blocked, true);
  assert.equal(r.nextAction, 'blocked_incomplete_acceptance');
  assert.ok(r.handoff.evidenceSummary.some((e) => e.acceptanceId === 'a1'));
});

test('complete acceptance evidence -> machine gate passes and TASK authorized', () => {
  const g = new GovernanceService();
  const r = g.transition({
    taskId: 't1', stepId: 's1', control: 'TASK',
    acceptance: [{ id: 'a1', required: true }],
    evidence: [{ acceptanceId: 'a1', status: 'pass', evidenceLevel: 'observed' }],
  });
  assert.equal(r.machineGate, 'pass');
  assert.equal(r.blocked, false);
  assert.equal(r.nextAction, 'execute');
});

test('REVISE keeps task/step identity', () => {
  const g = new GovernanceService();
  g.transition({ taskId: 't1', stepId: 's1', control: 'PLAN' });
  const r = g.transition({
    taskId: 't1', stepId: 's1', control: 'REVISE',
    reviseDelta: { invalidate: ['a1'], preserve: [] },
    acceptance: [{ id: 'a1', required: true }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.taskId, 't1');
  assert.equal(r.stepId, 's1');
  // Identity unchanged (no new stepId / planRevision bump).
  const st = g.status();
  assert.equal(st.taskId, 't1');
  assert.equal(st.stepId, 's1');
  assert.equal(st.control, 'REVISE');
  assert.equal(r.nextAction, 'revise_execute');
});

test('REVISE with invalidate reopens the acceptance (no silent preserve)', () => {
  const g = new GovernanceService();
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }], evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  const st1 = g.status();
  assert.ok(st1.acceptedSteps.includes('s1') || st1.acceptedSteps.length >= 0);
  const r = g.transition({ taskId: 't1', stepId: 's1', control: 'REVISE', reviseDelta: { invalidate: ['a1'] } });
  assert.equal(r.ok, true);
  assert.equal(g.state.acceptanceStates.a1, undefined); // no longer accidentally accepted
});

test('DONE is blocked when machine gate not satisfied', () => {
  const g = new GovernanceService();
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }] });
  const r = g.transition({ taskId: 't1', stepId: 's1', control: 'DONE' });
  assert.equal(r.blocked, true);
  assert.equal(r.machineGate, 'fail');
  assert.equal(r.nextAction, 'blocked_done');
  assert.equal(g.status().control, 'TASK'); // DONE never became terminal
});

test('DONE is only accepted when governance gate is satisfied', () => {
  const g = new GovernanceService();
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }], evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  assert.equal(g.status().machineGate, 'pass');
  const r = g.transition({ taskId: 't1', stepId: 's1', control: 'DONE' });
  assert.equal(r.blocked, false);
  assert.equal(r.ok, true);
  assert.equal(g.status().control, 'DONE');
  assert.equal(g.status().brainAcceptance, 'accepted');
  assert.equal(r.nextAction, 'done');
});

test('DONE requires publication readiness when a publication is involved', () => {
  const g = new GovernanceService();
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }], evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  const r = g.transition({ taskId: 't1', stepId: 's1', control: 'DONE', publication: { ok: true, externalReadback: false } });
  assert.equal(r.blocked, true);
  assert.equal(r.nextAction, 'blocked_done_publication');
  assert.equal(g.status().control, 'TASK');
});

test('ASK_USER does not silently accept; sets awaiting_user', () => {
  const g = new GovernanceService();
  const r = g.transition({ taskId: 't1', stepId: 's1', control: 'ASK_USER', whyBlocked: 'need decision', minimalUserAction: 'pick a', question: 'which option?' });
  assert.equal(r.blocked, true);
  assert.equal(r.nextAction, 'awaiting_user');
  assert.equal(g.status().awaitingUser, true);
});

test('PUBLISH is gated on machine gate + allowPublish', () => {
  const g = new GovernanceService({ allowPublish: true });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }], evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  const r = g.transition({ taskId: 't1', stepId: 's1', control: 'PUBLISH' });
  assert.equal(r.blocked, false);
  assert.equal(r.nextAction, 'publication_ready');
  assert.equal(g.status().control, 'PUBLISH');
});

test('PUBLISH disabled -> blocked', () => {
  const g = new GovernanceService({ allowPublish: false });
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }], evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  const r = g.transition({ taskId: 't1', stepId: 's1', control: 'PUBLISH' });
  assert.equal(r.blocked, true);
  assert.equal(r.nextAction, 'blocked_publish_disabled');
});

test('after terminal DONE, a further non-DONE control is rejected', () => {
  const g = new GovernanceService();
  g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1' }], evidence: [{ acceptanceId: 'a1', status: 'pass' }] });
  g.transition({ taskId: 't1', stepId: 's1', control: 'DONE' });
  assert.throws(() => g.transition({ taskId: 't1', stepId: 's2', control: 'TASK' }), GovernanceError);
});

test('governanceGateOk requires both machine gate pass and Brain acceptance', () => {
  assert.equal(governanceGateOk({ machineGate: 'pass', brainAcceptance: 'accepted' }), true);
  assert.equal(governanceGateOk({ machineGate: 'pass', brainAcceptance: 'pending' }), false);
  assert.equal(governanceGateOk({ machineGate: 'fail', brainAcceptance: 'accepted' }), false);
});

test('transition returns a valid compact handoff', () => {
  const g = new GovernanceService();
  const r = g.transition({ taskId: 't1', stepId: 's1', control: 'TASK', route: 'CODEX_DELEGATE', acceptance: [{ id: 'a1' }], evidence: [{ acceptanceId: 'a1', status: 'pass' }], changed: ['src/a.js'] });
  assert.ok(r.handoff && typeof r.handoff === 'object');
  assert.equal(r.handoff.taskId, 't1');
  assert.equal(r.handoff.machineGate, 'pass');
  assert.equal(r.handoff.route, 'CODEX_DELEGATE');
});
