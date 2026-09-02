import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskManager } from '../src/legacy/task-manager.js';
import { newTaskState, saveState } from '../src/task-state.js';

function dir() { const d = path.join(os.tmpdir(), 'tm-' + Date.now()); fs.mkdirSync(d, { recursive: true }); return d; }
function json(o) { return JSON.stringify(o); }

class FakeBrain {
  constructor(replies, opts = {}) {
    this.replies = [...replies];
    this.conversationId = opts.conversationId || 'conv-1';
    this.conversationUrl = 'https://chatgpt.com/c/' + this.conversationId;
    this.ownedTabId = opts.tabId || 'tab-1';
    this.sent = [];
  }
  async send(text) { this.sent.push(text); const r = this.replies.shift() ?? 'DONE'; return { reply: typeof r === 'string' ? r : json(r), conversationId: this.conversationId }; }
}
class FakeExecutor {
  constructor(opts = {}) { this.sessionId = opts.sessionId || 'th-1'; this.calls = []; this.evidence = opts.evidence || []; this.success = opts.success !== false; }
  async execute(prompt) { this.calls.push(prompt); return { sessionId: this.sessionId, resultText: 'did:' + prompt, success: this.success, error: this.success ? null : 'boom', evidence: this.evidence }; }
}

const TASK1 = { control: 'TASK', instruction: 'create x.js', acceptance: [] };
const TASK2 = { control: 'TASK', instruction: 'create y.js', acceptance: [] };

test('startTask: goal -> 2 TASK->RESULT -> DONE -> completed; no duplicate codex', async () => {
  const brain = new FakeBrain([TASK1, TASK2, 'DONE']);
  const executor = new FakeExecutor({ sessionId: 'th-42' });
  const mgr = new TaskManager({ stateDir: dir() });
  const { taskId, state } = await mgr.startTask({ repoDir: 'r', goal: 'goal', brain, executor });
  assert.strictEqual(state.status, 'completed');
  assert.strictEqual(state.round, 2);
  assert.strictEqual(executor.calls.length, 2);
  assert.strictEqual(state.steps.length, 2);
  assert.deepStrictEqual(state.steps.map((s) => s.status), ['reviewed', 'reviewed']);
  assert.strictEqual(state.conversationId, 'conv-1');
  assert.strictEqual(state.codexSessionId, 'th-42');
  assert.strictEqual(state.taskId, taskId);
});

test('resume after one round (state persisted) continues without re-running step 1', async () => {
  const d = dir();
  const brain1 = new FakeBrain([TASK1, TASK2, 'DONE']);
  const ex1 = new FakeExecutor({ sessionId: 'th-9' });
  const mgr = new TaskManager({ stateDir: d });
  const { taskId } = await mgr.startTask({ repoDir: 'r', goal: 'g', brain: brain1, executor: ex1, maxRounds: 1 });
  // state should be at round 1, not completed
  const s1 = await mgr.load(taskId);
  assert.strictEqual(s1.status, 'running');
  assert.strictEqual(s1.round, 1);
  assert.strictEqual(ex1.calls.length, 1);

  // resume: fake brain returns DONE for the pending result send
  const brain2 = new FakeBrain(['DONE']);
  const ex2 = new FakeExecutor({ sessionId: 'th-9' });
  const resumed = await mgr.resumeTask({ taskId, brain: brain2, executor: ex2, sessionFactory: null });
  assert.strictEqual(resumed.state.status, 'completed');
  assert.strictEqual(resumed.state.round, 2);
  // step 1 was NOT re-executed; executor only got called for step 2
  assert.strictEqual(ex2.calls.length, 1);
});

test('recovery: step stuck in executing -> recovery_required, no auto re-run', async () => {
  const d = dir();
  const mgr = new TaskManager({ stateDir: d });
  const state = newTaskState({ repoDir: 'r', goal: 'g' });
  state.conversationId = 'conv-1';
  state.ownedTabId = 'tab-1';
  state.codexSessionId = 'th-7';
  state.lastControl = 'TASK';
  state.steps = [{ stepId: 'step-1', control: 'TASK', instruction: 'x', acceptance: [], status: 'executing' }];
  state.inFlightStep = 'step-1';
  saveState(d, state);
  const ex = new FakeExecutor({ sessionId: 'th-7' });
  const r = await mgr.resumeTask({ taskId: state.taskId, brain: new FakeBrain([]), executor: ex });
  assert.strictEqual(r.state.status, 'recovery_required');
  assert.strictEqual(ex.calls.length, 0, 'must not re-run a possibly-executed step');
});

test('ASK_USER -> awaiting_user', async () => {
  const brain = new FakeBrain([{ control: 'ASK_USER', question: 'which repo?' }]);
  const ex = new FakeExecutor();
  const mgr = new TaskManager({ stateDir: dir() });
  const { state } = await mgr.startTask({ repoDir: 'r', goal: 'g', brain, executor: ex });
  assert.strictEqual(state.status, 'awaiting_user');
});

test('acceptance gate: DONE with required acceptance not pass -> NOT completed', async () => {
  const brain = new FakeBrain([{ control: 'TASK', instruction: 'x', acceptance: [{ id: 'a1', required: true, text: 'x' }] }, 'DONE']);
  // explicit evidence reports a1 = fail -> gate blocks
  const ex = new FakeExecutor({ sessionId: 'th-1', evidence: [{ acceptanceId: 'a1', status: 'fail', kind: 'test', summary: 'failed' }], success: false });
  const mgr = new TaskManager({ stateDir: dir() });
  const { state } = await mgr.startTask({ repoDir: 'r', goal: 'g', brain, executor: ex });
  assert.notStrictEqual(state.status, 'completed');
  assert.strictEqual(state.status, 'awaiting_user');
  assert.ok(state.acceptanceBlock && state.acceptanceBlock.length >= 1);
});

test('cancelTask -> cancelled', async () => {
  const d = dir();
  const mgr = new TaskManager({ stateDir: d });
  const brain = new FakeBrain([TASK1, 'DONE']);
  const { taskId } = await mgr.startTask({ repoDir: 'r', goal: 'g', brain, executor: new FakeExecutor({ sessionId: 'th-1' }), maxRounds: 1 });
  const c = await mgr.cancelTask(taskId);
  assert.strictEqual(c.status, 'cancelled');
});