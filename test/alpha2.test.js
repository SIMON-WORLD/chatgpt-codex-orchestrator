import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskService } from '../src/legacy/task-service.js';
import { TaskManager } from '../src/legacy/task-manager.js';
import { newTaskState, saveState, loadState, setStepStatus, addStep, compactStep, findStep } from '../src/task-state.js';
import { buildCompactTask, buildFullTaskPacket, buildResult, packetSize, parseBrainOutput, normalizeResult, resultToText } from '../src/protocol.js';

function dir() { const d = path.join(os.tmpdir(), 'a2-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)); fs.mkdirSync(d, { recursive: true }); return d; }

class B {
  constructor(replies, opts = {}) { this.replies = [...replies]; this.conversationId = opts.conversationId || 'c'; this.conversationUrl = 'https://chatgpt.com/c/' + this.conversationId; this.ownedTabId = 't'; this.sent = []; }
  async send(text) { this.sent.push(text); const r = this.replies.shift() ?? 'DONE'; return { reply: typeof r === 'string' ? r : JSON.stringify(r), conversationId: this.conversationId }; }
}
class E {
  constructor(opts = {}) { this.calls = 0; this.evidence = opts.evidence || []; this.success = opts.success !== false; this.sessionId = opts.sessionId || 'th'; }
  async execute(prompt) { this.calls++; return { sessionId: this.sessionId, resultText: 'did:' + prompt, success: this.success, error: this.success ? null : 'boom', evidence: this.evidence }; }
}

const PLAN = {
  control: 'PLAN',
  taskContract: { goal: 'refactor stats', constraints: ['preserve API'], doneCriteria: ['tests pass'], verificationPolicyRef: 'project-profile/default' },
  plan: { planId: 'p-1', milestones: [{ milestoneId: 'm1', title: 'M1', acceptanceIds: ['a1'] }], steps: [{ stepId: 's1', milestoneId: 'm1', title: 'S1' }] },
  verificationPolicy: { defaultLevel: 'step', fullTestAt: ['milestone', 'final'], docOnlyTier: 'step' },
};

test('PLAN: validates, applies state, and is NOT forwarded to Codex', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const brain = new B([PLAN, 'DONE']);
  const ex = new E();
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  let r, guard = 0;
  do { r = await svc.advanceTask(taskId, { brain, executor: ex }); guard++; } while (r.status === 'running' && guard < 30);
  assert.strictEqual(ex.calls, 0, 'PLAN must not be forwarded to Codex as an execution task');
  const st = await svc.mgr.load(taskId);
  assert.strictEqual(st.plan.planId, 'p-1');
  assert.strictEqual(st.taskContract.goal, 'refactor stats');
  assert.strictEqual(st.verificationPolicy.defaultLevel, 'step');
  assert.strictEqual(st.currentStepId, null, 'idle waiting on Brain after PLAN');
  assert.strictEqual(st.status, 'completed');
});

test('PLAN -> TASK -> RESULT -> DONE executes the step and records evidenceLedger + stepSummary', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const brain = new B([PLAN, { control: 'TASK', stepId: 's1', instruction: 'do the work', acceptance: [{ id: 'a1', required: true, text: 'work' }] }, 'DONE']);
  const ex = new E({ evidence: [{ acceptanceId: 'a1', status: 'pass', kind: 'test', summary: 'ok' }] });
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  let r, guard = 0;
  do { r = await svc.advanceTask(taskId, { brain, executor: ex }); guard++; } while (r.status === 'running' && guard < 40);
  const st = await svc.mgr.load(taskId);
  assert.strictEqual(st.status, 'completed');
  assert.strictEqual(ex.calls, 1, 'exactly the single TASK reached Codex');
  assert.ok(st.evidenceLedger.length >= 1, 'real evidence appended to ledger');
  assert.strictEqual(st.evidenceLedger[0].acceptanceId, 'a1');
  assert.strictEqual(st.evidenceLedger[0].status, 'pass');
  assert.strictEqual(st.acceptanceRegistry.find((a) => a.id === 'a1').status, 'pass');
  assert.ok(st.stepSummaries.length >= 1, 'reviewed step compacted into stepSummaries');
  assert.strictEqual(st.stepSummaries[0].stepId, 's1');
  assert.ok(st.completedSteps.includes('s1'));
});

test('REPLAN: applies patch and does not forward to Codex before a concrete TASK', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const REPLAN = { control: 'REPLAN', reason: 'requirements changed', planPatch: { steps: [{ stepId: 's1', milestoneId: 'm1', title: 'S1' }, { stepId: 's2', milestoneId: 'm1', title: 'S2' }] } };
  const brain = new B([PLAN, REPLAN, 'DONE']);
  const ex = new E();
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  let r, guard = 0;
  do { r = await svc.advanceTask(taskId, { brain, executor: ex }); guard++; } while (r.status === 'running' && guard < 40);
  const st = await svc.mgr.load(taskId);
  assert.strictEqual(ex.calls, 0, 'REPLAN is a control/state op, not a Codex execution');
  assert.strictEqual(st.plan.steps.length, 2, 'planPatch applied');
  assert.strictEqual(st.lastControl, 'DONE');
});

test('compact TASK is a delta packet and is smaller than the full contract packet', () => {
  const compact = buildCompactTask({ stepId: 's2', instruction: 'add tests', acceptance: [{ id: 'a2', required: true, text: 'pass' }] });
  assert.deepStrictEqual(Object.keys(compact).sort(), ['acceptance', 'control', 'instruction', 'stepId']);
  const full = buildFullTaskPacket({ stepId: 's2', instruction: 'add tests', acceptance: [{ id: 'a2', required: true, text: 'pass' }], taskContract: { goal: 'g', constraints: ['c'] }, plan: { planId: 'p1', milestones: [{}] }, verificationPolicy: { defaultLevel: 'step' }, verificationCommands: ['npm test'] });
  assert.ok(packetSize(compact) < packetSize(full), 'compact must be smaller than full');
  assert.ok(full.taskContract);
  assert.ok(Array.isArray(full.verificationCommands));
});

test('compact RESULT has changed/evidence/blockers and no separate tests field by default', () => {
  const res = buildResult({ stepId: 's2', summary: 'done', changed: ['test/stats.test.js'], evidence: [{ acceptanceId: 'a2', status: 'pass', kind: 'test' }] });
  assert.strictEqual(res.type, 'result');
  assert.deepStrictEqual(res.changed, ['test/stats.test.js']);
  assert.strictEqual(res.tests, undefined);
  assert.ok(Array.isArray(res.evidence) && res.evidence[0].acceptanceId === 'a2');
});

test('legacy input compat vs Alpha.2 default RESULT serialization (item 5)', () => {
  // Legacy TASK still parses.
  const c = parseBrainOutput('{"control":"TASK","instruction":"x","acceptance":[]}').control;
  assert.strictEqual(c.control, 'TASK');
  // Alpha.2 default builder: accepts filesChanged/tests as INPUT but emits only the
  // compact shape (no tests field, 'changed' canonical).
  const r = buildResult({ stepId: 's1', filesChanged: ['a.js'], tests: [{ name: 't', passed: true }] });
  assert.deepStrictEqual(r.changed, ['a.js']);
  assert.strictEqual(r.tests, undefined, 'default compact RESULT has no tests field');
  assert.deepStrictEqual(Object.keys(r).sort(), ['blockers', 'changed', 'evidence', 'status', 'stepId', 'summary', 'type']);
  // resultToText on the default result emits NO tests line.
  const txt = resultToText(r);
  assert.ok(txt.includes('changed: a.js'));
  assert.ok(!txt.includes('tests:'), 'no verbose tests field in the default Alpha.2 RESULT text');
  // Legacy RESULT input (raw object with filesChanged+tests) is still accepted for parsing.
  const norm = normalizeResult({ type: 'result', stepId: 's1', status: 'success', filesChanged: ['a.js'], tests: [{ name: 't', passed: true }], evidence: [] });
  assert.deepStrictEqual(norm.changed, ['a.js']);
  assert.ok(Array.isArray(norm.tests) && norm.tests.length === 1, 'legacy tests preserved by normalizeResult');
});

test('v1 hydration: old task loads with defaults and does NOT fabricate evidence from acceptanceRegistry pass', () => {
  const d = dir();
  const oldS = { schemaVersion: 1, taskId: 'old-1', repoDir: 'r', goal: 'g', status: 'running', steps: [{ stepId: 'step-1', control: 'TASK', instruction: 'x', acceptance: [{ id: 'a1', required: true, text: 'a1' }], status: 'reviewed' }], completedSteps: ['step-1'], acceptanceRegistry: [{ id: 'a1', required: true, text: 'a1', status: 'pass' }] };
  saveState(d, oldS);
  const loaded = loadState(d, 'old-1');
  assert.strictEqual(loaded.schemaVersion, 1);
  assert.strictEqual(loaded.taskContract, null);
  assert.strictEqual(loaded.plan, null);
  assert.deepStrictEqual(loaded.verificationPolicy.fullTestAt, ['milestone', 'final']);
  assert.strictEqual(loaded.evidenceLedger.length, 0, 'no fabricated evidence');
});

test('v1 hydration recovers REAL structured evidence from persisted step result data', () => {
  const d = dir();
  const oldS = { schemaVersion: 1, taskId: 'old-2', repoDir: 'r', goal: 'g', status: 'running', steps: [{ stepId: 'step-1', status: 'reviewed', resultObj: { evidence: [{ acceptanceId: 'a1', status: 'pass', kind: 'test', summary: 'ok' }] } }], completedSteps: ['step-1'], acceptanceRegistry: [{ id: 'a1', required: true, text: 'a1', status: 'pass' }] };
  saveState(d, oldS);
  const loaded = loadState(d, 'old-2');
  assert.ok(loaded.evidenceLedger.length >= 1, 'real evidence recovered from step result');
  assert.strictEqual(loaded.evidenceLedger[0].acceptanceId, 'a1');
});

test('reviewed -> stepSummary compaction is deterministic and idempotent', () => {
  const s = newTaskState({ repoDir: 'r', goal: 'g' });
  addStep(s, { stepId: 'step-1', control: 'TASK', instruction: 'x', acceptance: [{ id: 'a1', required: true, text: 'a1' }], status: 'received' });
  setStepStatus(s, 'step-1', 'executing');
  setStepStatus(s, 'step-1', 'executed');
  setStepStatus(s, 'step-1', 'reviewed');
  assert.ok(s.stepSummaries.length >= 1);
  assert.strictEqual(s.stepSummaries[0].stepId, 'step-1');
  assert.strictEqual(s.stepSummaries[0].status, 'reviewed');
  compactStep(s, findStep(s, 'step-1'));
  assert.strictEqual(s.stepSummaries.filter((x) => x.stepId === 'step-1').length, 1);
});

test('2-REVISE escalation: after 2 failed REVISE, the step packet is the fuller contract packet', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const brain = new B([
    { control: 'TASK', instruction: 'work', acceptance: [{ id: 'a1', required: true, text: 'a1' }] },
    { control: 'REVISE', instruction: 'redo', acceptance: [{ id: 'a1', required: true, text: 'a1' }] },
    { control: 'REVISE', instruction: 'redo again', acceptance: [{ id: 'a1', required: true, text: 'a1' }] },
    { control: 'REVISE', instruction: 'redo third', acceptance: [{ id: 'a1', required: true, text: 'a1' }] },
    'DONE',
  ]);
  const ex = new E({ evidence: [{ acceptanceId: 'a1', status: 'pass', kind: 'verify' }] });
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  let r, guard = 0;
  do { r = await svc.advanceTask(taskId, { brain, executor: ex }); guard++; } while (r.status === 'running' && guard < 60);
  const st = await svc.mgr.load(taskId);
  const escalated = st.steps.find((s) => s.reviseCount >= 2);
  assert.ok(escalated, 'a step recorded reviseCount >= 2');
  assert.strictEqual(st.metrics.stepPacketEscalated, true);
  // reviseRetries counts once per REVISE control (3 REVISE controls -> 3), not per unit.
  assert.strictEqual(st.reviseRetries, 3);
  assert.ok(st.steps.every((s) => typeof s.reviseCount !== 'number' || s.reviseCount <= 3));
});

test('recovery/resume regression: stuck executing step -> recovery_required, no re-run', async () => {
  const d = dir();
  const mgr = new TaskManager({ stateDir: d });
  const state = newTaskState({ repoDir: 'r', goal: 'g' });
  state.conversationId = 'c'; state.ownedTabId = 't'; state.codexSessionId = 'th';
  state.lastControl = 'TASK';
  state.steps = [{ stepId: 'step-1', control: 'TASK', instruction: 'x', acceptance: [], status: 'executing' }];
  state.inFlightStep = 'step-1';
  saveState(d, state);
  const ex = new E();
  const r = await mgr.resumeTask({ taskId: state.taskId, brain: new B([]), executor: ex });
  assert.strictEqual(r.state.status, 'recovery_required');
  assert.strictEqual(ex.calls, 0);
});

test('existing conversation:new path remains working (no PLAN, pure TASK loop)', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const brain = new B([{ control: 'TASK', instruction: 'create a', acceptance: [] }, 'DONE']);
  const ex = new E();
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  let r, guard = 0;
  do { r = await svc.advanceTask(taskId, { brain, executor: ex }); guard++; } while (r.status === 'running' && guard < 30);
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(ex.calls, 1);
  const st = await svc.mgr.load(taskId);
  assert.strictEqual(st.plan, null);
});
