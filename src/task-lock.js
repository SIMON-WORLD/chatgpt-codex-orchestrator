// chatgpt-codex-orchestrator: crash-safe task ownership / lock (Batch Closure Gate 2).
// O_EXCL lock with an owner token + pid + heartbeat timestamp. On EEXIST, check if the
// owner is alive (pid) or if the heartbeat is stale; reclaim only then. Never delete a
// lock merely because it exists.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class TaskLockedError extends Error {
  constructor(msg) { super(msg); this.name = 'TaskLockedError'; }
}

function pidOf() { return (typeof process !== 'undefined' && process.pid) ? process.pid : 0; }
function isPidAlive(pid) {
  if (!pid) return false; // unknown owner -> rely on stale heartbeat
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

export class TaskLock {
  constructor({ lockDir, staleMs = 5 * 60 * 1000 }) {
    this.lockDir = lockDir || runtimePaths().locks;
    fs.mkdirSync(this.lockDir, { recursive: true });
    this.ownerToken = crypto.randomUUID();
    this.staleMs = staleMs;
  }
  _file(taskId) { return path.join(this.lockDir, taskId + '.lock'); }

  _read(taskId) {
    try { return JSON.parse(fs.readFileSync(this._file(taskId), 'utf8')); } catch { return null; }
  }

  _isStale(lock, now) {
    const age = now - new Date(lock.at || 0).getTime();
    const ownerAlive = isPidAlive(lock.pid);
    return !ownerAlive && age > this.staleMs;
  }

  acquire(taskId) {
    const file = this._file(taskId);
    const now = Date.now();
    const payload = JSON.stringify({ owner: this.ownerToken, pid: pidOf(), at: new Date(now).toISOString(), taskId, ownerId: this.ownerToken });
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, payload, 'utf8');
      fs.closeSync(fd);
    } catch (e) {
      if (e.code === 'EEXIST') {
        const existing = this._read(taskId);
        if (existing && this._isStale(existing, now)) {
          // reclaim stale lock (owner died / heartbeat too old)
          try { fs.rmSync(file, { force: true }); } catch (e2) {}
          const fd = fs.openSync(file, 'wx');
          fs.writeSync(fd, payload, 'utf8');
          fs.closeSync(fd);
          return () => this.release(taskId);
        }
        throw new TaskLockedError(`task ${taskId} is locked by an active owner (${existing ? existing.ownerId : 'unknown'})`);
      }
      throw e;
    }
    return () => this.release(taskId);
  }

  isHeld(taskId) { return fs.existsSync(this._file(taskId)); }

  release(taskId) { try { fs.rmSync(this._file(taskId), { force: true }); } catch (e) {} }
}