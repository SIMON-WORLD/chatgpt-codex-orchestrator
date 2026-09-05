// chatgpt-codex-orchestrator: durable local job -> App Server thread/turn mapping
// (v0.2 M1). Persists threadId/turnId as soon as they become known and before the
// executor acknowledges a successful start to the caller, so a lost local response
// can be reconciled by identity rather than duplicating a turn.
//
// Since v0.2 M7-C each job entry also carries a durable orchestration binding
// (taskId, stepId, identity) so a later Brain session can recover the correct prior
// Codex execution from a natural-language / durable orchestration identity without
// manually preserving the internal job/thread/turn ids. The binding is persisted with
// the job and survives Local MCP process restart (see AppServerExecutor.recover).
//
// Storage: under the existing runtime data-root (runtime/job-maps).
// No secrets. Atomic write (tmp + rename). No distributed locking.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runtimePaths } from '../runtime-paths.js';

export function makeJobId() { return crypto.randomUUID(); }

export function makeMutationUnitId() { return crypto.randomUUID(); }

const RECOVERY_RISK_STATES = new Set(['created', 'thread_ready', 'starting', 'running', 'recovery_required']);
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'interrupted']);

function jobMapDir(dataRoot) { return path.join(runtimePaths(dataRoot).runtime, 'job-maps'); }

function rootsEqual(a, b) {
  if (!a || !b) return false;
  const x = path.resolve(String(a)).replace(/[\\/]+$/, '');
  const y = path.resolve(String(b)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function sameWorkspace(job, { workspaceId = null, workspaceRoot = null } = {}) {
  if (workspaceId && job.workspaceId && job.workspaceId === workspaceId) return true;
  if (workspaceRoot && job.workspaceRoot && rootsEqual(job.workspaceRoot, workspaceRoot)) return true;
  return false;
}

function missingBinding(job) {
  return job.taskId == null && job.stepId == null && job.identity == null;
}

function matchesBinding(job, { taskId = null, stepId = null, identity = null } = {}) {
  let supplied = 0;
  for (const [key, value] of [['taskId', taskId], ['stepId', stepId], ['identity', identity]]) {
    if (value == null) continue;
    supplied += 1;
    if (job[key] !== value) return false;
  }
  return supplied > 0;
}

// Baseline durable job entry. Binding fields default to null and are set when the
// caller supplies a durable orchestration identity to start/continue.
function defaultJobEntry(jobId) {
  return {
    jobId,
    taskId: null,
    stepId: null,
    identity: null,
    threadId: null,
    turnId: null,
    mutationUnitId: null,
    workspaceRoot: null,
    workspaceId: null,
    state: 'none',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export class JobMap {
  constructor({ dataRoot = null } = {}) {
    this.dataRoot = dataRoot || runtimePaths().dataRoot;
    this.dir = jobMapDir(this.dataRoot);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _file(jobId) { return path.join(this.dir, `${jobId}.json`); }

  create() {
    const jobId = makeJobId();
    return this.save(jobId, defaultJobEntry(jobId));
  }

  save(jobId, entry) {
    const e = { ...entry, jobId, updatedAt: Date.now() };
    const file = this._file(jobId);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(e, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return e;
  }

  load(jobId) {
    const file = this._file(jobId);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  update(jobId, patch) {
    const cur = this.load(jobId) || defaultJobEntry(jobId);
    return this.save(jobId, { ...cur, ...patch });
  }

  findByThread(threadId) {
    if (!threadId) return null;
    return this.list().find((j) => j.threadId === threadId) || null;
  }

  // Bounded identity lookup (v0.2 M7-C). Returns the jobs whose durable orchestration
  // binding matches the supplied non-null identity fields. No workspace filtering and
  // no 'most recent' ordering here: workspace membership + fail-closed semantics live in
  // AppServerExecutor.recover, which never guesses.
  findByBinding({ taskId = null, stepId = null, identity = null } = {}) {
    return this.list().filter((j) => {
      if (taskId != null && j.taskId !== taskId) return false;
      if (stepId != null && j.stepId !== stepId) return false;
      if (identity != null && j.identity !== identity) return false;
      return true;
    });
  }

  // Strict internal scan used only by recovery preflight. Unlike list(), this preserves
  // evidence that a durable entry could not be parsed so bootstrap recovery can fail
  // closed rather than silently treating corruption as absence.
  _scanStrict() {
    if (!fs.existsSync(this.dir)) return { jobs: [], corruptCount: 0 };
    const jobs = [];
    let corruptCount = 0;
    for (const file of fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'))) {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8'));
        if (!job || typeof job !== 'object' || !job.jobId) corruptCount += 1;
        else jobs.push(job);
      } catch {
        corruptCount += 1;
      }
    }
    return { jobs, corruptCount };
  }

  // Internal selector shared by recovery preflight and bounded remediation. It preserves
  // exactly the same semantic scope and dangerous-candidate rules without exposing a
  // generic job browser. Callers must never sort or select by timestamps.
  recoveryPreflightCandidates({ workspaceId = null, workspaceRoot = null, taskId = null, stepId = null, identity = null } = {}) {
    if (workspaceId == null && workspaceRoot == null) {
      return { ok: false, error: 'bad_request', reason: 'recovery preflight requires a workspace' };
    }
    if (taskId == null && stepId == null && identity == null) {
      return { ok: false, error: 'bad_request', reason: 'recovery preflight requires semantic task scope (taskId/stepId/identity)' };
    }
    const { jobs, corruptCount } = this._scanStrict();
    if (corruptCount > 0) {
      return { ok: false, error: 'corrupt', reason: 'durable Codex job state is unreadable; refusing to infer absence' };
    }
    const scope = { workspaceId, workspaceRoot };
    const binding = { taskId, stepId, identity };
    const dangerous = [];
    for (const job of jobs) {
      if (!matchesBinding(job, binding) || sameWorkspace(job, scope)) continue;
      if (TERMINAL_JOB_STATES.has(job.state)) continue;
      if (RECOVERY_RISK_STATES.has(job.state)) return { ok: false, error: 'foreign', reason: 'the current semantic binding has a non-terminal Codex execution in another workspace' };
      return { ok: false, error: 'lifecycle_unknown', reason: 'a foreign semantic match has an unknown lifecycle; refusing to infer safety' };
    }
    for (const job of jobs) {
      if (!sameWorkspace(job, scope) || TERMINAL_JOB_STATES.has(job.state)) continue;
      const unbound = missingBinding(job);
      const matched = matchesBinding(job, binding);
      if (!unbound && !matched) continue;
      if (!RECOVERY_RISK_STATES.has(job.state)) return { ok: false, error: 'lifecycle_unknown', reason: 'a would-be recovery candidate has an unknown lifecycle; refusing to infer safety' };
      dangerous.push({ job, unbound, matched });
    }
    return { ok: true, dangerous };
  }

  // Brain Continuity bootstrap preflight. This is deliberately NOT a generic job list:
  // the caller must provide semantic scope, terminal history is ignored, timestamps are
  // never used for selection, ambiguity discloses only a count, and only one uniquely
  // dangerous execution may expose the exact internal recovery identity needed by Brain.
  recoveryPreflight({ workspaceId = null, workspaceRoot = null, taskId = null, stepId = null, identity = null } = {}) {
    const selected = this.recoveryPreflightCandidates({ workspaceId, workspaceRoot, taskId, stepId, identity });
    if (!selected.ok) return selected;
    const { dangerous } = selected;

    if (dangerous.length === 0) {
      return {
        ok: true,
        status: 'safe_to_start',
        dangerousCandidateCount: 0,
        nextAction: 'codex_start_allowed',
      };
    }

    if (dangerous.length > 1) {
      return {
        ok: false,
        error: 'ambiguous',
        reason: 'multiple recovery-risk Codex executions may correspond to this bootstrap task; no most-recent guessing',
        dangerousCandidateCount: dangerous.length,
      };
    }

    const { job, unbound } = dangerous[0];
    if (unbound) {
      return {
        ok: true,
        status: 'recover_existing',
        dangerousCandidateCount: 1,
        nextAction: 'codex_reconcile',
        recovery: {
          mode: 'job_id',
          jobId: job.jobId,
          state: job.state,
        },
      };
    }

    return {
      ok: true,
      status: 'recover_existing',
      dangerousCandidateCount: 1,
      nextAction: 'codex_recover',
      recovery: {
        mode: 'semantic_binding',
        jobId: job.jobId,
        state: job.state,
        binding: {
          taskId: job.taskId ?? null,
          stepId: job.stepId ?? null,
          identity: job.identity ?? null,
        },
      },
    };
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  }
}
