// chatgpt-codex-orchestrator: durable canonical launcher state + restart persistence.
//
// Phase A writes real Alpha.2 task state on disk (under config.dataRoot) via the
// worker-backed async TaskService runtime, then STOP before DONE. Phase B uses a FRESH
// worker (new instance, empty cache) and a FRESH TaskService over the same dataRoot,
// loads the same taskId, and proves the persisted PLAN/step/evidence/conversation
// binding/session identity survive and are recoverable to completion.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskService } from '../src/legacy/task-service.js';
import { buildRuntime } from '../scripts/brain-command-launcher.mjs';
import { runtimePaths } from '../src/runtime-paths.js';

function tmpDataRoot() { const d = path.join(os.tmpdir(), 'bc-durable-' + Date.now()); fs.mkdirSync(d, { recursive: true }); return d; }
function tmpRepo() { const d = path.join(os.tmpdir(), 'bc-repo-' + Date.now()); fs.mkdirSync(d, { recursive: true }); return d; }

// The worker persists state.save/load to disk under dataRoot (fresh instances read from
// disk), proving cross-instance on-disk persistence rather than in-memory survival.
class MockWorker {
  constructor(dataRoot, { failOnExecute = false } = {}) {
    this.dataRoot = dataRoot; this.cache = new Map(); this.taskId = null;
    this.executeCalls = 0; this.shutdownCalled = false; this.sessionId = 'th-1';
    this.failOnExecute = failOnExecute;
  }
  async connect() {}
  async callOp(op, payload) {
    const tasksDir = path.join(this.dataRoot, 'tasks');
    const locksDir = path.join(this.dataRoot, 'locks');
    if (op === 'state.save') { fs.mkdirSync(tasksDir, { recursive: true }); const f = path.join(tasksDir, payload.state.taskId + '.json'); fs.writeFileSync(f, JSON.stringify(payload.state)); this.cache.set(payload.state.taskId, payload.state); return { ok: true }; }
    if (op === 'state.load') { const f = path.join(tasksDir, payload.taskId + '.json'); if (fs.existsSync(f)) { const s = JSON.parse(fs.readFileSync(f, 'utf8')); this.cache.set(payload.taskId, s); return { state: s }; } return { state: this.cache.get(payload.taskId) ?? null }; }
    if (op === 'state.list') { fs.mkdirSync(tasksDir, { recursive: true }); return { tasks: fs.readdirSync(tasksDir).filter((x) => x.endsWith('.json')).map((x) => x.replace(/\.json$/, '')) }; }
    if (op === 'lock.acquire') { fs.mkdirSync(locksDir, { recursive: true }); return { ok: true }; }
    if (op === 'lock.release') { return { ok: true }; }
    if (op === 'log.write') { return { ok: true }; }
    return { ok: true };
  }
  async execute() {
    this.executeCalls++;
    if (this.failOnExecute) throw new Error('codex exec failed');
    return {
      sessionId: this.sessionId,
      resultText: 'done\nEVIDENCE: [{"acceptanceId":"a1","status":"pass","kind":"cmd","summary":"ok"}]',
      success: true,
      error: null,
    };
  }
  async shutdown() { this.shutdownCalled = true; return true; }
}

class MockBrain {
  constructor(replies) { this.replies = [...replies]; this.conversationId = 'conv-1'; this.conversationUrl = 'https://chatgpt.com/c/conv-1'; this.ownedTabId = 'tab-1'; }
  async send() { return { reply: this.replies.shift() ?? 'DONE', conversationId: this.conversationId, conversationUrl: this.conversationUrl, ownedTabId: this.ownedTabId }; }
}

const PLAN = JSON.stringify({
  control: 'PLAN', stepId: 'p1',
  taskContract: { title: 'verify', goal: 'g' },
  plan: { steps: [{ stepId: 'step-1', milestoneId: 'm1' }], milestones: [{ milestoneId: 'm1', verification: 'step' }] },
  verificationPolicy: { defaultLevel: 'step' },
});
const TASK = JSON.stringify({ control: 'TASK', stepId: 'step-1', instruction: 'do the read-only check', acceptance: [{ id: 'a1', requirement: 'evidence recorded' }] });

function newInstance(dataRoot, repo, worker) {
  const rt = buildRuntime({ worker });
  const svc = new TaskService({ stateDir: runtimePaths(dataRoot).tasks, runtime: rt });
  return { rt, svc, exec: rt.makeExecutor(worker) };
}

async function driveN(svc, taskId, brain, executor, n) {
  let last;
  for (let i = 0; i < n; i++) last = await svc.advanceTask(taskId, { brain, executor });
  return last;
}

async function driveUntil(svc, taskId, brain, executor, max = 30) {
  let r;
  for (let i = 0; i < max; i++) {
    r = await svc.advanceTask(taskId, { brain, executor });
    if (['completed', 'cancelled', 'recovery_required', 'awaiting_user'].includes(r.status)) return r;
  }
  return r;
}

test('restart persistence: Alpha.2 state survives a fresh runtime and is recoverable', async () => {
  const dataRoot = tmpDataRoot();
  const repo = tmpRepo();

  // Phase A: progress through PLAN -> TASK -> execute -> evidence -> reviewed, then STOP before DONE.
  const workerA = new MockWorker(dataRoot);
  const { svc: svcA, exec: execA } = newInstance(dataRoot, repo, workerA);
  const { taskId } = await svcA.createTask({ goal: 'verify', repoDir: repo, conversation: 'new' });
  workerA.taskId = taskId;
  const rA = await driveN(svcA, taskId, new MockBrain([PLAN, TASK]), execA, 6);
  assert.notStrictEqual(rA.status, 'completed', 'stopped before DONE');

  // state path is under dataRoot
  const statePath = path.join(runtimePaths(dataRoot).tasks, taskId + '.json');
  assert.ok(fs.existsSync(statePath), 'task state persisted under dataRoot');

  // Phase B: fresh worker (empty cache) + fresh TaskService over the same dataRoot.
  const workerB = new MockWorker(dataRoot);
  const { svc: svcB, exec: execB } = newInstance(dataRoot, repo, workerB);
  workerB.taskId = taskId;
  const loaded = await svcB.mgr.load(taskId);
  assert.strictEqual(loaded?.taskId, taskId);
  assert.ok(loaded?.plan && Array.isArray(loaded.plan.steps), 'plan persisted');
  assert.ok(Array.isArray(loaded.completedSteps) && loaded.completedSteps.includes('step-1'), 'completedSteps persisted');
  assert.ok(Array.isArray(loaded.evidenceLedger) && loaded.evidenceLedger.length > 0, 'evidenceLedger persisted');
  assert.strictEqual(loaded.conversationId, 'conv-1', 'conversation binding persisted');
  assert.strictEqual(loaded.ownedTabId, 'tab-1', 'owned tab binding persisted');
  assert.strictEqual(loaded.codexSessionId, 'th-1', 'codex session identity persisted');

  // Fresh runtime can resume and reach completion from the persisted DONE pending control.
  const rB = await driveUntil(svcB, taskId, new MockBrain([]), execB);
  assert.strictEqual(rB.status, 'completed');
  workerB.shutdownCalled = true;
});

test('recovery_required is recoverable and not silently rerun', async () => {
  const dataRoot = tmpDataRoot();
  const repo = tmpRepo();

  const workerA = new MockWorker(dataRoot, { failOnExecute: true });
  const { svc: svcA, exec: execA } = newInstance(dataRoot, repo, workerA);
  const { taskId } = await svcA.createTask({ goal: 'verify', repoDir: repo, conversation: 'new' });
  workerA.taskId = taskId;
  let err = null;
  try {
    await driveN(svcA, taskId, new MockBrain([PLAN, TASK]), execA, 6);
  } catch (e) { err = e; }
  assert.ok(err, 'the executing step should surface an error');

  const workerB = new MockWorker(dataRoot);
  const { svc: svcB, exec: execB } = newInstance(dataRoot, repo, workerB);
  workerB.taskId = taskId;
  const loaded = await svcB.mgr.load(taskId);
  const step = loaded.inFlightStep ? (Array.isArray(loaded.steps) ? loaded.steps.find((s) => s.stepId === loaded.inFlightStep) : null) : null;
  assert.ok(step && step.status === 'executing', 'step left executing');
  const r = await svcB.advanceTask(taskId, { brain: new MockBrain([]), executor: execB });
  assert.strictEqual(r.status, 'recovery_required');
  assert.strictEqual(workerB.executeCalls, 0, 'recovery must not re-run the stuck step');
});

test('completed task remains readable after runtime shutdown', async () => {
  const dataRoot = tmpDataRoot();
  const repo = tmpRepo();

  const workerA = new MockWorker(dataRoot);
  const { svc: svcA, exec: execA } = newInstance(dataRoot, repo, workerA);
  const { taskId } = await svcA.createTask({ goal: 'verify', repoDir: repo, conversation: 'new' });
  workerA.taskId = taskId;
  const rA = await driveUntil(svcA, taskId, new MockBrain([TASK, 'DONE']), execA);
  assert.strictEqual(rA.status, 'completed');

  const workerB = new MockWorker(dataRoot);
  const { svc: svcB } = newInstance(dataRoot, repo, workerB);
  const loaded = await svcB.mgr.load(taskId);
  assert.strictEqual(loaded?.status, 'completed');
  const st = await svcB.getTaskStatus(taskId);
  assert.strictEqual(st.status, 'completed');
});
