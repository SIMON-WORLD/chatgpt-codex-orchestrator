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

function jobMapDir(dataRoot) { return path.join(runtimePaths(dataRoot).runtime, 'job-maps'); }

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

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  }
}
