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
//   - reconcile()/resume()/interrupt share an authoritative identity-safe observer.
//     Legacy history uses thread/resume + thread/read(includeTurns=true); paginated
//     history uses bounded thread/turns/list pages and never infers status from absence.
//     The observer resolves the CURRENT mutation unit (durable-binding an unseen single
//     candidate only when uniquely proven) before reconciling that unit's real status.
//     Never infers current-B terminal from old-A terminal. No generic force-unlock.

import path from 'node:path';
import { AppServerClient } from './app-server-client.js';
import { JobMap, makeJobId, makeMutationUnitId, PRE_TURN_NOT_MATERIALIZED } from './job-map.js';
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

export const CODEX_START_PHASES = Object.freeze({
  THREAD_CREATED: 'thread_created',
  PERMISSION_VERIFIED: 'permission_verified',
  WRITER_RESERVED_TURN_START_PENDING: 'writer_reserved_turn_start_pending',
  TURN_BOUND: 'turn_bound',
});

const AUTHORITATIVE_TURN_PAGE_SIZE = 25;
const AUTHORITATIVE_TURN_MAX_PAGES = 8;
const AUTHORITATIVE_TURN_MAX_SCANNED = AUTHORITATIVE_TURN_PAGE_SIZE * AUTHORITATIVE_TURN_MAX_PAGES;

function appServerErrorText(error) {
  return String((error && error.message) || error || '').toLowerCase();
}

function isPaginatedFullHistoryIncompatibility(error) {
  const text = appServerErrorText(error);
  return text.includes('paginated_threads')
    || (text.includes('paginated') && text.includes('full-history'))
    || (text.includes('paginated') && text.includes('thread/turns/list'));
}

function isMethodUnsupported(error) {
  const text = appServerErrorText(error);
  return text.includes('"code":-32601')
    || text.includes('method not found')
    || text.includes('unsupported method')
    || text.includes('is unavailable');
}

function noRolloutThreadIds(error) {
  const text = String((error && error.message) || error || '');
  const ids = [];
  const re = /no rollout found for thread id\s+([0-9a-z-]+)/ig;
  let match;
  while ((match = re.exec(text)) !== null) ids.push(match[1]);
  return ids;
}

function isExactNoRolloutForThread(error, threadId) {
  if (!threadId) return false;
  const ids = noRolloutThreadIds(error);
  return ids.length > 0 && ids.every((id) => id === threadId);
}

function threadHistoryMode(thread) {
  return String((thread && thread.historyMode) || '').toLowerCase();
}

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
  constructor({ dataRoot = null, codexBin = null, listen = null, cwd = null, client = null, jobMap = null, mutationOwner = null, persistenceProfile = null } = {}) {
    this.client = client || new AppServerClient({ codexBin: codexBin || undefined, listen: listen || undefined, cwd: cwd || undefined });
    this.jobMap = jobMap || new JobMap({ dataRoot });
    this.owner = mutationOwner || new MutationOwner();
    this.persistenceProfile = persistenceProfile ? path.resolve(String(persistenceProfile)) : null;
    this._approvals = new Map();
    this._notifiers = new Set();
    this._turnUnits = new Map(); // in-memory cache (durable source of truth is job.turnUnits)
    this._settingsWaiters = new Map(); // threadId -> { resolve, reject, timer } for thread/settings/updated
    this._recoveryObservationThreads = new Set(); // suppress replayed turn lifecycle side-effects during bounded remediation
    this._recoveryObservedTurns = new Map(); // threadId -> replayed authoritative turn lifecycle evidence
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
      if (this._recoveryObservationThreads.has(threadId)) {
        const evidence = this._recoveryObservedTurns.get(threadId) || [];
        const turn = params.turn || {};
        evidence.push({ method, turnId: turn.id || null, status: turn.status || null });
        this._recoveryObservedTurns.set(threadId, evidence);
        this._emit(note);
        return;
      }
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
      this.jobMap.update(job.jobId, { state, turnId: notifiedTurnId || job.turnId, startupPhase: CODEX_START_PHASES.TURN_BOUND, turnStartDispatched: true, updatedAt: Date.now() });
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

  async _paginatedTurnHistory(job) {
    const unitId = job.mutationUnitId || null;
    const turnUnits = job.turnUnits || {};
    const currentBoundIds = Object.entries(turnUnits)
      .filter(([, mappedUnitId]) => mappedUnitId === unitId)
      .map(([turnId]) => turnId);
    const exactTurnId = (job.turnId && turnUnits[job.turnId] === unitId)
      ? job.turnId
      : (currentBoundIds.length === 1 ? currentBoundIds[0] : null);

    let cursor = null;
    let pages = 0;
    let scanned = 0;
    const seenCursors = new Set();
    const turns = [];
    const seenTurnIds = new Set();

    while (pages < AUTHORITATIVE_TURN_MAX_PAGES && scanned < AUTHORITATIVE_TURN_MAX_SCANNED) {
      const remaining = AUTHORITATIVE_TURN_MAX_SCANNED - scanned;
      const limit = Math.min(AUTHORITATIVE_TURN_PAGE_SIZE, remaining);
      let page;
      try {
        page = await this.client.request('thread/turns/list', {
          threadId: job.threadId,
          cursor,
          limit,
          sortDirection: 'desc',
          itemsView: 'notLoaded',
        });
      } catch (e) {
        return {
          ok: false,
          reason: 'thread/turns/list failed: ' + String(e.message || e).slice(0, 160),
          observationCode: isMethodUnsupported(e) ? 'paginated_turns_list_unsupported' : 'paginated_turns_list_failed',
        };
      }

      if (!page || !Array.isArray(page.data)) {
        return { ok: false, reason: 'thread/turns/list returned unreadable page', observationCode: 'paginated_turns_unreadable' };
      }

      pages += 1;
      scanned += page.data.length;
      for (const turn of page.data) {
        if (!turn || !turn.id) continue;
        if (exactTurnId && turn.id === exactTurnId) {
          return { ok: true, turns: [turn], complete: false, historyMode: 'paginated', pages, scanned };
        }
        if (!seenTurnIds.has(turn.id)) {
          seenTurnIds.add(turn.id);
          turns.push(turn);
        }
      }

      const nextCursor = page.nextCursor || null;
      if (!nextCursor) {
        if (exactTurnId) {
          return {
            ok: false,
            reason: 'exact current-unit turn was not found in paginated history',
            observationCode: 'paginated_turn_not_found',
          };
        }
        return { ok: true, turns, complete: true, historyMode: 'paginated', pages, scanned };
      }
      if (seenCursors.has(nextCursor) || nextCursor === cursor) {
        return { ok: false, reason: 'thread/turns/list cursor did not advance', observationCode: 'paginated_cursor_loop' };
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return {
      ok: false,
      reason: 'paginated authoritative turn search exceeded bounded page/turn ceiling',
      observationCode: 'paginated_page_limit',
    };
  }

  async _authoritativeTurn(job) {
    if (!job || !job.threadId) {
      return { ok: false, reason: 'no thread identity to reconcile', observationCode: 'missing_thread_identity' };
    }

    let resumed;
    try {
      resumed = await this.client.request('thread/resume', {
        threadId: job.threadId,
        ...(job.cwd ? { cwd: job.cwd } : {}),
        excludeTurns: true,
      });
    } catch (e) {
      return {
        ok: false,
        reason: 'resume failed: ' + String(e.message || e).slice(0, 160),
        observationCode: 'resume_failed',
        exactNoRolloutForThread: isExactNoRolloutForThread(e, job.threadId),
        noRolloutThreadIds: noRolloutThreadIds(e),
      };
    }
    if (!(resumed && resumed.thread && resumed.thread.id)) {
      return { ok: false, reason: 'thread/resume returned no thread id', observationCode: 'resume_no_thread_identity' };
    }

    let history;
    const resumedMode = threadHistoryMode(resumed.thread);
    if (resumedMode === 'paginated') {
      history = await this._paginatedTurnHistory(job);
    } else {
      let read;
      try {
        read = await this.client.request('thread/read', { threadId: job.threadId, includeTurns: true });
      } catch (e) {
        if (!isPaginatedFullHistoryIncompatibility(e)) {
          return { ok: false, reason: 'thread/read failed: ' + String(e.message || e).slice(0, 160), observationCode: 'read_failed' };
        }
        history = await this._paginatedTurnHistory(job);
      }
      if (!history) {
        const thread = read && read.thread;
        if (!thread) return { ok: false, reason: 'thread/read returned no thread', observationCode: 'read_no_thread' };
        if (threadHistoryMode(thread) === 'paginated') history = await this._paginatedTurnHistory(job);
        else history = { ok: true, turns: Array.isArray(thread.turns) ? thread.turns : [], complete: true, historyMode: 'legacy' };
      }
    }

    if (!history.ok) return history;
    const resolved = this._resolveCurrentUnitTurn(job, history.turns || []);
    if (!resolved.ok) return resolved;

    const turn = resolved.turn;
    if (resolved.resolution === 'unbound_single') {
      const tu = { ...(job.turnUnits || {}), [turn.id]: resolved.unitId };
      this.jobMap.update(job.jobId, { turnId: turn.id, turnUnits: tu, updatedAt: Date.now() });
      this._turnUnits.set(turn.id, resolved.unitId);
    }
    if (!turn || !turn.status) {
      return { ok: false, reason: 'authoritative turn has no readable status', observationCode: 'lifecycle_unreadable' };
    }
    return { ok: true, turn, resolution: resolved.resolution, unitId: resolved.unitId, historyMode: history.historyMode || resumedMode || 'legacy' };
  }

  async _ensureConnected() {
    if (!this.client.isRunning) await this.client.connect();
    else if (!this.client._connected) await this.client.connect();
  }

  // Resolve which turn belongs to the CURRENT mutation unit (durable identity).
  // Failure returns a stable observationCode for bounded aggregate diagnostics.
  _resolveCurrentUnitTurn(job, turns) {
    const unitId = job.mutationUnitId || null;
    if (!unitId) return { ok: false, reason: 'no current mutation unit', observationCode: 'turn_binding_none' };
    const turnUnits = job.turnUnits || {};
    const bound = turns.find((t) => t && turnUnits[t.id] === unitId);
    if (bound) return { ok: true, turn: bound, resolution: 'bound', unitId };
    const unbound = turns.filter((t) => t && !turnUnits[t.id]);
    if (unbound.length === 1) return { ok: true, turn: unbound[0], resolution: 'unbound_single', unitId };
    if (unbound.length === 0) return { ok: false, reason: 'no candidate turn for current mutation unit', observationCode: 'turn_binding_none', unitId };
    return { ok: false, reason: 'multiple candidate turns for current mutation unit', observationCode: 'turn_binding_multiple', unitId };
  }

  _verifiedWriterContractForPreTurnRecovery(job) {
    if (!job || job.accessMode !== 'workspace_write') return { ok: false, observationCode: 'pre_turn_not_workspace_write', reason: 'pre-turn no-materialization recovery requires workspace_write' };
    if (!job.workspaceRoot) return { ok: false, observationCode: 'pre_turn_workspace_unknown', reason: 'pre-turn recovery requires the exact durable workspace root' };
    if (job.effectiveVerified !== true) return { ok: false, observationCode: 'pre_turn_permission_unverified', reason: 'effective permission proof is missing' };
    if (job.effectiveSandbox !== WORKSPACE_WRITE || job.effectiveApprovalPolicy !== 'on-request') {
      return { ok: false, observationCode: 'pre_turn_permission_mismatch', reason: 'effective workspace-write permission contract does not match' };
    }
    if (job.effectiveWritableRootMatch !== true || job.effectiveNetworkAccess !== (job.networkAccess === true)) {
      return { ok: false, observationCode: 'pre_turn_permission_mismatch', reason: 'effective workspace/network permission proof does not match the requested contract' };
    }
    const expected = JSON.stringify({
      accessMode: 'workspace_write',
      networkAccess: job.networkAccess === true,
      sandboxPolicy: buildSandboxPolicy('workspace_write', { workspaceRoot: job.workspaceRoot, networkAccess: job.networkAccess === true }),
    });
    if (job.verifiedForRequestedContract !== expected) {
      return { ok: false, observationCode: 'pre_turn_permission_contract_stale', reason: 'durable permission proof is not for the exact current workspace-write contract' };
    }
    return { ok: true };
  }

  _persistenceProfileForPreTurnRecovery(job) {
    if (!this.persistenceProfile) {
      return { ok: false, observationCode: 'persistence_profile_unknown', reason: 'current Codex persistence profile is not configured; refusing no-rollout inference' };
    }
    if (job.persistenceProfile) {
      if (!rootsEqual(job.persistenceProfile, this.persistenceProfile)) {
        return { ok: false, observationCode: 'persistence_profile_mismatch', reason: 'durable job Codex persistence profile differs from the current runtime profile' };
      }
      return { ok: true, legacyInferred: false };
    }

    // Legacy records predate explicit profile storage. The compatibility inference is
    // limited to records physically in this JobMap/dataRoot, under a configured server-owned
    // Stable Runtime profile, with the exact durable permission snapshot present.
    const isStructurallyLegacy = !Object.prototype.hasOwnProperty.call(job, 'startupPhase')
      && !Object.prototype.hasOwnProperty.call(job, 'persistenceProfile');
    if (!isStructurallyLegacy || job.state !== 'recovery_required' || !job.verifiedAt || !job.verifiedForRequestedContract) {
      return { ok: false, observationCode: 'persistence_profile_unknown', reason: 'durable job Codex persistence profile is unknown' };
    }
    return { ok: true, legacyInferred: true };
  }

  _classifyPreTurnNotMaterialized(job, observed) {
    if (!observed || observed.observationCode !== 'resume_failed' || observed.exactNoRolloutForThread !== true) {
      return { ok: false, observationCode: observed?.observationCode || 'lifecycle_unreadable', reason: observed?.reason || 'authoritative lifecycle evidence unavailable' };
    }
    if (!job || !job.jobId || !job.mutationUnitId) {
      return { ok: false, observationCode: 'pre_turn_identity_missing', reason: 'exact durable job/mutation-unit identity is missing' };
    }
    const permission = this._verifiedWriterContractForPreTurnRecovery(job);
    if (!permission.ok) return permission;
    if (!job.threadId) return { ok: false, observationCode: 'pre_turn_thread_missing', reason: 'durable thread identity is missing' };
    if (job.turnId != null) return { ok: false, observationCode: 'pre_turn_turn_identity_present', reason: 'a durable turn identity already exists' };

    const unitId = job.mutationUnitId;
    const turnUnits = job.turnUnits && typeof job.turnUnits === 'object' ? job.turnUnits : {};
    if (Object.values(turnUnits).some((mappedUnitId) => mappedUnitId === unitId)) {
      return { ok: false, observationCode: 'pre_turn_unit_turn_binding_present', reason: 'the current mutation unit already has durable turn evidence' };
    }

    const hasExplicitPhase = Object.prototype.hasOwnProperty.call(job, 'startupPhase');
    const compatibleExplicitPhase = job.startupPhase === CODEX_START_PHASES.PERMISSION_VERIFIED
      || job.startupPhase === CODEX_START_PHASES.WRITER_RESERVED_TURN_START_PENDING;
    const compatibleLegacy = !hasExplicitPhase && job.state === 'recovery_required';
    if (!compatibleExplicitPhase && !compatibleLegacy) {
      return { ok: false, observationCode: 'pre_turn_startup_phase_ambiguous', reason: 'durable startup phase is not compatible with a fresh pre-turn orphan' };
    }

    const replayed = this._recoveryObservedTurns.get(job.threadId) || [];
    if (replayed.length > 0) {
      return { ok: false, observationCode: 'pre_turn_replayed_turn_evidence', reason: 'authoritative replay exposed turn lifecycle evidence; normal turn recovery remains required' };
    }

    const profile = this._persistenceProfileForPreTurnRecovery(job);
    if (!profile.ok) return profile;
    return {
      ok: true,
      resolution: PRE_TURN_NOT_MATERIALIZED,
      state: PRE_TURN_NOT_MATERIALIZED,
      unitId,
      legacyProfileInferred: profile.legacyInferred === true,
    };
  }

  _terminalizePreTurnNotMaterialized(job, classified) {
    const unitId = job.mutationUnitId || null;
    if (!classified?.ok || classified.resolution !== PRE_TURN_NOT_MATERIALIZED || !unitId) {
      return { ok: false, resolution: 'unresolved', recoveryRequired: true, reason: 'pre-turn no-materialization classification was not authoritative' };
    }
    if (this.owner.owner === 'codex' && this.owner.unitId !== unitId) {
      this.jobMap.update(job.jobId, { state: 'recovery_required', updatedAt: Date.now() });
      return { ok: false, resolution: 'unresolved', recoveryRequired: true, observationCode: 'pre_turn_foreign_owner', reason: 'a different Codex mutation unit owns the workspace; refusing release' };
    }
    if (this.owner.owner === 'chatgpt') {
      this.jobMap.update(job.jobId, { state: 'recovery_required', updatedAt: Date.now() });
      return { ok: false, resolution: 'unresolved', recoveryRequired: true, observationCode: 'pre_turn_foreign_owner', reason: 'ChatGPT owns the workspace; refusing pre-turn Codex terminalization' };
    }

    let ownershipReleased = this.owner.owner === 'none';
    if (this.owner.owner === 'codex' && this.owner.unitId === unitId) {
      this.owner.markUnitState('reconciled');
      ownershipReleased = this.owner.release().released;
    }

    const patch = {
      state: PRE_TURN_NOT_MATERIALIZED,
      recoveryCode: PRE_TURN_NOT_MATERIALIZED,
      recoveryReason: 'exact thread has no rollout under the verified same-profile pre-turn contract',
      reconciledMutationUnitId: unitId,
      ownershipReleased,
      updatedAt: Date.now(),
    };
    if (classified.legacyProfileInferred === true && !job.persistenceProfile) {
      patch.persistenceProfile = this.persistenceProfile;
      patch.persistenceProfileInferredLegacy = true;
    }
    this.jobMap.update(job.jobId, patch);
    return {
      ok: true,
      resolution: PRE_TURN_NOT_MATERIALIZED,
      state: PRE_TURN_NOT_MATERIALIZED,
      recoveryCode: PRE_TURN_NOT_MATERIALIZED,
      ownershipReleased,
      recoveredUnitId: unitId,
      mutationUnitId: unitId,
    };
  }

  // Authoritative lifecycle observation for one already-selected durable job. It may bind
  // a uniquely identifiable materialized turn, or classify the narrow exact-thread
  // pre-turn/no-rollout case. It never starts/continues/interrupts a turn.
  async _authoritativeObserveLifecycle(job) {
    if (!job || !job.threadId) return this._authoritativeObserveLifecycleCore(job);
    this._recoveryObservationThreads.add(job.threadId);
    this._recoveryObservedTurns.set(job.threadId, []);
    try {
      return await this._authoritativeObserveLifecycleCore(job);
    } finally {
      this._recoveryObservationThreads.delete(job.threadId);
      this._recoveryObservedTurns.delete(job.threadId);
    }
  }

  async _authoritativeObserveLifecycleCore(job) {
    const jobId = job.jobId;
    const unitId = job.mutationUnitId || null;
    const observed = await this._authoritativeTurn(job);
    if (!observed.ok) {
      const preTurn = this._classifyPreTurnNotMaterialized(job, observed);
      if (preTurn.ok) return preTurn;
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      return { ok: false, resolution: 'unresolved', reason: preTurn.reason || observed.reason, observationCode: preTurn.observationCode || observed.observationCode || 'lifecycle_unreadable' };
    }
    const turn = observed.turn;
    if (TERMINAL_TURN_STATES.includes(turn.status)) return { ok: true, resolution: 'terminal', state: turn.status, unitId, observationCode: null };
    if (turn.status === 'inProgress') return { ok: true, resolution: 'in_progress', state: 'running', unitId, observationCode: null };
    this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
    return { ok: false, resolution: 'unresolved', reason: 'ambiguous or unreadable turn state', observationCode: 'lifecycle_unreadable' };
  }

  // Shared authoritative identity-safe reconciliation (used by reconcile() and resume()).
  // thread/resume + thread/read -> resolve the CURRENT mutation unit's turn (durably
  // binding a single unseen candidate) -> reconcile its real status.
  async _authoritativeReconcileCore(job) {
    const jobId = job.jobId;
    const unitId = job.mutationUnitId || null;
    const isWriter = this._isWriter(job);
    const observed = await this._authoritativeObserveLifecycle(job);
    if (!observed.ok) {
      return { ok: false, resolution: 'unresolved', recoveryRequired: true, reason: observed.reason, observationCode: observed.observationCode || 'lifecycle_unreadable' };
    }

    if (observed.resolution === PRE_TURN_NOT_MATERIALIZED) {
      return this._terminalizePreTurnNotMaterialized(job, observed);
    }

    if (observed.resolution === 'terminal') {
      if (!isWriter) {
        const rel = this._releaseUnitOnTerminal(job, observed.state);
        return { ok: true, resolution: 'terminal', state: observed.state, ownershipReleased: rel.ownershipReleased, recoveredUnitId: unitId, mutationUnitId: unitId };
      }
      if (this.owner.owner === 'codex' && this.owner.unitId !== unitId) {
        this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
        return { ok: false, resolution: 'unresolved', recoveryRequired: true, reason: `ownership conflict: active codex unit ${this.owner.unitId} differs from job unit ${unitId}` };
      }
      if (this.owner.owner === 'chatgpt') {
        this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
        return { ok: false, resolution: 'unresolved', recoveryRequired: true, reason: 'ownership conflict: workspace owned by chatgpt' };
      }
      const rel = this._releaseUnitOnTerminal(job, observed.state);
      return { ok: true, resolution: 'terminal', state: observed.state, ownershipReleased: rel.ownershipReleased, recoveredUnitId: unitId, mutationUnitId: unitId };
    }

    if (observed.resolution === 'in_progress') {
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
    this.jobMap.save(jobId, { jobId, mutationUnitId, accessMode, sandbox, sandboxPolicy, approvalPolicy, isWriter, workspaceRoot, workspaceId, networkAccess: networkAccess === true, requestPermission: { sandbox, approvalPolicy, sandboxPolicy }, effectiveVerified: false, taskId: taskId || null, stepId: stepId || null, identity: identity || null, threadId: null, turnId: null, startupPhase: null, turnStartDispatched: false, persistenceProfile: this.persistenceProfile, recoveryCode: null, recoveryReason: null, reconciledMutationUnitId: null, state: 'created', ownershipReleased: false, turnUnits: {}, createdAt: Date.now(), updatedAt: Date.now() });

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

    this.jobMap.update(jobId, { threadId, legacyThreadSandbox: effectiveSandboxMode(threadRes.sandbox), startupPhase: CODEX_START_PHASES.THREAD_CREATED, state: 'thread_ready', updatedAt: Date.now() });

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
      startupPhase: CODEX_START_PHASES.PERMISSION_VERIFIED,
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
    this.jobMap.update(jobId, { state: 'starting', startupPhase: isWriter ? CODEX_START_PHASES.WRITER_RESERVED_TURN_START_PENDING : CODEX_START_PHASES.PERMISSION_VERIFIED, turnStartDispatched: false, updatedAt: Date.now() });

    // Persist dispatch intent only after effective permission verification and exact writer acquisition.
    this.jobMap.update(jobId, { turnStartDispatched: true, updatedAt: Date.now() });
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
    this.jobMap.update(jobId, { turnId, turnUnits: { ...(startJob.turnUnits || {}), [turnId]: mutationUnitId }, startupPhase: CODEX_START_PHASES.TURN_BOUND, turnStartDispatched: true, state: 'running', updatedAt: Date.now() });
    const eff = permissionContract(this.jobMap.load(jobId));
    return { jobId, threadId, turnId, state: 'running', accessMode, sandbox, approvalPolicy, isWriter, mutationOwner: this.owner.owner, effectiveSandbox: eff.effectiveSandbox, effectiveApprovalPolicy: eff.effectiveApprovalPolicy, effectiveVerified: eff.effectiveVerified, permissionContract: eff };
  }

  load(jobId) { return this.jobMap.load(jobId); }

  async get({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);

    if (job.state === PRE_TURN_NOT_MATERIALIZED) {
      const eff = permissionContract(job);
      return {
        jobId,
        threadId: job.threadId || null,
        turnId: null,
        accessMode: job.accessMode || null,
        sandbox: job.sandbox || null,
        effectiveSandbox: job.effectiveSandbox || null,
        effectiveApprovalPolicy: job.effectiveApprovalPolicy || null,
        effectiveVerified: job.effectiveVerified === true,
        effectiveWritableRoots: Array.isArray(job.effectiveWritableRoots) ? job.effectiveWritableRoots : null,
        effectiveNetworkAccess: job.effectiveNetworkAccess === true,
        effectiveWritableRootMatch: job.effectiveWritableRootMatch === true,
        verifiedForRequestedContract: job.verifiedForRequestedContract || null,
        permissionContract: eff,
        isWriter: job.isWriter !== false,
        workspaceRoot: job.workspaceRoot || null,
        workspaceId: job.workspaceId || null,
        state: PRE_TURN_NOT_MATERIALIZED,
        live: false,
        recoveryRequired: false,
        nextAction: null,
        readErrorCode: null,
        threadStatus: null,
        result: null,
        assistantText: null,
        pendingApprovals: [],
        mutationOwner: this.owner.owner,
        jobMutationUnitId: job.mutationUnitId || null,
        ownerMutationUnitId: this.owner.owner !== 'none' ? this.owner.unitId : null,
        mutationUnitState: job.ownershipReleased === true ? 'released' : 'none',
        ownershipReleased: job.ownershipReleased === true,
        recoveryCode: job.recoveryCode || PRE_TURN_NOT_MATERIALIZED,
        recoveryReason: job.recoveryReason || null,
        turn: null,
      };
    }

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
    if (job.state === PRE_TURN_NOT_MATERIALIZED) throw new Error(`job ${jobId} has no materialized turn/thread rollout to continue`);
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
    const bindingPatch = { mutationUnitId, accessMode, sandbox: job.sandbox || null, sandboxPolicy, approvalPolicy, isWriter, ownershipReleased: false, startupPhase: isWriter ? CODEX_START_PHASES.WRITER_RESERVED_TURN_START_PENDING : CODEX_START_PHASES.PERMISSION_VERIFIED, turnStartDispatched: false, recoveryCode: null, recoveryReason: null, reconciledMutationUnitId: null, state: 'starting', updatedAt: Date.now() };
    if (taskId != null) bindingPatch.taskId = taskId;
    if (stepId != null) bindingPatch.stepId = stepId;
    if (identity != null) bindingPatch.identity = identity;
    this.jobMap.update(jobId, bindingPatch);
    this.jobMap.update(jobId, { turnStartDispatched: true, updatedAt: Date.now() });

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
    this.jobMap.update(jobId, { turnId, turnUnits: { ...(contJob.turnUnits || {}), [turnId]: mutationUnitId }, startupPhase: CODEX_START_PHASES.TURN_BOUND, turnStartDispatched: true, state: 'running', updatedAt: Date.now() });
    const contEff = permissionContract(this.jobMap.load(jobId));
    return { jobId, threadId: job.threadId, turnId, state: 'running', accessMode, sandbox: job.sandbox || null, approvalPolicy, isWriter, mutationOwner: this.owner.owner, effectiveSandbox: contEff.effectiveSandbox, effectiveApprovalPolicy: contEff.effectiveApprovalPolicy, effectiveVerified: contEff.effectiveVerified, permissionContract: contEff };
  }

  async reconcileRecoveryPreflight({ workspaceId = null, workspaceRoot = null, taskId = null, stepId = null, identity = null } = {}) {
    const args = { workspaceId, workspaceRoot, taskId, stepId, identity };
    const selected = this.jobMap.recoveryPreflightCandidates(args);
    if (!selected.ok) return selected;
    if (selected.dangerous.length === 0) return this.jobMap.recoveryPreflight(args);

    await this._ensureConnected();
    let unresolvedCandidateCount = 0;
    const reasonCounts = {};
    for (const { job } of selected.dangerous) {
      const observed = await this._authoritativeObserveLifecycle(job);
      if (!observed.ok) {
        unresolvedCandidateCount += 1;
        const code = observed.observationCode || 'lifecycle_unreadable';
        reasonCounts[code] = (reasonCounts[code] || 0) + 1;
        continue;
      }
      if (observed.resolution === PRE_TURN_NOT_MATERIALIZED) {
        const terminalized = this._terminalizePreTurnNotMaterialized(job, observed);
        if (!terminalized.ok) {
          unresolvedCandidateCount += 1;
          const code = terminalized.observationCode || 'pre_turn_terminalization_failed';
          reasonCounts[code] = (reasonCounts[code] || 0) + 1;
          continue;
        }
      } else if (observed.resolution === 'terminal') {
        if (this._isWriter(job) && this.owner.owner === 'codex' && this.owner.unitId === (job.mutationUnitId || null)) {
          this._releaseUnitOnTerminal(job, observed.state);
        } else {
          this.jobMap.update(job.jobId, { state: observed.state, ownershipReleased: this.owner.owner === 'none', updatedAt: Date.now() });
        }
      } else if (observed.resolution === 'in_progress') {
        this.jobMap.update(job.jobId, { state: 'running', ownershipReleased: false, updatedAt: Date.now() });
      }
    }

    if (unresolvedCandidateCount > 0) {
      return {
        ok: false,
        error: 'reconciliation_unresolved',
        reason: 'one or more hidden recovery-risk executions could not be authoritatively reconciled; refusing to infer safety',
        unresolvedCandidateCount,
        reasonCounts,
      };
    }
    const after = this.jobMap.recoveryPreflight(args);
    if (after.ok && after.status === 'recover_existing' && after.dangerousCandidateCount === 1 && after.recovery && after.recovery.jobId) {
      return {
        ...after,
        nextAction: 'codex_reconcile',
        recovery: { ...after.recovery, mode: 'job_id' },
      };
    }
    return after;
  }

  async reconcile({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    if (job.state === PRE_TURN_NOT_MATERIALIZED) {
      return { jobId, reconciled: true, resolution: PRE_TURN_NOT_MATERIALIZED, state: PRE_TURN_NOT_MATERIALIZED, recoveryCode: PRE_TURN_NOT_MATERIALIZED, ownershipReleased: job.ownershipReleased === true, recoveryRequired: false, mutationUnitId: job.mutationUnitId || null };
    }
    await this._ensureConnected();
    if (!job.threadId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      return { jobId, reconciled: false, resolution: 'unresolved', recoveryRequired: true, reason: 'no thread identity to reconcile' };
    }
    const core = await this._authoritativeReconcileCore(job);
    if (!core.ok) {
      return { jobId, reconciled: false, resolution: 'unresolved', recoveryRequired: true, reason: core.reason, observationCode: core.observationCode || 'lifecycle_unreadable' };
    }
    return {
      jobId, reconciled: true, resolution: core.resolution, state: core.state,
      ownershipReleased: core.ownershipReleased === true, recoveryRequired: false, mutationUnitId: core.mutationUnitId || null,
      ...(core.recoveryCode ? { recoveryCode: core.recoveryCode } : {}),
    };
  }

  async resume({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    if (job.state === PRE_TURN_NOT_MATERIALIZED) return this.get({ jobId });
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
    if (job.state === PRE_TURN_NOT_MATERIALIZED) return this.get({ jobId });
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
    if (!job) return { jobId, reconciliation: 'unresolved', ownershipReleased: false, recoveryRequired: true, observationCode: 'missing_job' };
    let lastObservation = null;
    for (let i = 0; i < attempts; i++) {
      const observed = await this._authoritativeTurn(job);
      lastObservation = observed;
      if (observed.ok && TERMINAL_TURN_STATES.includes(observed.turn.status)) {
        const rel = this._releaseUnitOnTerminal(job, observed.turn.status);
        return { jobId, state: observed.turn.status, reconciliation: 'confirmed', ownershipReleased: rel.ownershipReleased, recoveryRequired: false, mutationUnitId: job.mutationUnitId || null };
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
    return {
      jobId,
      state: 'recovery_required',
      reconciliation: 'unresolved',
      ownershipReleased: false,
      recoveryRequired: true,
      mutationUnitId: job.mutationUnitId || null,
      reason: lastObservation && lastObservation.reason ? lastObservation.reason : 'authoritative terminal state not confirmed',
      observationCode: lastObservation && lastObservation.observationCode ? lastObservation.observationCode : 'terminal_not_confirmed',
    };
  }

  async interrupt({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    if (!job.threadId || !job.turnId) throw new Error(`job ${jobId} has no turn to interrupt`);
    await this.client.request('turn/interrupt', { threadId: job.threadId, turnId: job.turnId });
    this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
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
