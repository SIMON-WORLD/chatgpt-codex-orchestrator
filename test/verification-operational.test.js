import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskService } from '../src/task-service.js';
import { VerificationPolicyError } from '../src/verification.js';

function dir() { const d = path.join(os.tmpdir(), 'vo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)); fs.mkdirSync(d, { recursive: true }); return d; }
class B { constructor(replies){ this.replies=[...replies]; this.conversationId='c'; this.conversationUrl='https://chatgpt.com/c/c'; this.ownedTabId='t'; this.sent=[]; } async send(text){ this.sent.push(text); const r=this.replies.shift() ?? 'DONE'; return { reply: typeof r==='string'? r : JSON.stringify(r), conversationId:'c' }; } }
class E { constructor(){ this.prompts=[]; this.evidenceFor = (id)=>[{ acceptanceId:id, status:'pass', kind:'verify', summary:'ok' }]; } async execute(prompt){ this.prompts.push(prompt); const id=(/acceptanceId="([^"]+)"/.exec(prompt)||[])[1]||'a'; return { sessionId:'th', resultText:'did:'+prompt, success:true, error:null, evidence: this.evidenceFor(id) }; } }

const STEP_CMDS = ['node --test test/x.test.js'];
const MILESTONE_CMDS = ['npm test'];
const FINAL_CMDS = ['npm test', 'npm run check'];

const PLAN_V = {
  control: 'PLAN',
  taskContract: { goal: 'g', constraints: [], doneCriteria: ['done'] },
  plan: {
    planId: 'p',
    milestones: [
      { milestoneId: 'm1', title: 'M1' },
      { milestoneId: 'm2', title: 'M2', verification: 'milestone' },
      { milestoneId: 'm3', title: 'M3', verification: 'final' },
    ],
    steps: [
      { stepId: 's1', milestoneId: 'm1', title: 'S1' },
      { stepId: 's2', milestoneId: 'm2', title: 'S2' },
      { stepId: 's3', milestoneId: 'm3', title: 'S3' },
    ],
  },
  verificationPolicy: { defaultLevel: 'step', fullTestAt: ['milestone', 'final'], docOnlyTier: 'step', commands: { step: STEP_CMDS, milestone: MILESTONE_CMDS, final: FINAL_CMDS } },
};

async function drive(svc, taskId, brain, ex, guard = 60) { let r, i=0; do { r = await svc.advanceTask(taskId, { brain, executor: ex }); i++; } while (r.status === 'running' && i < guard); return r; }

test('verification is operational: step/milestone/final commands are injected per boundary (not repeated)', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const brain = new B([
    PLAN_V,
    { control: 'TASK', stepId: 's1', instruction: 'work1', acceptance: [{ id: 'a1', required: true, text: 'a1' }] },
    { control: 'TASK', stepId: 's2', instruction: 'work2', acceptance: [{ id: 'a2', required: true, text: 'a2' }] },
    { control: 'TASK', stepId: 's3', instruction: 'work3', acceptance: [{ id: 'a3', required: true, text: 'a3' }] },
    'DONE',
  ]);
  const ex = new E();
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  const r = await drive(svc, taskId, brain, ex);
  const st = svc.mgr.load(taskId);
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(ex.prompts.length, 3, 'one prompt per executed step');

  const [p1, p2, p3] = ex.prompts;
  // step boundary receives ONLY step commands
  assert.ok(p1.includes('node --test test/x.test.js'), 'step prompt carries step command');
  assert.ok(!p1.includes('npm test'), 'step prompt must not include milestone command');
  assert.ok(!p1.includes('npm run check'), 'step prompt must not include final command');
  // milestone boundary receives ONLY milestone commands
  assert.ok(p2.includes('npm test'), 'milestone prompt carries milestone command');
  assert.ok(!p2.includes('npm run check'), 'milestone prompt must not include final command');
  assert.ok(!p2.includes('node --test test/x.test.js'), 'milestone prompt must not include step command');
  // final boundary receives final commands
  assert.ok(p3.includes('npm test') && p3.includes('npm run check'), 'final prompt carries final commands');

  // Commands are not redundantly repeated: each prompt has exactly one verification block
  for (const p of [p1, p2, p3]) {
    assert.strictEqual((p.match(/\n\nRun the following verification for this/) || []).length, 1, 'one verification block per prompt');
  }

  // Required verification cannot silently disappear: levels recorded on the step
  const byId = Object.fromEntries(st.steps.map((s) => [s.stepId, s]));
  assert.strictEqual(byId.s1.verification.level, 'step');
  assert.strictEqual(byId.s2.verification.level, 'milestone');
  assert.strictEqual(byId.s3.verification.level, 'final');
  assert.deepStrictEqual(byId.s3.verification.commands, FINAL_CMDS);
});

test('mandatory milestone with zero commands raises a deterministic VerificationPolicyError (no label-only boundary)', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const plan = {
    control: 'PLAN',
    taskContract: { goal: 'g', constraints: [], doneCriteria: ['done'] },
    plan: { planId: 'p', milestones: [{ milestoneId: 'm1', title: 'M1', verification: 'milestone' }], steps: [{ stepId: 's1', milestoneId: 'm1', title: 'S1' }] },
    verificationPolicy: { defaultLevel: 'step', fullTestAt: ['milestone', 'final'], docOnlyTier: 'step', commands: { milestone: [] } },
  };
  const brain = new B([plan, { control: 'TASK', stepId: 's1', instruction: 'x', acceptance: [{ id: 'a1', required: true, text: 'a1' }] }, 'DONE']);
  const ex = new E();
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  let err = null;
  try { await drive(svc, taskId, brain, ex, 30); } catch (e) { err = e; }
  assert.ok(err instanceof VerificationPolicyError, 'expected VerificationPolicyError');
  assert.match(err.message, /mandatory milestone verification requires executable commands/i);
});

test('mandatory final with zero commands raises a deterministic VerificationPolicyError', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const plan = {
    control: 'PLAN',
    taskContract: { goal: 'g', constraints: [], doneCriteria: ['done'] },
    plan: { planId: 'p', milestones: [{ milestoneId: 'm2', title: 'M2', verification: 'final' }], steps: [{ stepId: 's1', milestoneId: 'm2', title: 'S1' }] },
    verificationPolicy: { defaultLevel: 'step', fullTestAt: ['milestone', 'final'], docOnlyTier: 'step', commands: { final: [] } },
  };
  const brain = new B([plan, { control: 'TASK', stepId: 's1', instruction: 'x', acceptance: [{ id: 'a1', required: true, text: 'a1' }] }, 'DONE']);
  const ex = new E();
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  let err = null;
  try { await drive(svc, taskId, brain, ex, 30); } catch (e) { err = e; }
  assert.ok(err instanceof VerificationPolicyError, 'expected VerificationPolicyError');
  assert.match(err.message, /mandatory final verification requires executable commands/i);
});

test('no silent DONE after a missing mandatory verification boundary (DONE is blocked)', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const plan = {
    control: 'PLAN',
    taskContract: { goal: 'g', constraints: [], doneCriteria: ['done'] },
    plan: { planId: 'p', milestones: [{ milestoneId: 'm1', title: 'M1', verification: 'milestone' }], steps: [{ stepId: 's1', milestoneId: 'm1', title: 'S1' }] },
    verificationPolicy: { defaultLevel: 'step', fullTestAt: ['milestone', 'final'], docOnlyTier: 'step', commands: { milestone: ['npm test'] } },
  };
  // Brain never runs the step; it goes straight to DONE.
  const brain = new B([plan, 'DONE']);
  const ex = new E();
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  const r = await drive(svc, taskId, brain, ex, 30);
  const st = svc.mgr.load(taskId);
  assert.strictEqual(r.status, 'awaiting_user', 'DONE must NOT pass while a mandatory boundary is incomplete');
  assert.ok(st.verificationBlock && st.verificationBlock.length >= 1, 'verification block recorded');
  assert.strictEqual(st.verificationBlock[0].milestoneId, 'm1');
  assert.strictEqual(ex.prompts.length, 0, 'no step ran');
});

test('with no configured commands, no verification command block is appended (no redundant repetition)', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const planNoCmds = { ...PLAN_V, plan: { planId: 'p', milestones: [{ milestoneId: 'm1', title: 'M1' }], steps: [{ stepId: 's1', milestoneId: 'm1', title: 'S1' }] }, verificationPolicy: { defaultLevel: 'step', fullTestAt: ['milestone', 'final'], docOnlyTier: 'step' } };
  const brain = new B([planNoCmds, { control: 'TASK', stepId: 's1', instruction: 'x', acceptance: [{ id: 'a1', required: true, text: 'a1' }] }, 'DONE']);
  const ex = new E();
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  await drive(svc, taskId, brain, ex);
  assert.strictEqual(ex.prompts.length, 1);
  assert.ok(!ex.prompts[0].includes('Run the following verification'), 'no verification block when no commands configured');
});
