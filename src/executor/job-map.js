// chatgpt-codex-orchestrator: durable local job -> App Server thread/turn mapping
// (v0.2 M1). Persists threadId/turnId as soon as they become known and before the
// executor acknowledges a successful start to the caller, so a lost local response
// can be reconciled by identity rather than duplicating a turn.
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

export class JobMap {
  constructor({ dataRoot = null } = {}) {
    this.dataRoot = dataRoot || runtimePaths().dataRoot;
    this.dir = jobMapDir(this.dataRoot);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _file(jobId) { return path.join(this.dir, `${jobId}.json`); }

  create() {
    const jobId = makeJobId();
    const entry = { jobId, threadId: null, turnId: null, state: 'none', createdAt: Date.now(), updatedAt: Date.now() };
    return this.save(jobId, entry);
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
    const cur = this.load(jobId) || { jobId, threadId: null, turnId: null, state: 'none', createdAt: Date.now() };
    return this.save(jobId, { ...cur, ...patch });
  }

  findByThread(threadId) {
    if (!threadId) return null;
    return this.list().find((j) => j.threadId === threadId) || null;
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  }
}
