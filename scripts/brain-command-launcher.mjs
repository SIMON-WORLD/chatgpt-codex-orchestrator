// LEGACY / EXPERIMENTAL RUNTIME: this module is NOT the canonical Alpha.4 Direct Brain
//
// Deterministic sequence for `$brain-command <goal>`:
//   load config -> deterministic repo resolution -> fast preflight (trusted-REPL
//   aware) -> (worker is started by the ordinary-node entrypoint) -> open ChatGPT
//   Brain -> TaskService.createTask -> advanceTask loop -> DONE / ASK_USER /
//   recovery_required.
//
// Runs in the Codex node-REPL (owns the in-app-browser BrainSession). It does NOT
// inspect implementation source: it only uses the public bootstrap + TaskService API.
// The worker must be started by the environment first via
// scripts/brain-command-worker.mjs (it writes the deterministic ready file). On every
// terminal/error path the worker is shut down automatically.
//
// Runtime environment: the REPL may not expose a global `process`. All env/cwd/home
// access goes through the runtime-env adapter (src/runtime-env.js) which reads the real
// process in normal Node and the safe nodeRepl surface in the trusted REPL. The agent
// never shims `process`, never passes preflight:false, and never supplies a ready file.
import fs from 'node:fs';
import path from 'node:path';
import { loadBrainCommandConfig, resolveRepoDir, fastPreflight } from '../src/bootstrap.js';
import { TaskService } from '../src/task-service.js';
import { CodexWorkerClient } from '../src/worker-client.js';
import { InAppBrowserTransport, openBrainSession, openBrainSessionExisting } from '../src/iab-transport.js';
import { runtimePaths, canonicalReadyFile } from '../src/runtime-paths.js';
import { getCwd, getCodexHome, isTrustedRepl } from '../src/runtime-env.js';

export class BrainCommandLaunchError extends Error {
  constructor(msg, extra = {}) { super(msg); this.name = 'BrainCommandLaunchError'; Object.assign(this, extra); }
}

export function codexHomePath(scope = undefined) {
  return getCodexHome(scope);
}

export function loadConfig(configPath = null, codexHome = codexHomePath()) {
  const p = configPath || path.join(codexHome, 'brain-command', 'config.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return loadBrainCommandConfig({ codexHome });
}

// Deterministic worker ready-file path (shared with the worker bootstrap).
export function defaultReadyFile(dataRoot) {
  return canonicalReadyFile(dataRoot);
}

// `executor` facade used by TaskService; forwards to the worker.
export function workerFacade(worker) {
  return {
    async execute(prompt) { return worker.execute(prompt); },
    get sessionId() { return worker.sessionId; },
  };
}

// Worker-backed data store. TaskService/TaskManager persistence is async, so state
// is written through the worker host into config.dataRoot (durable after exit). Locking
// also goes through the worker; each acquire returns an async release function.
export function createDataStore(worker) {
  return {
    save: async (state) => { await worker.callOp('state.save', { state }); },
    load: async (taskId) => { const r = await worker.callOp('state.load', { taskId }); return r.state ?? null; },
    list: async () => ((await worker.callOp('state.list'))?.tasks) || [],
    log: async (entry) => { await worker.callOp('log.write', { entry }); },
    projectsBind: async (rec) => { await worker.callOp('projects.bind', { rec }); },
    projectsGet: async (repoDir) => ((await worker.callOp('projects.get', { repoDir }))?.rec) || null,
    acquireLock: async (taskId) => {
      const msg = await worker.callOp('lock.acquire', { taskId });
      if (msg && msg.error) throw new Error(msg.error);
      return async () => { try { await worker.callOp('lock.release', { taskId }); } catch (e) {} };
    },
    releaseLock: async (taskId) => { try { await worker.callOp('lock.release', { taskId }); } catch (e) {} },
  };
}

// Runtime object consumed by TaskService. The IAB Brain transport is shared so every
// rebind reuses the same owned tab (never follows tabs.selected()).
export function buildRuntime({ worker, turnOptions = {}, transport = null }) {
  const t = transport || new InAppBrowserTransport();
  return {
    makeDataStore: () => createDataStore(worker),
    makeExecutor: () => workerFacade(worker),
    openBrain: () => openBrainSession(t, { turnOptions }),
    reopenBrain: (opts = {}) => openBrainSessionExisting(t, { ...opts, turnOptions }),
    connectWorker: async () => worker,
    teardownWorker: async (w) => { try { await w.shutdown(); } catch (e) {} },
  };
}

// Turn-sliced TaskService loop: createTask then repeatedly advanceTask until a
// terminal status. Never runs the old LoopController/runRuntimeHost path.
export async function runTaskLoop({ svc, taskId, brain, executor, maxRounds = Infinity }) {
  const rounds = [];
  let guard = 0;
  while (guard++ < 2000) {
    const r = await svc.advanceTask(taskId, { brain, executor });
    rounds.push({ status: r.status, nextAction: r.nextAction, progressed: r.progressed });
    if (['completed', 'cancelled', 'recovery_required', 'awaiting_user'].includes(r.status)) break;
    if (guard >= maxRounds) break;
  }
  const final = await svc.getTaskStatus(taskId);
  return {
    taskId,
    status: final.status,
    lastControl: final.lastControl,
    rounds,
    terminal: ['completed', 'cancelled', 'recovery_required', 'awaiting_user'].includes(final.status),
  };
}

// Canonical brain-command launcher. `worker`/`brainSession` may be injected for
// offline tests; otherwise the worker is read from the canonical ready file and the
// Brain is opened in the in-app browser. `envScope` may be injected in tests to
// simulate a trusted-REPL-like environment (no global process); normal callers omit it.
export async function runBrainCommand({
  goal,
  config = null,
  configPath = null,
  repoDir = null,
  readyFile = null,
  worker = null,
  brainSession = null,
  conversation = 'new',
  maxRounds = Infinity,
  turnOptions = {},
  preflight = true,
  envScope = undefined,
  legacyOptIn = false,
} = {}) {
  if (!goal) throw new BrainCommandLaunchError('goal is required');
  if (!legacyOptIn && process.env.BRAIN_COMMAND_LEGACY !== '1') {
    throw new BrainCommandLaunchError('legacy launcher is non-canonical/experimental; set BRAIN_COMMAND_LEGACY=1 or pass { legacyOptIn: true } to opt in');
  }

  const trustedRepl = isTrustedRepl(envScope);
  const cfg = config || loadConfig(configPath, getCodexHome(envScope));
  const r = resolveRepoDir({ cwd: getCwd(envScope), explicitRepoPath: null, explicitGitHubRepo: null, config: cfg });
  if (!r.repoDir) throw new BrainCommandLaunchError('repo not resolvable: ' + r.source);
  const targetRepo = repoDir || r.repoDir;

  // Actually probe the IAB/Brain transport if we are going to open a real Brain, so
  // preflight reports it honestly (PASS when probed+ok, FAIL when probed+broken) rather
  // than falsely claiming PASS. When a brain session is injected (tests) or preflight is
  // skipped, the probe is left DEFERRED.
  let transport = null;
  let iabCallable = undefined;
  if (!brainSession) {
    transport = new InAppBrowserTransport();
    if (preflight) {
      try { await transport.connect(); iabCallable = true; } catch { iabCallable = false; }
    }
  }

  if (preflight) {
    // For the trusted REPL, data-root writability is owned/checked by the worker
    // bootstrap (it writes there); the launcher must NOT fail because it personally
    // cannot write the data root. We pass dataRootWritable=true to reflect that the
    // worker already verified+owns it. IAB is probed here.
    const pre = fastPreflight({
      config: cfg,
      probes: { cwd: getCwd(envScope), repoDir: r.repoDir, repoExists: true, dataRootWritable: true, iabCallable },
    });
    if (!pre.pass) throw new BrainCommandLaunchError('fast preflight failed', { checks: pre.checks, iabCallable, trustedRepl });
  }

  const dataRoot = cfg.dataRoot;
  let w = worker;
  if (!w) {
    const rf = readyFile || defaultReadyFile(dataRoot);
    if (!fs.existsSync(rf)) {
      throw new BrainCommandLaunchError(
        'worker not started: run the worker bootstrap first (node <orchestratorRoot>/scripts/brain-command-worker.mjs --config "<config>")',
        { readyFile: rf }
      );
    }
    const ready = JSON.parse(fs.readFileSync(rf, 'utf8'));
    w = new CodexWorkerClient({ host: ready.host, port: ready.port, token: ready.token });
    await w.connect();
  }

  const rt = buildRuntime({ worker: w, turnOptions, transport });
  // Durable task state lives under config.dataRoot (worker-owned), via the worker store.
  const stateDir = runtimePaths(dataRoot).tasks;
  const svc = new TaskService({ stateDir, runtime: rt });

  let brain = brainSession;
  if (!brain) brain = await rt.openBrain();
  const executor = rt.makeExecutor(w);

  const { taskId } = await svc.createTask({ goal, repoDir: targetRepo, conversation });
  // Bind the worker client to the task identity so every subsequent request carries it.
  w.taskId = taskId;
  try {
    const result = await runTaskLoop({ svc, taskId, brain, executor, maxRounds });
    result.conversationId = brain.conversationId || null;
    result.conversationUrl = brain.conversationUrl || null;
    result.ownedTabId = brain.ownedTabId || null;
    result.repoDir = targetRepo;
    return result;
  } finally {
    try { await w.shutdown(); } catch (e) {}
  }
}
