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

// --- trusted-REPL runtime adapter coverage (no process shim, no preflight:false) ---
import { canonicalReadyFile, runtimePaths } from '../src/runtime-paths.js';
import { isTrustedRepl } from '../src/runtime-env.js';
import { fastPreflight } from '../src/bootstrap.js';
import { defaultReadyFile, codexHomePath } from '../scripts/brain-command-launcher.mjs';

// Mimics the Codex trusted REPL: nodeRepl.rpc available, but scope exposes NO process.
function trustedLauncherScope({ cwd }) {
  return { nodeRepl: { rpc() { return null; }, env: {}, cwd, homeDir: null } };
}

test('worker bootstrap and launcher agree on the canonical ready-file path automatically', () => {
  const dataRoot = path.join(os.tmpdir(), 'bc-ready-' + Date.now());
  const expected = path.join(runtimePaths(dataRoot).runtime, 'brain-command.ready.json');
  assert.strictEqual(canonicalReadyFile(dataRoot), expected);
  assert.strictEqual(defaultReadyFile(dataRoot), expected, 'launcher defaultReadyFile === canonicalReadyFile');
  // Worker bootstrap derives the same canonical path when --ready-file is omitted.
  const workerSrc = fs.readFileSync(path.join(process.cwd(), 'scripts', 'brain-command-worker.mjs'), 'utf8');
  assert.ok(workerSrc.includes('canonicalReadyFile(dataRoot)'), 'worker derives the canonical ready file');
});

test('preflight ownership: trusted-REPL launcher passes dataRootWritable=true and does not require preflight:false', () => {
  const repo = tmpRepo();
  const cfg2 = cfg(repo);
  cfg2.codexJs = path.join(repo, 'codex.js');
  fs.mkdirSync(path.dirname(cfg2.codexJs), { recursive: true });
  fs.writeFileSync(cfg2.codexJs, '//', 'utf8');
  // Trusted-REPL probe set: IAB callable, data root owned by worker -> PASS.
  const ok = fastPreflight({ config: cfg2, probes: { cwd: repo, repoDir: repo, repoExists: true, dataRootWritable: true, iabCallable: true } });
  assert.strictEqual(ok.pass, true, JSON.stringify(ok.checks));
  const dr = ok.checks.find((c) => c.check === 'data-root-writable');
  assert.strictEqual(dr.status, 'PASS', 'worker-owned data root does not fail the REPL');
  // A genuinely broken IAB is still reported honestly.
  const ko = fastPreflight({ config: cfg2, probes: { cwd: repo, repoDir: repo, repoExists: true, dataRootWritable: true, iabCallable: false } });
  assert.strictEqual(ko.pass, false);
  assert.ok(ko.checks.some((c) => c.check === 'iab-callable' && c.status === 'FAIL'));
});

test('runBrainCommand initializes in a trusted-REPL-like scope without a process global shim', async () => {
  const repo = tmpRepo();
  const cfgPath = path.join(repo, 'bc-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg(repo)), 'utf8');
  const worker = new MockWorker();
  const brain = new MockBrain([TASK, 'DONE']);
  const envScope = trustedLauncherScope({ cwd: repo });
  const r = await runBrainCommand({ goal: 'g', config: null, configPath: cfgPath, repoDir: repo, worker, brainSession: brain, preflight: false, envScope });
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.terminal, true);
  assert.strictEqual(isTrustedRepl(envScope), true, 'scope is detected as trusted REPL');
  assert.strictEqual(r.repoDir, repo);
});

test('launcher codexHomePath resolves without a process global', () => {
  const scope = trustedLauncherScope({ cwd: 'C:\\x' });
  assert.strictEqual(path.basename(codexHomePath(scope)), '.codex');
});

test('launcher uses the runtime-env adapter and never monkey-patches globalThis.process', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'brain-command-launcher.mjs'), 'utf8');
  assert.ok(src.includes('getCwd'), 'launcher uses runtime env cwd');
  assert.ok(src.includes('getCodexHome'), 'launcher uses runtime env codex home');
  assert.ok(!src.includes('globalThis.process'), 'no globalThis.process monkey-patch');
  assert.ok(!/\bprocess\s*=/.test(src), 'no process assignment');
  assert.ok(/preflight = true/.test(src), 'preflight stays default-true for the canonical path');
});
