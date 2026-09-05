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
//     recorded owner PID is alive. A LIVE owner is NEVER reclaimed, even if its
//     heartbeat is older than the stale window (inactivity is not a license to create
//     a second live canonical writer).
//   - A DEAD owner (recorded PID no longer alive) is reclaimed immediately
//     (crash/restart continuity).
//   - An owner with no recorded PID (unknown) is reclaimed only when its heartbeat is
//     older than the stale window.
//   - Reclaim is single-winner and CAS-equivalent: a contender atomically moves the
//     stale slot it inspected to a private tombstone, verifies the moved record is the
//     exact stale owner it observed, and only then creates its own slot. If the slot
//     changed since inspection (e.g. another contender already won), the contender
//     restores it and fails closed - it never deletes/replaces a live winner's slot.
//   - assertOwned()/refresh() fail closed whenever this writer no longer owns the slot,
//     so no durable Governance mutation can be persisted after ownership loss.
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
  constructor({ dataRoot, namespace = 'default', writerId = null, staleMs = WRITER_STALE_MS_DEFAULT, now = null, pidAlive = null, hooks = null } = {}) {
    if (!dataRoot) throw new GovernanceWriterError('GovernanceWriterGuard requires a dataRoot', { code: 'bad_request' });
    this.dataRoot = path.resolve(dataRoot);
    this.namespace = String(namespace);
    this.dir = governanceNamespaceDir(this.dataRoot, this.namespace);
    fs.mkdirSync(this.dir, { recursive: true });
    this.writerId = writerId || makeWriterId();
    this.staleMs = staleMs;
    this._now = now || (() => Date.now());
    this._pidAlive = pidAlive || realPidAlive;
    // Deterministic-race test seam only (never set in production callers).
    this._hooks = hooks || {};
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

  // A writer slot is stale ONLY when:
  //   - the recorded owner PID is no longer alive (crash/restart reclaim), or
  //   - no PID was recorded (unknown owner) and the heartbeat is older than the
  //     stale window.
  // A LIVE owner is never stale: heartbeat age alone must never create two live
  // canonical writers.
  _isStale(existing, now) {
    if (existing.pid) {
      return !this._pidAlive(existing.pid);
    }
    const age = now - (existing.heartbeatAt || existing.at || 0);
    return age > this.staleMs;
  }

  // Acquire the single canonical writer slot for this namespace/dataRoot.
  acquire() {
    if (this._held) return { ok: true, writerId: this.writerId, acquired: true };
    const file = this._file();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, JSON.stringify(this._payload(), null, 2), 'utf8');
        fs.closeSync(fd);
        this._held = true;
        return { ok: true, writerId: this.writerId, acquired: true };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const existing = this._read();
      if (!existing) continue; // slot vanished; retry the exclusive create
      if (existing.writerId === this.writerId) {
        // Re-entrant acquire by the same writer object: refresh and continue.
        this._refresh();
        return { ok: true, writerId: this.writerId, acquired: true };
      }
      if (!this._isStale(existing, this._now())) {
        throw new GovernanceWriterError(
          `governance namespace ${this.namespace} at ${this.dataRoot} is already owned by active writer ${existing.writerId}; a second canonical Governance writer is not allowed`,
          { code: 'writer_conflict' },
        );
      }
      const claim = this._claimStaleSlot(existing);
      if (claim.ok) {
        this._held = true;
        return { ok: true, writerId: this.writerId, acquired: true, reclaimed: true };
      }
      if (claim.restored) continue; // slot changed since inspection; retry from scratch
      // Lost the claim race (slot moved/claimed by another contender): retry; a later
      // attempt will observe the winner as a live owner and fail closed.
    }
    throw new GovernanceWriterError(
      `governance namespace ${this.namespace} at ${this.dataRoot} could not be claimed after bounded retries; a second canonical Governance writer is not allowed`,
      { code: 'writer_conflict' },
    );
  }

  // CAS-equivalent single-winner reclaim. The contender atomically renames the stale
  // slot it inspected to a private tombstone, verifies the moved record is the exact
  // stale owner it observed, and only then creates its own slot. If the slot changed
  // since inspection, the contender restores it and fails closed so it can never
  // delete/replace a live winner's slot.
  _claimStaleSlot(existing) {
    const file = this._file();
    const tomb = `${file}.claim.${this.writerId}.${crypto.randomUUID()}`;
    if (typeof this._hooks.beforeStaleClaim === 'function') {
      this._hooks.beforeStaleClaim({ existing, file, guard: this });
    }
    try {
      fs.renameSync(file, tomb);
    } catch {
      // Slot vanished or was moved concurrently: another contender already claimed.
      return { ok: false, reason: 'lost_rename' };
    }
    let moved = null;
    try { moved = JSON.parse(fs.readFileSync(tomb, 'utf8')); } catch {}
    if (!moved || moved.writerId !== existing.writerId) {
      // We atomically moved a slot that is NOT the stale owner we inspected (a live
      // winner created it after our inspection). Restore it; never delete a changed slot.
      try {
        fs.renameSync(tomb, file);
        return { ok: false, reason: 'changed', restored: true };
      } catch {
        // Path is occupied again; preserve the moved winner record rather than delete it.
        return { ok: false, reason: 'changed_unrestorable' };
      }
    }
    // We hold the only stale inode. Create our fresh slot; the exclusive create makes
    // the outcome single-winner even if another contender raced into the gap.
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify(this._payload(), null, 2), 'utf8');
      fs.closeSync(fd);
      try { fs.rmSync(tomb, { force: true }); } catch {}
      return { ok: true, reclaimed: true };
    } catch (e) {
      // Another contender created its slot first in the gap: we lose. Remove only our
      // tombstone (the stale record we claimed) and fail closed.
      try { fs.rmSync(tomb, { force: true }); } catch {}
      return { ok: false, reason: 'lost_create' };
    }
  }

  // Fail-closed ownership assertion: this writer must still own the on-disk slot.
  // Called before every durable Governance mutation so a stale/ousted writer can
  // never persist state after losing ownership.
  assertOwned() {
    if (!this._held) {
      throw new GovernanceWriterError('this runtime is not the canonical Governance writer for the namespace', { code: 'writer_conflict' });
    }
    const existing = this._read();
    if (!existing) {
      throw new GovernanceWriterError('governance writer slot is missing; this writer no longer owns the namespace', { code: 'writer_conflict' });
    }
    if (existing.writerId !== this.writerId) {
      throw new GovernanceWriterError('governance writer slot is owned by another writer; this writer is no longer canonical', { code: 'writer_conflict' });
    }
    return { ok: true, writerId: this.writerId };
  }

  _refresh() {
    // Fail closed: never silently re-create or continue under a lost/foreign slot.
    this.assertOwned();
    const file = this._file();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._payload(), null, 2), 'utf8');
    fs.renameSync(tmp, file);
    this._held = true;
  }

  // Called after each canonical persistence so an active writer keeps a fresh
  // heartbeat. Throws writer_conflict (never swallowed) if ownership was lost.
  refresh() {
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
