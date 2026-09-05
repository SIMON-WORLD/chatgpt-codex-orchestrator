// chatgpt-codex-orchestrator: one canonical Governance runtime writer per
// namespace/dataRoot (Brain Continuity core). This is a lightweight local guard, NOT
// a distributed lock manager: it prevents two Local MCP/runtime processes from
// concurrently owning the same Governance namespace as independent writers and fails
// closed on contention. It reuses the repo's proven crash-safe lock pattern (O_EXCL +
// pid + heartbeat + stale reclaim from src/task-lock.js).
//
// Semantics:
//   - First writer in a namespace acquires the namespace writer slot.
//   - A second writer in the same namespace fails closed (writer_conflict) while the
//     slot owner is alive and its heartbeat is fresh.
//   - A dead owner is reclaimed immediately (crash/restart continuity).
//   - A live-but-idle owner (heartbeat stale past the window) may be reclaimed after
//     the stale window; the guard is intentionally not a distributed lease service.
//   - Clean shutdown releases the slot. Read-only recovery discovery never needs it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { governanceNamespaceDir } from './store.js';

export const WRITER_STALE_MS_DEFAULT = 5 * 60 * 1000; // 5 minutes, like TaskLock

export class GovernanceWriterError extends Error {
  constructor(message, { code = 'error' } = {}) {
    super(message);
    this.name = 'GovernanceWriterError';
    this.code = code;
  }
}

function realPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function makeWriterId() { return `writer-${process.pid}-${crypto.randomUUID()}`; }

export class GovernanceWriterGuard {
  constructor({ dataRoot, namespace = 'default', writerId = null, staleMs = WRITER_STALE_MS_DEFAULT, now = null, pidAlive = null } = {}) {
    if (!dataRoot) throw new GovernanceWriterError('GovernanceWriterGuard requires a dataRoot', { code: 'bad_request' });
    this.dataRoot = path.resolve(dataRoot);
    this.namespace = String(namespace);
    this.dir = governanceNamespaceDir(this.dataRoot, this.namespace);
    fs.mkdirSync(this.dir, { recursive: true });
    this.writerId = writerId || makeWriterId();
    this.staleMs = staleMs;
    this._now = now || (() => Date.now());
    this._pidAlive = pidAlive || realPidAlive;
    this._held = false;
  }

  get held() { return this._held; }

  _file() { return path.join(this.dir, 'writer.json'); }

  _read() {
    try { return JSON.parse(fs.readFileSync(this._file(), 'utf8')); } catch { return null; }
  }

  _payload() {
    const now = this._now();
    return {
      writerId: this.writerId,
      namespace: this.namespace,
      dataRoot: this.dataRoot,
      pid: typeof process !== 'undefined' ? process.pid : 0,
      at: now,
      heartbeatAt: now,
    };
  }

  _write() {
    const file = this._file();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._payload(), null, 2), 'utf8');
    fs.renameSync(tmp, file);
    this._held = true;
  }

  // A writer slot is stale when the recorded owner is no longer alive (crash/restart
  // reclaims immediately) OR the heartbeat is older than the stale window (protects
  // against pid reuse / unknown owners). A genuinely live owner refreshes its heartbeat
  // on every canonical persistence and is never stolen while its heartbeat is fresh.
  _isStale(existing, now) {
    const age = now - (existing.heartbeatAt || existing.at || 0);
    const ownerAlive = existing.pid ? this._pidAlive(existing.pid) : false;
    if (!ownerAlive) return true;
    return age > this.staleMs;
  }

  // Acquire the single canonical writer slot for this namespace/dataRoot.
  acquire() {
    if (this._held) return { ok: true, writerId: this.writerId, acquired: true };
    const file = this._file();
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify(this._payload(), null, 2), 'utf8');
      fs.closeSync(fd);
      this._held = true;
      return { ok: true, writerId: this.writerId, acquired: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const existing = this._read();
      if (existing && existing.writerId === this.writerId) {
        // Re-entrant acquire by the same writer object: refresh and continue.
        this._refresh();
        return { ok: true, writerId: this.writerId, acquired: true };
      }
      if (existing && this._isStale(existing, this._now())) {
        // Owner is dead or stale: reclaim the slot (never delete a live owner's file).
        try { fs.rmSync(file, { force: true }); } catch {}
        const fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, JSON.stringify(this._payload(), null, 2), 'utf8');
        fs.closeSync(fd);
        this._held = true;
        return { ok: true, writerId: this.writerId, acquired: true, reclaimed: true };
      }
      throw new GovernanceWriterError(
        `governance namespace ${this.namespace} at ${this.dataRoot} is already owned by active writer ${existing ? existing.writerId : 'unknown'}; a second canonical Governance writer is not allowed`,
        { code: 'writer_conflict' },
      );
    }
  }

  _refresh() {
    const file = this._file();
    const existing = this._read();
    if (!existing) { this._write(); return; }
    if (existing.writerId !== this.writerId) {
      throw new GovernanceWriterError('cannot refresh governance writer slot: slot is owned by another writer', { code: 'writer_conflict' });
    }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._payload(), null, 2), 'utf8');
    fs.renameSync(tmp, file);
    this._held = true;
  }

  // Called after each canonical persistence so an active writer keeps a fresh heartbeat.
  refresh() {
    if (!this._held) return false;
    this._refresh();
    return true;
  }

  release() {
    if (!this._held) return { released: false };
    const file = this._file();
    const existing = this._read();
    if (!existing) { this._held = false; return { released: true }; }
    if (existing.writerId === this.writerId) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
    this._held = false;
    return { released: true };
  }
}
