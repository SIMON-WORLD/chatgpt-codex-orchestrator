// chatgpt-codex-orchestrator: AppServerExecutor (v0.2 M1, M7 hardening R6).
// Productionized wrapper over AppServerClient + JobMap + MutationOwner + approval.
// Exposes a thin, stable MCP-facing facade: start / get / continue / interrupt /
// respondApproval / reconcile / resume / shutdown. It does NOT expose raw App Server
// protocol.
//
// Ownership rules (M7):
//   - A Codex mutation unit acquires `codex` writer ownership bound to a persisted
//     mutationUnitId BEFORE any mutating turn/start. Only ONE writer may be active.
//   - A `read_only` Codex unit NEVER acquires MutationOwner writer ownership.
//   - MutationOwner protects ONLY the currently-executing writer, NOT a Brain
//     acceptance/review lock. Execution ownership is released only when an
//     authoritative App Server turn status (completed / failed / interrupted) is
//     confirmed via thread/read for the CURRENT mutation unit. Missing / process-exit /
//     ambiguous state stays fail-closed.
//
// R6 (pending-continue / process-death recovery):
//   - turn->unit identity is DURABLE (job.turnUnits, persisted in JobMap). A stale
//     notification for an old turn is recognized as belonging to a previous unit.
//   - get(): if job.turnId maps to a previous unit (turnUnits[job.turnId] !==
//     job.mutationUnitId), it does NOT treat that old-turn terminal as the current
//     unit's terminal, does NOT release the current writer, and returns
//     recoveryRequired=true + nextAction=codex_reconcile.
//   - reconcile()/resume() share an authoritative identity-safe resolver
//     (_authoritativeReconcileCore): thread/resume + thread/read -> resolve the turn
//     belonging to the CURRENT mutation unit (durable-binding an unseen single
//     candidate when uniquely identified) -> reconcile that unit's real status.
//     Never infers current-B terminal from old-A terminal. No generic force-unlock.

import path from 'node:path';
import { AppServerClient } from './app-server-client.js';
import { JobMap, makeJobId, makeMutationUnitId } from './job-map.js';
import { MutationOwner, MutationOwnerError } from '../state/mutation-owner.js';
import { normalizeApproval, mapDecision, APPROVAL_DECISIONS, ApprovalError, SUPPORTED_BINARY_METHODS } from './approval.js';

export const ACCESS_MODES = Object.freeze(['read_only', 'workspace_write']);
export const SANDBOX_MODE_BY_ACCESS = Object.freeze({
  read_only: 'read-only',
  workspace_write: 'workspace-write',
});
export const APPROVAL_POLICY_BY_ACCESS = Object.freeze({
  read_only: 'never',
  workspace_write: 'on-request',
});

const WORKSPACE_WRITE = 'workspace-write';
const READ_ONLY = 'read-only';

// Build the SandboxPolicy object sent on turn/start (and used to derive the effective
// permission contract). workspace_write scopes `writableRoots` to the target workspace so
// real Codex create/edit/delete stays inside the bound workspace. `networkAccess` is a
// minimal job-level flag (default false) so we never give every job unrestricted network.
export function buildSandboxPolicy(accessMode, { workspaceRoot = null, networkAccess = false } = {}) {
  if (accessMode === 'read_only') return { type: 'readOnly', networkAccess: networkAccess === true };
  const policy = { type: 'workspaceWrite', networkAccess: networkAccess === true };
  if (workspaceRoot) policy.writableRoots = [workspaceRoot];
  return policy;
}

export function approvalPolicyForAccess(accessMode) {
  return APPROVAL_POLICY_BY_ACCESS[accessMode] || 'never';
}

// Normalize the App Server's reported effective sandbox (SandboxPolicy object, or the
// fixture's string mode) into a canonical mode string.
export function effectiveSandboxMode(resSandbox) {
  if (resSandbox == null) return null;
  if (typeof resSandbox === 'string') {
    const s = resSandbox.toLowerCase();
    if (s === 'workspace-write' || s === 'workspacewrite' || s === 'workspace_write') return WORKSPACE_WRITE;
    if (s === 'read-only' || s === 'readonly' || s === 'read_only') return READ_ONLY;
    if (s === 'danger-full-access' || s === 'dangerfullaccess' || s === 'danger_full_access') return 'danger-full-access';
    return resSandbox;
  }
  if (typeof resSandbox === 'object') {
    const t = resSandbox && resSandbox.type;
    if (t === 'workspaceWrite') return WORKSPACE_WRITE;
    if (t === 'readOnly') return READ_ONLY;
    if (t === 'dangerFullAccess') return 'danger-full-access';
    if (t === 'externalSandbox') return 'external';
    return t || null;
  }
  return null;
}

// --- Path helpers for writable-root bounding -------------------------------------
const IS_WIN = process.platform === 'win32';
function normPath(p) { return String(p == null ? '' : p).replace(/[\\/]+$/, ''); }
function eqPath(a, b) { if (!a || !b) return false; const x = normPath(a); const y = normPath(b); return IS_WIN ? x.toLowerCase() === y.toLowerCase() : x === y; }
export function rootsEqual(a, b) { return eqPath(a, b); }
// child is within parent (same path or a descendant). Platform-safe: case-insensitive on win32.
export function isWithin(child, parent) {
  if (!child || !parent) return false;
  const c = normPath(child); const p = normPath(parent);
  const cEq = IS_WIN ? c.toLowerCase() : c;
  const pEq = IS_WIN ? p.toLowerCase() : p;
  if (cEq === pEq) return true;
  return cEq.startsWith(pEq + '\\') || cEq.startsWith(pEq + '/');
}

// Verify the App Server's AUTHORITATIVE effective permission (from the
// `thread/settings/updated` notification's ThreadSettings) against the requested job
// contract. We NEVER infer `effective = requested`; evidence must come from the real
// effective ThreadSettings. Throws on mismatch.
export function verifyEffectiveThreadSettings({ accessMode, sandboxPolicy, approvalPolicy, cwd = null, workspaceRoot = null, networkAccess = null, activePermissionProfile = null }) {
  const effType = sandboxPolicy && sandboxPolicy.type;
  const effNetwork = !!(sandboxPolicy && sandboxPolicy.networkAccess === true);
  const reqNetwork = networkAccess === true;

  if (accessMode === 'read_only') {
    if (effType !== 'readOnly') throw new Error(`effective permission mismatch: requested read_only but effective sandboxPolicy=${effType || 'unknown'}`);
    if (approvalPolicy !== 'never') throw new Error(`effective permission mismatch: read_only requires approvalPolicy=never but effective=${JSON.stringify(approvalPolicy)}`);
    if (reqNetwork !== effNetwork) throw new Error(`effective permission mismatch: networkAccess requested=${reqNetwork} but effective=${sandboxPolicy && sandboxPolicy.networkAccess}`);
    return { effectiveSandbox: READ_ONLY, effectiveApprovalPolicy: approvalPolicy, effectiveVerified: true, effectiveWritableRoots: [], effectiveNetworkAccess: effNetwork, effectiveWritableRootMatch: true };
  }

  // workspace_write: EXACT approval policy (on-request), not merely != never.
  if (effType !== 'workspaceWrite') throw new Error(`effective permission mismatch: requested workspace_write but effective sandboxPolicy=${effType || 'unknown'}`);
  if (approvalPolicy !== 'on-request') throw new Error(`effective permission mismatch: workspace_write requires approvalPolicy=on-request but effective=${JSON.stringify(approvalPolicy)}`);
  if (reqNetwork !== effNetwork) throw new Error(`effective permission mismatch: networkAccess requested=${reqNetwork} but effective=${sandboxPolicy && sandboxPolicy.networkAccess}`);

  const writableRoots = Array.isArray(sandboxPolicy.writableRoots) ? sandboxPolicy.writableRoots : [];
  let writableRootMatch = null;
  if (workspaceRoot != null) {
    if (writableRoots.length) {
      // EXACT + BOUNDED: at least one effective root must be exactly the workspace root, and
      // EVERY effective root must be the workspace root or a descendant of it. A parent,
      // drive/file-system root, or sibling root that would escape the workspace boundary is
      // rejected (workspaceRoot being a descendant of an effective root NEVER passes).
      const hasExact = writableRoots.some((r) => rootsEqual(r, workspaceRoot));
      const allInside = writableRoots.every((r) => rootsEqual(r, workspaceRoot) || isWithin(r, workspaceRoot));
      writableRootMatch = hasExact && allInside;
    } else {
      // Real App Server normalizes writableRoots to [] and scopes writes to cwd.
      writableRootMatch = cwd != null && rootsEqual(cwd, workspaceRoot);
    }
    if (!writableRootMatch) throw new Error('effective permission mismatch: writable roots do not bound the target workspace');
  }
  return { effectiveSandbox: WORKSPACE_WRITE, effectiveApprovalPolicy: approvalPolicy, effectiveVerified: true, effectiveWritableRoots: writableRoots, effectiveNetworkAccess: effNetwork, effectiveWritableRootMatch: !!writableRootMatch };
}

function permissionContract(job) {
  return {
    accessMode: job.accessMode || null,
    requestedSandbox: job.sandbox || null,
    effectiveSandbox: job.effectiveSandbox || null,
    effectiveApprovalPolicy: job.effectiveApprovalPolicy || null,
    networkAccess: job.networkAccess === true,
    effectiveVerified: job.effectiveVerified === true,
    effectiveWritableRoots: Array.isArray(job.effectiveWritableRoots) ? job.effectiveWritableRoots : null,
    effectiveNetworkAccess: job.effectiveNetworkAccess === true,
    effectiveWritableRootMatch: job.effectiveWritableRootMatch === true,
    verifiedForRequestedContract: job.verifiedForRequestedContract || null,
  };
}


export const TERMINAL_TURN_STATES = ['completed', 'failed', 'interrupted'];
const RECOVERY_STATES = ['created', 'thread_ready', 'starting', 'running'];

const MAX_RESULT_CHARS = 8000;

function extractAssistantText(turn) {
  const items = turn && Array.isArray(turn.items) ? turn.items : [];
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'agent_message') {
      if (Array.isArray(item.content)) {
        for (const c of item.content) if (c && c.type === 'input_text' && typeof c.text === 'string') out.push(c.text);
      }
    } else if (item.type === 'agentMessage') {
      if (typeof item.text === 'string' && item.text) out.push(item.text);
    } else if (item.type === 'message') {
      if (item.role === 'assistant' && Array.isArray(item.content)) {
        for (const c of item.content) if (c && c.type === 'output_text' && typeof c.text === 'string') out.push(c.text);
      }
    }
  }
  return out.join(' ').trim().slice(0, MAX_RESULT_CHARS) || null;
}

function pendingForJob(job, approvals) {
  const pending = [];
  for (const [, entry] of approvals) {
    if (entry.resolved) continue;
    const info = entry.info;
    if (info.threadId && job.threadId && info.threadId !== job.threadId) continue;
    const binary = SUPPORTED_BINARY_METHODS.includes(info.method);
    pending.push({
      approvalId: info.approvalId,
      kind: info.kind,
      method: info.method,
      reason: info.reason || null,
      itemId: info.itemId || null,
      supportedDecisionMode: binary ? ['approve', 'deny'] : null,
      requiresStructuredResponse: !binary,
    });
  }
  return pending;
}

// Structured fail-closed error for the bounded recovery lookup (v0.2 M7-C).
// Carries a machine-readable code so Brain can distinguish not_found /
// ambiguous / wrong_workspace / stale without heuristic selection.
export class RecoveryError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail);
    this.name = 'RecoveryError';
    this.code = code;
    this.detail = detail;
    this.matchCount = extra.matchCount ?? null;
    this.jobId = extra.jobId ?? null;
  }
  toJSON() {
    return {
      ok: false,
      error: this.code,
      reason: this.detail,
      ...(this.matchCount != null ? { matchCount: this.matchCount } : {}),
      ...(this.jobId != null ? { jobId: this.jobId } : {}),
    };
  }
}

export class AppServerExecutor {
  constructor({ dataRoot = null, codexBin = null, listen = null, cwd = null, client = null, jobMap = null, mutationOwner = null } = {}) {
    this.client = client || new AppServerClient({ codexBin: codexBin || undefined, listen: listen || undefined, cwd: cwd || undefined });
    this.jobMap = jobMap || new JobMap({ dataRoot });
    this.owner = mutationOwner || new MutationOwner();
    this._approvals = new Map();
    this._notifiers = new Set();
    this._turnUnits = new Map(); // in-memory cache (durable source of truth is job.turnUnits)
    this._settingsWaiters = new Map(); // threadId -> { resolve, reject, timer } for thread/settings/updated
    this._setup();
  }

  _setup() {
    this.client.onNotification((note) => this._handleNotification(note));
    this.client.onServerRequest((req) => this._handleServerRequest(req));
    this.client.onExit((evt) => this._handleClientExit(evt));
  }

  onEvent(handler) { this._notifiers.add(handler); return () => this._notifiers.delete(handler); }
  _emit(event) { for (const h of this._notifiers) { try { h(event); } catch {} } }

  _isWriter(job) { return !job || job.accessMode !== 'read_only'; }

  _handleClientExit(evt) {
    if (this.client._closing) return;
    for (const job of this.jobMap.list()) {
      if (RECOVERY_STATES.includes(job.state)) {
        this.jobMap.update(job.jobId, { state: 'recovery_required', updatedAt: Date.now() });
      }
    }
    if (this.owner.owner !== 'none') this.owner.markUnitState('unknown');
    this._emit({ type: 'process-exit', ...evt });
  }

  _handleNotification(note) {
    const method = note && note.method;
    if (method === 'thread/settings/updated') {
      const params = note.params || {};
      const threadId = params.threadId;
      const w = this._settingsWaiters.get(threadId);
      if (w) {
        clearTimeout(w.timer);
        this._settingsWaiters.delete(threadId);
        w.settled = true;
        w.resolve({ ok: true, settings: params.threadSettings || null });
      }
      this._emit(note);
      return;
    }
    if (method === 'turn/started' || method === 'turn/completed') {
      const params = note.params || {};
      const threadId = params.threadId;
      const turn = params.turn || {};
      const job = this.jobMap.findByThread(threadId);
      if (!job) { this._emit(note); return; }
      const notifiedTurnId = turn.id || null;
      // Durable / reconstructable turn->unit identity: prefer persisted job.turnUnits,
      // then in-memory cache, then (for a freshly-started turn) the job's current unit.
      let notifiedUnitId = (job.turnUnits && job.turnUnits[notifiedTurnId]) || this._turnUnits.get(notifiedTurnId) || null;
      const isNewInProgressTurn = notifiedUnitId == null && turn.status === 'inProgress' && job.mutationUnitId;
      if (isNewInProgressTurn) {
        notifiedUnitId = job.mutationUnitId;
        const u = { ...(job.turnUnits || {}), [notifiedTurnId]: notifiedUnitId };
        this.jobMap.update(job.jobId, { turnUnits: u, updatedAt: Date.now() });
        if (notifiedTurnId) this._turnUnits.set(notifiedTurnId, notifiedUnitId);
      }
      const jobUnit = job.mutationUnitId || null;
      if (notifiedUnitId && jobUnit && notifiedUnitId !== jobUnit) { this._emit(note); return; }
      if (notifiedUnitId == null) { this._emit(note); return; }
      const state = turn.status || (method === 'turn/completed' ? 'completed' : 'running');
      this.jobMap.update(job.jobId, { state, turnId: notifiedTurnId || job.turnId, updatedAt: Date.now() });
      if (TERMINAL_TURN_STATES.includes(turn.status)) {
        this._releaseUnitOnTerminal(job, turn.status);
      } else if (turn.status === 'inProgress' && this._isWriter(job)) {
        if (this.owner.owner === 'none') {
          this.owner.acquire('codex', job.mutationUnitId || makeMutationUnitId());
        } else if (this.owner.owner === 'codex') {
          this.owner.markUnitState('running');
        }
      }
    }
    this._emit(note);
  }

  _handleServerRequest(req) {
    const approval = normalizeApproval(req);
    if (approval) {
      this._approvals.set(approval.approvalId, { requestId: req.id, info: approval, resolved: false });
    }
  }

  _releaseUnitOnTerminal(job, status, { jobMapUpdate = true } = {}) {
    if (!job) return { ownershipReleased: false, status, unitState: null };
    const isWriter = this._isWriter(job);
    let ownershipReleased = false;
    if (!isWriter) {
      ownershipReleased = true;
    } else if (this.owner.owner === 'codex' && this.owner.unitId === (job.mutationUnitId || null)) {
      this.owner.markUnitState('reconciled');
      const rel = this.owner.release();
      ownershipReleased = rel.released;
    } else if (this.owner.owner === 'none') {
      ownershipReleased = true;
    }
    if (jobMapUpdate) this.jobMap.update(job.jobId, { state: status, ownershipReleased, updatedAt: Date.now() });
    return { ownershipReleased, status, unitState: ownershipReleased ? 'released' : this.owner.unitState };
  }

  async _authoritativeTurn(job) {
    if (!job || !job.threadId || !job.turnId) return null;
    let read;
    try {
      read = await this.client.request('thread/read', { threadId: job.threadId, includeTurns: true });
    } catch {
      return null;
    }
    const thread = read && read.thread;
    const turn = thread && Array.isArray(thread.turns) ? thread.turns.find((t) => t && t.id === job.turnId) : null;
    return turn && turn.status ? turn : null;
  }

  async _ensureConnected() {
    if (!this.client.isRunning) await this.client.connect();
    else if (!this.client._connected) await this.client.connect();
  }

  // Resolve which turn belongs to the CURRENT mutation unit (durable identity).
  // Returns { ok, turn?, reason? }.
  _resolveCurrentUnitTurn(job, turns) {
    const unitId = job.mutationUnitId || null;
    if (!unitId) return { ok: false, reason: 'no current mutation unit' };
    const turnUnits = job.turnUnits || {};
    const bound = turns.find((t) => t && turnUnits[t.id] === unitId);
    if (bound) return { ok: true, turn: bound, resolution: 'bound', unitId };
    const unbound = turns.filter((t) => t && !turnUnits[t.id]);
    if (unbound.length === 1) return { ok: true, turn: unbound[0], resolution: 'unbound_single', unitId };
    return { ok: false, reason: unbound.length === 0 ? 'no candidate turn for current mutation unit' : 'multiple candidate turns for current mutation unit', unitId };
  }

  // Shared authoritative identity-safe reconciliation (used by reconcile() and resume()).
  // thread/resume + thread/read -> resolve the CURRENT mutation unit's turn (durably
  // binding a single unseen candidate) -> reconcile its real status.
  async _authoritativeReconcileCore(job) {
    const jobId = job.jobId;
    const unitId = job.mutationUnitId || null;
    if (!job.threadId) return { ok: false, resolution: 'unresolved', recoveryRequired: true, reason: 'no thread identity to reconcile' };
    const isWriter = this._isWriter(job);

    let resumed;
    try {
      resumed = await this.client.request('thread/resume', { threadId: job.threadId, ...(job.cwd ? { cwd: job.cwd } : {}) });
    } catch (e) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      return { ok: false, resolution: 'unresolved', recoveryRequired: true, reason: 'resume failed: ' + String(e.message || e).slice(0, 160) };
    }
    if (!(resumed && resumed.thread && resumed.thread.id)) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      return { ok: false, resolution: 'unresolved', recoveryRequired: true, reason: 'thread/resume returned no thread id' };
    }
    let read;
    try {
      read = await this.client.request('thread/read', { threadId: job.threadId, includeTurns: true });
    } catch (e) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      return { ok: false, resolution: 'unresolved', recoveryRequired: true, reason: 'thread/read failed: ' + String(e.message || e).slice(0, 160) };
    }
    const thread = read && read.thread;
    const turns = (thread && Array.isArray(thread.turns)) ? thread.turns : [];

    const resolved = this._resolveCurrentUnitTurn(job, turns);
    if (!resolved.ok) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      return { ok: false, resolution: 'unresolved', recoveryRequired: true, reason: resolved.reason };
    }
    const turn = resolved.turn;
    // Durable-bind a single unseen candidate to the current mutation unit.
    if (resolved.resolution === 'unbound_single') {
      const tu = { ...(job.turnUnits || {}), [turn.id]: unitId };
      this.jobMap.update(jobId, { turnId: turn.id, turnUnits: tu, updatedAt: Date.now() });
      this._turnUnits.set(turn.id, unitId);
    }

    if (TERMINAL_TURN_STATES.includes(turn.status)) {
      if (!isWriter) {
        const rel = this._releaseUnitOnTerminal(job, turn.status);
        return { ok: true, resolution: 'terminal', state: turn.status, ownershipReleased: rel.ownershipReleased, recoveredUnitId: unitId, mutationUnitId: unitId };
      }
      if (this.owner.owner === 'codex' && this.owner.unitId !== unitId) {
        this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
        return { ok: false, resolution: 'unresolved', recoveryRequired: true, reason: `ownership conflict: active codex unit ${this.owner.unitId} differs from job unit ${unitId}` };
      }
      if (this.owner.owner === 'chatgpt') {
        this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
        return { ok: false, resolution: 'unresolved', recoveryRequired: true, reason: 'ownership conflict: workspace owned by chatgpt' };
      }
      const rel = this._releaseUnitOnTerminal(job, turn.status);
      return { ok: true, resolution: 'terminal', state: turn.status, ownershipReleased: rel.ownershipReleased, recoveredUnitId: unitId, mutationUnitId: unitId };
    }

    if (turn.status === 'inProgress') {
      if (!isWriter) {
        this.jobMap.update(jobId, { state: 'running', updatedAt: Date.now() });
        return { ok: true, resolution: 'in_progress', state: 'running', ownershipReleased: false, recoveredUnitId: unitId, mutationUnitId: unitId };
      }
      if (this.owner.owner === 'none') this.owner.acquire('codex', unitId || makeMutationUnitId());
      else if (this.owner.owner === 'codex' && (this.owner.unitId === unitId || unitId == null)) this.owner.markUnitState('running');
      else {
        this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
        return { ok: false, resolution: 'unresolved', recoveryRequired: true, reason: `ownership conflict: active owner ${this.owner.owner} (${this.owner.unitId || 'no-unit'}) differs from job unit ${unitId || 'unknown'}` };
      }
      this.jobMap.update(jobId, { state: 'running', updatedAt: Date.now() });
      return { ok: true, resolution: 'in_progress', state: 'running', ownershipReleased: false, recoveredUnitId: unitId, mutationUnitId: unitId };
    }

    this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
    return { ok: false, resolution: 'unresolved', recoveryRequired: true, reason: 'ambiguous or unreadable turn state' };
  }

  _waitForThreadSettings(threadId, timeoutMs = 10000) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const timer = setTimeout(() => {
      const w = this._settingsWaiters.get(threadId);
      if (w) {
        clearTimeout(w.timer);
        this._settingsWaiters.delete(threadId);
        if (!w.settled) { w.settled = true; w.resolve({ ok: false, reason: 'timed out waiting for effective thread settings' }); }
      }
    }, timeoutMs);
    const entry = { resolve, timer, promise, settled: false };
    this._settingsWaiters.set(threadId, entry);
    return entry;
  }

  // Cancel a pending settings waiter (clear timer + remove map entry + settle safely, no
  // orphan promise / no unhandled rejection after a thread/settings/update request failure).
  _cancelSettingsWait(threadId, reason = 'settings wait cancelled') {
    const w = this._settingsWaiters.get(threadId);
    if (!w) return;
    clearTimeout(w.timer);
    this._settingsWaiters.delete(threadId);
    if (!w.settled) { w.settled = true; w.resolve({ ok: false, reason }); }
  }

  // Authoritative permission bootstrap: apply the job contract via thread/settings/update,
  // then wait for the thread/settings/updated notification and read its effective
  // ThreadSettings. Used BEFORE executing any turn and BEFORE acquiring a writer.
  async _bootstrapVerifyPermission({ jobId, threadId, accessMode, sandboxPolicy, approvalPolicy, workspaceRoot, networkAccess }) {
    // Register the waiter BEFORE sending the update so a synchronous
    // thread/settings/updated notification is not missed.
    const waiter = this._waitForThreadSettings(threadId, 10000);
    try {
      await this.client.request('thread/settings/update', { threadId, sandboxPolicy, approvalPolicy, ...(workspaceRoot ? { cwd: workspaceRoot } : {}) });
    } catch (e) {
      this._cancelSettingsWait(threadId, 'thread/settings/update request failed');
      throw new Error('permission verification: thread/settings/update failed: ' + String(e.message || e).slice(0, 160));
    }
    const res = await waiter.promise;
    if (!res.ok) throw new Error('permission verification: ' + res.reason);
    const settings = res.settings;
    if (!settings) throw new Error('permission verification: no effective thread settings received');
    const verified = verifyEffectiveThreadSettings({
      accessMode,
      sandboxPolicy: settings.sandboxPolicy,
      approvalPolicy: settings.approvalPolicy,
      cwd: settings.cwd,
      workspaceRoot,
      networkAccess,
      activePermissionProfile: settings.activePermissionProfile,
    });
    return {
      effectiveSandbox: verified.effectiveSandbox,
      effectiveApprovalPolicy: verified.effectiveApprovalPolicy,
      effectiveVerified: true,
      effectiveWritableRoots: verified.effectiveWritableRoots,
      effectiveNetworkAccess: verified.effectiveNetworkAccess,
      effectiveWritableRootMatch: verified.effectiveWritableRootMatch,
      verifiedForRequestedContract: JSON.stringify({ accessMode, networkAccess: networkAccess === true, sandboxPolicy }),
      verifiedAt: Date.now(),
      activePermissionProfile: settings.activePermissionProfile ?? null,
    };
  }

  async start({ prompt, cwd = null, accessMode = null, workspaceRoot = null, workspaceId = null, networkAccess = false, taskId = null, stepId = null, identity = null } = {}) {
    await this._ensureConnected();
    if (!ACCESS_MODES.includes(accessMode)) {
      throw new Error(`codex start requires an explicit accessMode (one of: ${ACCESS_MODES.join(', ')}); refusing to default to read-only`);
    }
    const sandbox = SANDBOX_MODE_BY_ACCESS[accessMode];
    const isWriter = accessMode !== 'read_only';
    const approvalPolicy = approvalPolicyForAccess(accessMode);
    const sandboxPolicy = buildSandboxPolicy(accessMode, { workspaceRoot, networkAccess });

    const jobId = makeJobId();
    const mutationUnitId = makeMutationUnitId();
    this.jobMap.save(jobId, { jobId, mutationUnitId, accessMode, sandbox, sandboxPolicy, approvalPolicy, isWriter, workspaceRoot, workspaceId, networkAccess: networkAccess === true, requestPermission: { sandbox, approvalPolicy, sandboxPolicy }, effectiveVerified: false, taskId: taskId || null, stepId: stepId || null, identity: identity || null, threadId: null, turnId: null, state: 'created', ownershipReleased: false, turnUnits: {}, createdAt: Date.now(), updatedAt: Date.now() });

    // Safe bootstrap: start a thread (no turn) with read-only sandbox + 'on-request'
    // approval. These differ from BOTH job targets (read_only=never, workspace_write=workspace-write),
    // so the subsequent thread/settings/update to the target always changes the settings and the
    // App Server always emits a thread/settings/updated notification (read-only update alone would
    // be a no-op and produce no evidence, since read-only is the server default).
    const bootstrapSandbox = 'read-only';
    const bootstrapApproval = 'on-request';
    const threadParams = { ...(cwd ? { cwd } : {}), sandbox: bootstrapSandbox, approvalPolicy: bootstrapApproval };
    const threadRes = await this.client.request('thread/start', threadParams);
    const threadId = threadRes && threadRes.thread && threadRes.thread.id;
    if (!threadId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      throw new Error('thread/start returned no thread id');
    }

    this.jobMap.update(jobId, { threadId, legacyThreadSandbox: effectiveSandboxMode(threadRes.sandbox), state: 'thread_ready', updatedAt: Date.now() });

    // Verify the REAL effective permission (thread/settings/updated ThreadSettings)
    // BEFORE executing any turn and BEFORE acquiring a writer. Never infer effective
    // from requested. If requested workspace_write but effective is read-only (or no
    // effective settings evidence), fail closed.
    let verified;
    try {
      verified = await this._bootstrapVerifyPermission({ jobId, threadId, accessMode, sandboxPolicy, approvalPolicy, workspaceRoot, networkAccess });
    } catch (e) {
      this.jobMap.update(jobId, { state: 'recovery_required', effectiveVerified: false, verificationError: String(e.message || e).slice(0, 200), updatedAt: Date.now() });
      throw e;
    }
    this.jobMap.update(jobId, {
      effectiveSandbox: verified.effectiveSandbox,
      effectiveApprovalPolicy: verified.effectiveApprovalPolicy,
      effectiveVerified: true,
      effectiveWritableRoots: verified.effectiveWritableRoots,
      effectiveNetworkAccess: verified.effectiveNetworkAccess,
      effectiveWritableRootMatch: verified.effectiveWritableRootMatch,
      verifiedForRequestedContract: verified.verifiedForRequestedContract,
      verifiedAt: verified.verifiedAt,
      activePermissionProfile: verified.activePermissionProfile ?? null,
      updatedAt: Date.now(),
    });

    if (isWriter) {
      try {
        this.owner.acquire('codex', mutationUnitId);
      } catch (e) {
        this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
        throw e;
      }
    }
    this.jobMap.update(jobId, { state: 'starting', updatedAt: Date.now() });

    let turnRes;
    try {
      turnRes = await this.client.request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], ...(cwd ? { cwd } : {}), sandboxPolicy, approvalPolicy });
    } catch (e) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      if (this.owner.owner !== 'none') this.owner.markUnitState('unknown');
      throw e;
    }
    const turnId = turnRes && turnRes.turn && turnRes.turn.id;
    if (!turnId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      if (this.owner.owner !== 'none') this.owner.markUnitState('unknown');
      throw new Error('turn/start returned no turn id');
    }
    this._turnUnits.set(turnId, mutationUnitId);
    const startJob = this.jobMap.load(jobId);
    this.jobMap.update(jobId, { turnId, turnUnits: { ...(startJob.turnUnits || {}), [turnId]: mutationUnitId }, state: 'running', updatedAt: Date.now() });
    const eff = permissionContract(this.jobMap.load(jobId));
    return { jobId, threadId, turnId, state: 'running', accessMode, sandbox, approvalPolicy, isWriter, mutationOwner: this.owner.owner, effectiveSandbox: eff.effectiveSandbox, effectiveApprovalPolicy: eff.effectiveApprovalPolicy, effectiveVerified: eff.effectiveVerified, permissionContract: eff };
  }

  load(jobId) { return this.jobMap.load(jobId); }

  async get({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);

    let live = false;
    let recoveryRequired = false;
    let readErrorCode = null;
    let thread = null;
    try {
      const r = await this.client.request('thread/read', { threadId: job.threadId, includeTurns: true });
      thread = r && r.thread || null;
      live = true;
    } catch (e) {
      readErrorCode = (e && e.message ? e.message : 'read-error').slice(0, 200);
      recoveryRequired = true;
    }
    if (!this.client.isRunning) recoveryRequired = true;

    const turns = thread && Array.isArray(thread.turns) ? thread.turns : [];

    // R6 transition identity safety: determine the turn belonging to the CURRENT
    // mutation unit. If job.turnId maps to a PREVIOUS unit, or the current unit's turn
    // identity cannot be reliably resolved, do NOT treat the old turn's terminal as the
    // current unit's terminal and do NOT release the current writer.
    const jobUnit = job.mutationUnitId || null;
    const turnUnits = job.turnUnits || {};
    let transitionMismatch = false;
    let currentTurn = null;
    if (jobUnit) {
      const bound = turns.find((t) => t && turnUnits[t.id] === jobUnit);
      if (bound) currentTurn = bound;
      else if (job.turnId && turnUnits[job.turnId] && turnUnits[job.turnId] !== jobUnit) transitionMismatch = true;
      else transitionMismatch = true; // conservative: current unit's turn not reliably known
    }
    if (transitionMismatch) recoveryRequired = true;

    const turn = currentTurn;
    const assistantText = turn ? extractAssistantText(turn) : null;
    const pendingApprovals = pendingForJob(job, this._approvals);

    let ownershipReleased = job.ownershipReleased === true;
    let terminalStatus = null;
    // Self-heal ONLY for the authoritative current-unit turn; never for a stale/old turn.
    if (!transitionMismatch && turn && TERMINAL_TURN_STATES.includes(turn.status)) {
      const rel = this._releaseUnitOnTerminal(job, turn.status);
      ownershipReleased = rel.ownershipReleased;
      terminalStatus = turn.status;
      if (rel.ownershipReleased) recoveryRequired = false;
    }
    if (transitionMismatch) recoveryRequired = true;

    let mutationUnitState;
    if (ownershipReleased) mutationUnitState = 'released';
    else if (this.owner.owner === 'none') mutationUnitState = 'none';
    else mutationUnitState = this.owner.unitState;

    const nextAction = recoveryRequired ? 'codex_reconcile' : null;

    return {
      jobId,
      threadId: job.threadId,
      turnId: turn ? turn.id : job.turnId,
      accessMode: job.accessMode || null,
      sandbox: job.sandbox || null,
      effectiveSandbox: job.effectiveSandbox || null,
      effectiveApprovalPolicy: job.effectiveApprovalPolicy || null,
      effectiveVerified: job.effectiveVerified === true,
      effectiveWritableRoots: Array.isArray(job.effectiveWritableRoots) ? job.effectiveWritableRoots : null,
      effectiveNetworkAccess: job.effectiveNetworkAccess === true,
      effectiveWritableRootMatch: job.effectiveWritableRootMatch === true,
      verifiedForRequestedContract: job.verifiedForRequestedContract || null,
      permissionContract: permissionContract(job),
      isWriter: job.isWriter !== false,
      workspaceRoot: job.workspaceRoot || null,
      workspaceId: job.workspaceId || null,
      state: job.state,
      live,
      recoveryRequired,
      nextAction,
      readErrorCode,
      threadStatus: thread ? thread.status : null,
      result: assistantText,
      assistantText,
      pendingApprovals,
      mutationOwner: this.owner.owner,
      jobMutationUnitId: job.mutationUnitId || null,
      ownerMutationUnitId: this.owner.owner !== 'none' ? this.owner.unitId : null,
      mutationUnitState,
      ownershipReleased,
      turn: turn ? {
        id: turn.id,
        status: turn.status,
        error: turn.error || null,
        startedAt: turn.startedAt ?? null,
        completedAt: turn.completedAt ?? null,
        durationMs: turn.durationMs ?? null,
      } : null,
    };
  }

  async continue({ jobId, instruction, taskId = null, stepId = null, identity = null }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    if (!job.threadId) throw new Error(`job ${jobId} has no threadId`);
    if (!instruction || typeof instruction !== 'string' || !instruction.trim()) throw new Error('continue requires a non-empty instruction');

    const accessMode = job.accessMode || 'read_only';
    const isWriter = this._isWriter(job);
    const approvalPolicy = approvalPolicyForAccess(accessMode);
    const sandboxPolicy = buildSandboxPolicy(accessMode, { workspaceRoot: job.workspaceRoot || null, networkAccess: job.networkAccess === true });
    const mutationUnitId = makeMutationUnitId();
    const contractId = JSON.stringify({ accessMode, networkAccess: job.networkAccess === true, sandboxPolicy });
    // Reuse an authoritative verified snapshot ONLY if it matches the current contract.
    // Never unconditionally write effectiveVerified=true.
    if (job.effectiveVerified !== true || job.verifiedForRequestedContract !== contractId) {
      let verified;
      try {
        verified = await this._bootstrapVerifyPermission({ jobId, threadId: job.threadId, accessMode, sandboxPolicy, approvalPolicy, workspaceRoot: job.workspaceRoot || null, networkAccess: job.networkAccess === true });
      } catch (e) {
        this.jobMap.update(jobId, { state: 'recovery_required', effectiveVerified: false, verificationError: String(e.message || e).slice(0, 200), updatedAt: Date.now() });
        throw e;
      }
      this.jobMap.update(jobId, { effectiveSandbox: verified.effectiveSandbox, effectiveApprovalPolicy: verified.effectiveApprovalPolicy, effectiveVerified: true, effectiveWritableRoots: verified.effectiveWritableRoots, effectiveNetworkAccess: verified.effectiveNetworkAccess, effectiveWritableRootMatch: verified.effectiveWritableRootMatch, verifiedForRequestedContract: verified.verifiedForRequestedContract, verifiedAt: verified.verifiedAt, activePermissionProfile: verified.activePermissionProfile ?? null, updatedAt: Date.now() });
    }
    if (isWriter) this.owner.acquire('codex', mutationUnitId);
    const bindingPatch = { mutationUnitId, accessMode, sandbox: job.sandbox || null, sandboxPolicy, approvalPolicy, isWriter, ownershipReleased: false, state: 'starting', updatedAt: Date.now() };
    if (taskId != null) bindingPatch.taskId = taskId;
    if (stepId != null) bindingPatch.stepId = stepId;
    if (identity != null) bindingPatch.identity = identity;
    this.jobMap.update(jobId, bindingPatch);

    let turnRes;
    try {
      turnRes = await this.client.request('turn/start', { threadId: job.threadId, input: [{ type: 'text', text: instruction, text_elements: [] }], sandboxPolicy, approvalPolicy });
    } catch (e) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      if (this.owner.owner !== 'none') this.owner.markUnitState('unknown');
      throw e;
    }
    const turnId = turnRes && turnRes.turn && turnRes.turn.id;
    if (!turnId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      throw new Error('turn/start returned no turn id');
    }
    this._turnUnits.set(turnId, mutationUnitId);
    const contJob = this.jobMap.load(jobId);
    this.jobMap.update(jobId, { turnId, turnUnits: { ...(contJob.turnUnits || {}), [turnId]: mutationUnitId }, state: 'running', updatedAt: Date.now() });
    const contEff = permissionContract(this.jobMap.load(jobId));
    return { jobId, threadId: job.threadId, turnId, state: 'running', accessMode, sandbox: job.sandbox || null, approvalPolicy, isWriter, mutationOwner: this.owner.owner, effectiveSandbox: contEff.effectiveSandbox, effectiveApprovalPolicy: contEff.effectiveApprovalPolicy, effectiveVerified: contEff.effectiveVerified, permissionContract: contEff };
  }

  async reconcile({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    await this._ensureConnected();
    if (!job.threadId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      return { jobId, reconciled: false, resolution: 'unresolved', recoveryRequired: true, reason: 'no thread identity to reconcile' };
    }
    const core = await this._authoritativeReconcileCore(job);
    if (!core.ok) {
      return { jobId, reconciled: false, resolution: 'unresolved', recoveryRequired: true, reason: core.reason };
    }
    return {
      jobId, reconciled: true, resolution: core.resolution, state: core.state,
      ownershipReleased: core.ownershipReleased === true, recoveryRequired: false, mutationUnitId: core.mutationUnitId || null,
    };
  }

  async resume({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    await this._ensureConnected();
    if (!job.threadId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      throw new Error(`cannot reconcile job ${jobId}: no thread identity; refusing to create a duplicate`);
    }
    const core = await this._authoritativeReconcileCore(job);
    if (!core.ok) {
      // identity-safe: never release a foreign/newer unit; fail-closed.
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      throw new Error(`cannot reconcile job ${jobId}: ${core.reason}`);
    }
    return this.get({ jobId });
  }

  // Bounded recovery lookup (v0.2 M7-C). Resolves the SINGLE Codex job bound to a
  // durable orchestration identity (taskId/stepId/identity) within a workspace.
  // Fails closed on not_found / ambiguous / wrong_workspace / stale and NEVER guesses
  // 'most recent'. If the bound job needs reconciliation it is reconciled
  // authoritatively via resume(); a failed reconcile surfaces as a structured
  // RecoveryError rather than a silent force-unlock or a duplicate thread/turn.
  async recover({ workspaceId = null, workspaceRoot = null, taskId = null, stepId = null, identity = null } = {}) {
    if (workspaceId == null && workspaceRoot == null) {
      throw new RecoveryError('bad_request', 'codex_recover requires a workspace');
    }
    const candidates = this.jobMap.findByBinding({ taskId, stepId, identity });
    if (candidates.length === 0) {
      throw new RecoveryError('not_found', `no Codex execution bound to the provided orchestration identity (taskId=${taskId || '-'}, stepId=${stepId || '-'}, identity=${identity || '-'})`);
    }
    const sameWorkspace = (j) => {
      if (workspaceId && j.workspaceId && j.workspaceId === workspaceId) return true;
      if (workspaceRoot && j.workspaceRoot && rootsEqual(j.workspaceRoot, workspaceRoot)) return true;
      return false;
    };
    const inWorkspace = candidates.filter(sameWorkspace);
    if (inWorkspace.length === 0) {
      throw new RecoveryError('wrong_workspace', 'the Codex execution(s) bound to this identity do not belong to the requested workspace; refusing cross-workspace recovery');
    }
    if (inWorkspace.length > 1) {
      throw new RecoveryError('ambiguous', `${inWorkspace.length} Codex executions are bound to this identity in this workspace; refine with taskId/stepId or disambiguate (no guess)`, { matchCount: inWorkspace.length });
    }
    const job = inWorkspace[0];
    const jobId = job.jobId;
    // Determine whether the persisted binding requires authoritative reconciliation.
    // Force reconcile when the binding is already recovery_required, has no thread
    // identity, or the client is not live (local restart). Never infer a stale turn.
    let needsReconcile = job.state === 'recovery_required' || !job.threadId || !this.client.isRunning;
    let state = null;
    if (!needsReconcile) {
      try {
        state = await this.get({ jobId });
      } catch (e) {
        throw new RecoveryError('stale', `cannot read bound Codex execution ${jobId}: ${e.message}`, { jobId });
      }
      if (state.recoveryRequired) needsReconcile = true;
    }
    if (needsReconcile) {
      try {
        return await this.resume({ jobId });
      } catch (e) {
        throw new RecoveryError('stale', `cannot reconcile bound Codex execution ${jobId}: ${e.message}`, { jobId });
      }
    }
    return state;
  }

  async _boundedReconcile(jobId, attempts = 3, delayMs = 150) {
    const job = this.jobMap.load(jobId);
    if (!job) return { jobId, reconciliation: 'unresolved', ownershipReleased: false, recoveryRequired: true };
    for (let i = 0; i < attempts; i++) {
      const turn = await this._authoritativeTurn(job);
      if (turn && TERMINAL_TURN_STATES.includes(turn.status)) {
        const rel = this._releaseUnitOnTerminal(job, turn.status);
        return { jobId, state: turn.status, reconciliation: 'confirmed', ownershipReleased: rel.ownershipReleased, recoveryRequired: false, mutationUnitId: job.mutationUnitId || null };
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    this.jobMap.update(jobId, { state: 'interrupted', updatedAt: Date.now() });
    return { jobId, state: 'interrupted', reconciliation: 'unresolved', ownershipReleased: false, recoveryRequired: true, mutationUnitId: job.mutationUnitId || null };
  }

  async interrupt({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    if (!job.threadId || !job.turnId) throw new Error(`job ${jobId} has no turn to interrupt`);
    await this.client.request('turn/interrupt', { threadId: job.threadId, turnId: job.turnId });
    this.jobMap.update(jobId, { state: 'interrupted', updatedAt: Date.now() });
    return this._boundedReconcile(jobId);
  }

  async respondApproval({ jobId = null, approvalId = null, decision }) {
    if (!APPROVAL_DECISIONS.includes(decision)) throw new ApprovalError(`invalid decision: ${decision}`);
    if (jobId == null || approvalId == null) throw new ApprovalError('respondApproval requires jobId and approvalId');

    const job = this.jobMap.load(jobId);
    if (!job) throw new ApprovalError(`unknown job: ${jobId}`);

    const key = String(approvalId);
    const pending = this._approvals.get(key);
    if (!pending || pending.resolved) throw new ApprovalError(`unknown or stale approval id: ${approvalId}`);

    const info = pending.info;
    if (info.threadId && info.threadId !== job.threadId) {
      throw new ApprovalError(`approval ${approvalId} does not belong to job ${jobId} (thread mismatch)`);
    }
    if (info.turnId && job.turnId && info.turnId !== job.turnId) {
      throw new ApprovalError(`approval ${approvalId} does not belong to job ${jobId} (turn mismatch)`);
    }

    const result = mapDecision({ method: info.method, decision });
    this.client.respondRequest(pending.requestId, result);
    pending.resolved = true;
    this._approvals.delete(key);
    return { jobId, approvalId, decision, method: info.method, ok: true };
  }

  release({ force = false } = {}) { return this.owner.release({ force }); }
  markUnitState(state) { return this.owner.markUnitState(state); }

  async shutdown() { await this.client.close(); }
}

export { extractAssistantText };
