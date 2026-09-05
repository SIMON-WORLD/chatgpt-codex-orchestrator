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
//   - Reclaim is single-winner and never touches a changed slot: stale reclaimers are
//     serialized through a lightweight election token; the elected reclaimer
//     revalidates the EXACT stale record it inspected and only then removes it and
//     creates its own slot. A contender that observed stale S but arrives after S was
//     already replaced by a live winner fails closed without ever moving, deleting, or
//     rewriting the winner's slot (no distributed locking).
//   - A pre-existing election token is NEVER automatically deleted or reclaimed, even
//     when its PID appears dead: a crashed reclaimer leaving a token is a fail-closed
//     recovery condition for Issue #23. Contenders that cannot become elected back off
//     with writer_conflict/elect_busy and leave both the election token and the
//     canonical writer slot untouched.
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

  // Single-winner, CAS-equivalent reclaim that NEVER moves/deletes/replaces a slot
  // that changed since the contender inspected it.
  //
  // Protocol:
  //   1. The contender becomes the elected reclaimer by creating an exclusive election
  //      token (`writer.json.elect`). Only one contender can hold the token, which
  //      serializes every destructive reclaim step.
  //   2. The elected reclaimer revalidates that the canonical slot is STILL the exact
  //      stale record it inspected (writerId/pid/at/heartbeatAt all identical).
  //   3. Only then does it remove the stale record and create its own slot with the
  //      exclusive create. Because it holds the election token, no other contender can
  //      change the slot between revalidation and removal.
  //   4. The election token is removed only by the contender that created it (finally).
  //      A pre-existing token from another (even crashed) reclaimer is never removed:
  //      that is a fail-closed recovery condition.
  // A loser never performs a destructive step on the canonical slot path: it either
  // fails to be elected, or its revalidation fails (slot changed) and it backs off.
  _claimStaleSlot(existing) {
    const file = this._file();
    const electPath = `${file}.elect`;
    if (typeof this._hooks.beforeReclaim === 'function') {
      this._hooks.beforeReclaim({ existing, file, electPath, guard: this });
    }
    // Become the elected reclaimer (single-winner serialization).
    let elected = false;
    for (let i = 0; i < 3; i++) {
      try {
        const fd = fs.openSync(electPath, 'wx');
        fs.writeSync(fd, JSON.stringify(this._electPayload(), null, 2), 'utf8');
        fs.closeSync(fd);
        elected = true;
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const cur = this._readElect();
        if (cur && cur.reclaimerId === this.writerId) { elected = true; break; }
        // A pre-existing election token is never deleted/replaced - even when its PID
        // looks dead. A crashed reclaimer leaving a token is a fail-closed recovery
        // condition; we back off and leave the canonical slot untouched.
        return { ok: false, reason: 'elect_busy' };
      }
    }
    if (!elected) return { ok: false, reason: 'elect_failed' };
    try {
      // Revalidate the EXACT observed stale record before any destructive step.
      const current = this._read();
      if (!this._sameSlotRecord(existing, current)) {
        // The slot changed since inspection (e.g. a live winner now owns it). We have
        // not moved/deleted anything; back off so the winner remains canonical.
        return { ok: false, reason: 'changed', restored: true };
      }
      try { fs.rmSync(file, { force: true }); } catch {}
      try {
        const fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, JSON.stringify(this._payload(), null, 2), 'utf8');
        fs.closeSync(fd);
        return { ok: true, reclaimed: true };
      } catch (e) {
        if (e.code === 'EEXIST') return { ok: false, reason: 'lost_create' };
        throw e;
      }
    } finally {
      try { fs.rmSync(electPath, { force: true }); } catch {}
    }
  }

  _electPayload() {
    const now = this._now();
    return {
      reclaimerId: this.writerId,
      namespace: this.namespace,
      dataRoot: this.dataRoot,
      pid: typeof process !== 'undefined' ? process.pid : 0,
      at: now,
      heartbeatAt: now,
    };
  }

  _readElect() {
    try { return JSON.parse(fs.readFileSync(this._file() + '.elect', 'utf8')); } catch { return null; }
  }

  // Identity check used for revalidation: the current slot must be byte-for-byte the
  // stale record this contender inspected.
  _sameSlotRecord(a, b) {
    if (!a || !b) return false;
    return a.writerId === b.writerId && a.pid === b.pid && a.at === b.at && a.heartbeatAt === b.heartbeatAt;
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
