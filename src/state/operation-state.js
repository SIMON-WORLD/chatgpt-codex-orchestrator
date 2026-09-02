// chatgpt-codex-orchestrator: minimal durable edit operation state (v0.2 M3).
// Persists just enough for retry/reconciliation + idempotent replay. Not a generic
// workflow engine. Uses the existing runtime data-root, atomic write (tmp+rename).

import fs from 'node:fs';
import path from 'node:path';
import { runtimePaths } from '../runtime-paths.js';

export class OperationState {
  constructor({ dataRoot = null } = {}) {
    this.dir = path.join(runtimePaths(dataRoot).runtime, 'ops');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  _file(id) { return path.join(this.dir, id + '.json'); }
  save(id, entry) {
    const e = { ...entry, changeSetId: id, updatedAt: Date.now() };
    const file = this._file(id);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(e, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return e;
  }
  load(id) {
    const file = this._file(id);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }
  update(id, patch) {
    const cur = this.load(id) || { changeSetId: id };
    return this.save(id, { ...cur, ...patch });
  }
}

export const OPERATION_STATUSES = ['previewed', 'applying', 'applied', 'recovery_required'];
