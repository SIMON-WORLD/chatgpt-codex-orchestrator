// chatgpt-codex-orchestrator: canonical brain-command launcher wiring (offline).
// Verifies the launcher uses TaskService.createTask/advanceTask (NOT the legacy
// LoopController), wires worker auth (via CodexWorkerClient, tested separately), binds
// the worker client to the generated taskId, and shuts the worker down automatically on
// the terminal/error path. Uses injected worker/brain so no in-app browser is needed.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBrainCommand } from '../scripts/brain-command-launcher.mjs';

function tmpRepo() { const d = path.join(os.tmpdir(), 'bc-repo-' + Date.now()); fs.mkdirSync(d, { recursive: true }); return d; }

class MockWorker {
  constructor({ failOnExecute = false } = {}) {
    this.store = new Map(); this.executeCalls = 0; this.shutdownCalled = false;
    this.sessionId = 'th-1'; this.failOnExecute = failOnExecute; this.taskId = null;
  }
  async connect() {}
  async callOp(op, payload) {
    if (op === 'state.save') { this.store.set(payload.state.taskId, payload.state); return { ok: true }; }
    if (op === 'state.load') { return { state: this.store.get(payload.taskId) ?? null }; }
    if (op === 'state.list') { return { tasks: [...this.store.keys()] }; }
    if (op === 'lock.acquire') { return { ok: true }; }
    if (op === 'lock.release') { return { ok: true }; }
    return { ok: true };
  }
  async execute() {
    this.executeCalls++;
    if (this.failOnExecute) throw new Error('codex exec failed');
    return { sessionId: this.sessionId, resultText: 'done', success: true, error: null };
  }
  async shutdown() { this.shutdownCalled = true; return true; }
}

class MockBrain {
  constructor(replies) { this.replies = [...replies]; this.conversationId = 'conv-1'; this.conversationUrl = 'https://chatgpt.com/c/conv-1'; this.ownedTabId = 'tab-1'; }
  async send() { return { reply: this.replies.shift() ?? 'DONE', conversationId: this.conversationId, conversationUrl: this.conversationUrl, ownedTabId: this.ownedTabId }; }
}

const TASK = JSON.stringify({ control: 'TASK', stepId: 'step-1', instruction: 'do the read-only check', acceptance: [] });

function cfg(repo) {
  return { orchestratorRoot: repo, dataRoot: os.tmpdir(), workspaceRoot: repo, defaultBrain: 'chatgpt', defaultExecutor: 'codex', defaultConversationMode: 'new' };
}

test('runBrainCommand uses TaskService/createTask/advanceTask, binds worker taskId, reaches DONE, shuts worker down', async () => {
  const repo = tmpRepo();
  const worker = new MockWorker();
  const brain = new MockBrain([TASK, 'DONE']);
  const r = await runBrainCommand({ goal: 'g', config: cfg(repo), repoDir: repo, worker, brainSession: brain, preflight: false });
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.terminal, true);
  assert.ok(worker.executeCalls >= 1, 'codex executor was invoked');
  assert.strictEqual(worker.shutdownCalled, true, 'worker shut down on terminal path');
  assert.strictEqual(r.conversationId, 'conv-1');
  assert.strictEqual(worker.taskId, r.taskId, 'canonical worker bound to generated taskId');
  assert.ok(r.rounds.length >= 1);
});

test('runBrainCommand shuts worker down even when the loop errors', async () => {
  const repo = tmpRepo();
  const worker = new MockWorker({ failOnExecute: true });
  const brain = new MockBrain([TASK]);
  let err = null;
  try {
    await runBrainCommand({ goal: 'g', config: cfg(repo), repoDir: repo, worker, brainSession: brain, preflight: false });
  } catch (e) { err = e; }
  assert.ok(err, 'an error should propagate');
  assert.strictEqual(worker.shutdownCalled, true, 'worker shut down on error path too');
});

test('launcher source uses TaskService/advanceTask and does NOT import LoopController', async () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'brain-command-launcher.mjs'), 'utf8');
  assert.ok(src.includes('TaskService'));
  assert.ok(src.includes('advanceTask'));
  assert.ok(src.includes('createTask'));
  assert.ok(!src.includes('loop-controller'), 'launcher must not import legacy LoopController');
});
