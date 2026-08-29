import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskService } from '../src/task-service.js';
import { ProtocolError } from '../src/protocol.js';

function dir() { const d = path.join(os.tmpdir(), 'pi-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)); fs.mkdirSync(d, { recursive: true }); return d; }
class B { constructor(replies){ this.replies=[...replies]; this.conversationId='c'; this.conversationUrl='https://chatgpt.com/c/c'; this.ownedTabId='t'; this.sent=[]; } async send(text){ this.sent.push(text); const r=this.replies.shift() ?? 'DONE'; return { reply: typeof r==='string'? r : JSON.stringify(r), conversationId:'c' }; } }
class E {
  constructor(){ this.calls=[]; }
  async execute(prompt){
    this.calls.push(prompt);
    const ids = [...String(prompt||'').matchAll(/acceptanceId="([^"]+)"/g)].map((m)=>m[1]);
    const evidence = [...new Set(ids)].map((id) => ({ acceptanceId:id, status:'pass', kind:'test', summary:'ok' }));
    return { sessionId:'th', resultText:'did:'+prompt, success:true, error:null, evidence };
  }
}

const PLAN3 = {
  control: 'PLAN',
  taskContract: { goal: 'g', constraints: ['c'], doneCriteria: ['done'], verificationPolicyRef: 'profile' },
  plan: {
    planId: 'p-1',
    milestones: [
      { milestoneId: 'm1', title: 'M1', verification: 'milestone' },
      { milestoneId: 'm2', title: 'M2', verification: 'final' },
    ],
    steps: [
      { stepId: 's1', milestoneId: 'm1', title: 'S1' },
      { stepId: 's2', milestoneId: 'm1', title: 'S2' },
      { stepId: 's3', milestoneId: 'm2', title: 'S3' },
    ],
  },
  verificationPolicy: { defaultLevel: 'step', fullTestAt: ['milestone', 'final'], docOnlyTier: 'step', commands: { milestone: ['npm test'], final: ['npm test', 'npm run check'] } },
};

async function drive(svc, taskId, brain, ex, guard = 60) {
  let r, i = 0;
  do { r = await svc.advanceTask(taskId, { brain, executor: ex }); i++; } while (r.status === 'running' && i < guard);
  return r;
}

test('PLAN canonical step identity: s1/m1, s2/m1, s3/m2 preserved across run/review/summary/evidence', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const brain = new B([
    PLAN3,
    { control: 'TASK', stepId: 's1', instruction: 'work1', acceptance: [{ id: 'a1', required: true, text: 'a1' }] },
    { control: 'TASK', stepId: 's2', instruction: 'work2', acceptance: [{ id: 'a2', required: true, text: 'a2' }] },
    { control: 'TASK', stepId: 's3', instruction: 'work3', acceptance: [{ id: 'a3', required: true, text: 'a3' }] },
    'DONE',
  ]);
  const ex = new E();
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  const r = await drive(svc, taskId, brain, ex);
  const st = await svc.mgr.load(taskId);
  assert.strictEqual(r.status, 'completed');
  assert.deepStrictEqual(st.steps.map((s) => s.stepId), ['s1', 's2', 's3'], 'step ids are canonical plan ids');
  assert.deepStrictEqual(st.completedSteps, ['s1', 's2', 's3'], 'completedSteps use canonical plan ids');
  assert.deepStrictEqual(st.stepSummaries.map((s) => s.stepId), ['s1', 's2', 's3'], 'stepSummaries use canonical plan ids');
  // evidenceLedger stepIds all in {s1,s2,s3}; per step at least one entry keyed to the plan step
  const stepIds = new Set(st.steps.map((s) => s.stepId));
  assert.ok(st.evidenceLedger.length >= 3);
  assert.ok(st.evidenceLedger.every((e) => stepIds.has(e.stepId)), 'evidenceLedger.stepId uses plan step ids');
  // milestone verification resolves correctly (m1 -> milestone, m2 -> final)
  const byId = Object.fromEntries(st.steps.map((s) => [s.stepId, s]));
  assert.strictEqual(byId.s1.milestoneId, 'm1');
  assert.strictEqual(byId.s2.milestoneId, 'm1');
  assert.strictEqual(byId.s3.milestoneId, 'm2');
  assert.strictEqual(byId.s1.verification.level, 'milestone');
  assert.strictEqual(byId.s2.verification.level, 'milestone');
  assert.strictEqual(byId.s3.verification.level, 'final');
  assert.strictEqual(st.metrics.fullSuiteVerificationCount, 3, 'each milestone/final boundary step triggers the full suite');
});

test('REVISE on a planned step reuses the same canonical stepId (no duplicate step objects)', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const planOne = {
    control: 'PLAN',
    taskContract: { goal: 'g', constraints: ['c'], doneCriteria: ['done'] },
    plan: { planId: 'p', milestones: [{ milestoneId: 'm1', title: 'M1', verification: 'milestone' }], steps: [{ stepId: 's1', milestoneId: 'm1', title: 'S1' }] },
    verificationPolicy: { defaultLevel: 'step', fullTestAt: ['milestone', 'final'], docOnlyTier: 'step', commands: { milestone: ['npm test'] } },
  };
  const brain = new B([
    planOne,
    { control: 'TASK', stepId: 's1', instruction: 'work', acceptance: [{ id: 'a1', required: true, text: 'a1' }] },
    { control: 'REVISE', stepId: 's1', instruction: 'rework', acceptance: [{ id: 'a1', required: true, text: 'a1' }] },
    'DONE',
  ]);
  const ex = new E();
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  const r = await drive(svc, taskId, brain, ex);
  const st = await svc.mgr.load(taskId);
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(st.steps.length, 1, 'exactly one step object for the canonical s1 step');
  assert.strictEqual(st.steps[0].stepId, 's1');
  assert.strictEqual(st.completedSteps.length, 1, 'completedSteps contains s1 exactly once');
  assert.strictEqual(st.stepSummaries.filter((x) => x.stepId === 's1').length, 1, 'one stepSummary for s1');
  assert.ok(st.steps[0].reviseCount >= 1, 'reviseCount recorded on the same step object');
});

test('legacy no-PLAN step generation still works (step-1, step-2, ...)', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const brain = new B([
    { control: 'TASK', instruction: 'a', acceptance: [] },
    { control: 'TASK', instruction: 'b', acceptance: [] },
    'DONE',
  ]);
  const ex = new E();
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  const r = await drive(svc, taskId, brain, ex);
  const st = await svc.mgr.load(taskId);
  assert.strictEqual(r.status, 'completed');
  assert.deepStrictEqual(st.steps.map((s) => s.stepId), ['step-1', 'step-2']);
  assert.strictEqual(st.plan, null);
});

test('unresolvable PLAN step id surfaces a deterministic ProtocolError (no guess)', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const brain = new B([
    PLAN3,
    { control: 'TASK', stepId: 's99', instruction: 'bogus', acceptance: [] },
    'DONE',
  ]);
  const ex = new E();
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  let err = null;
  try { await drive(svc, taskId, brain, ex, 30); } catch (e) { err = e; }
  assert.ok(err instanceof ProtocolError, 'expected a deterministic ProtocolError');
  assert.match(err.message, /not a declared step/i);
});

test('planned step with missing milestone in a milestone-based plan surfaces a deterministic ProtocolError', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const planNoMilestone = {
    control: 'PLAN',
    taskContract: { goal: 'g', constraints: [], doneCriteria: [] },
    plan: { planId: 'p', milestones: [{ milestoneId: 'm1', title: 'M1' }], steps: [{ stepId: 's1', title: 'S1' }] },
    verificationPolicy: { defaultLevel: 'step', fullTestAt: ['milestone', 'final'] },
  };
  const brain = new B([planNoMilestone, { control: 'TASK', stepId: 's1', instruction: 'x', acceptance: [] }, 'DONE']);
  const ex = new E();
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  let err = null;
  try { await drive(svc, taskId, brain, ex, 30); } catch (e) { err = e; }
  assert.ok(err instanceof ProtocolError, 'expected a deterministic ProtocolError');
  assert.match(err.message, /no declared milestone/i);
});
