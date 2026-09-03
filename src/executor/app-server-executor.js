// chatgpt-codex-orchestrator: AppServerExecutor (v0.2 M1, M7 hardening R2).
// Productionized wrapper over AppServerClient + JobMap + MutationOwner + approval.
// Exposes a thin, stable MCP-facing facade: start / get / continue / interrupt /
// respondApproval / reconcile / resume / shutdown. It does NOT expose raw App Server
// protocol.
//
// Ownership rules (M7):
//   - A Codex mutation unit acquires `codex` writer ownership bound to a persisted
//     mutationUnitId BEFORE any mutating turn/start. Only ONE writer may be active
//     per workspace.
//   - A `read_only` Codex unit NEVER acquires MutationOwner writer ownership — on
//     start/continue/notification/recovery it leaves the owner as `none` (it does
//     not hold a writer lock, so it cannot block Direct Local or a writer unit).
//   - MutationOwner protects ONLY the currently-executing writer, NOT a Brain
//     acceptance/review lock. Execution ownership is released only when an
//     authoritative App Server turn status (completed / failed / interrupted) is
//     confirmed via thread/read. Missing / process-exit / ambiguous state stays
//     fail-closed (owner retained, recoveryRequired).
//   - A late notification for an OLD turn must never overwrite the job's active
//     turnId/state or release the CURRENT unit's ownership.
//
// Recovery: after a process/executor death, the persisted job carries its
// mutationUnitId so a FRESH AppServerExecutor can reconstruct ownership. reconcile()
// and resume() use thread/resume + thread/read and NEVER blindly create a duplicate
// thread/turn, and there is NO generic force-unlock.

import { AppServerClient } from './app-server-client.js';
import { JobMap, makeJobId, makeMutationUnitId } from './job-map.js';
import { MutationOwner, MutationOwnerError } from '../state/mutation-owner.js';
import { normalizeApproval, mapDecision, APPROVAL_DECISIONS, ApprovalError, SUPPORTED_BINARY_METHODS } from './approval.js';

// Orchestrator-level Codex access contract. danger-full-access is NOT exposed as a
// normal MCP option; only read_only / workspace_write are permitted.
export const ACCESS_MODES = Object.freeze(['read_only', 'workspace_write']);
// Map orchestrator accessMode -> authoritative Codex App Server SandboxMode enum.
export const SANDBOX_MODE_BY_ACCESS = Object.freeze({
  read_only: 'read-only',
  workspace_write: 'workspace-write',
});

// Authoritative App Server turn terminal statuses (TurnStatus enum).
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

export class AppServerExecutor {
  constructor({ dataRoot = null, codexBin = null, listen = null, cwd = null, client = null, jobMap = null, mutationOwner = null } = {}) {
    this.client = client || new AppServerClient({ codexBin: codexBin || undefined, listen: listen || undefined, cwd: cwd || undefined });
    this.jobMap = jobMap || new JobMap({ dataRoot });
    this.owner = mutationOwner || new MutationOwner();
    this._approvals = new Map();
    this._notifiers = new Set();
    this._setup();
  }

  _setup() {
    this.client.onNotification((note) => this._handleNotification(note));
    this.client.onServerRequest((req) => this._handleServerRequest(req));
    this.client.onExit((evt) => this._handleClientExit(evt));
  }

  onEvent(handler) { this._notifiers.add(handler); return () => this._notifiers.delete(handler); }
  _emit(event) { for (const h of this._notifiers) { try { h(event); } catch {} } }

  // True only when the unit is allowed to hold MutationOwner WRITER ownership. A
  // read_only Codex job is a reader and must never acquire writer ownership.
  _isWriter(job) { return !job || job.accessMode !== 'read_only'; }

  _handleClientExit(evt) {
    if (this.client._closing) return; // clean shutdown, not an unexpected death
    for (const job of this.jobMap.list()) {
      if (RECOVERY_STATES.includes(job.state)) {
        this.jobMap.update(job.jobId, { state: 'recovery_required', updatedAt: Date.now() });
      }
    }
    // Only a held writer becomes 'unknown'; a read_only unit never holds a writer, so
    // the owner stays none (no lingering writer lock after a read-only process death).
    if (this.owner.owner !== 'none') this.owner.markUnitState('unknown');
    this._emit({ type: 'process-exit', ...evt });
  }

  _handleNotification(note) {
    const method = note && note.method;
    if (method === 'turn/started' || method === 'turn/completed') {
      const params = note.params || {};
      const threadId = params.threadId;
      const turn = params.turn || {};
      const job = this.jobMap.findByThread(threadId);
      if (!job) { this._emit(note); return; }
      const notifiedTurnId = turn.id || null;
      // Stale-notification guard: if the job already advanced to a DIFFERENT active
      // turn, a late notification for an older turn must NOT overwrite the job's
      // turnId/state nor release the current unit's ownership.
      if (job.turnId && notifiedTurnId && notifiedTurnId !== job.turnId) {
        this._emit(note);
        return;
      }
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

  // Release `codex` writer ownership for a confirmed terminal unit. Only if this
  // job's mutationUnitId is the active owner unit do we release; otherwise a newer
  // unit is active and this terminal unit is stale (nothing to release).
  _releaseUnitOnTerminal(job, status, { jobMapUpdate = true } = {}) {
    if (!job) return { ownershipReleased: false, status, unitState: null };
    let ownershipReleased = false;
    if (this.owner.owner === 'codex' && this.owner.unitId === (job.mutationUnitId || null)) {
      this.owner.markUnitState('reconciled');
      const rel = this.owner.release();
      ownershipReleased = rel.released;
    } else if (this.owner.owner === 'none') {
      ownershipReleased = true; // already released (or a read_only unit never held a writer)
    }
    if (jobMapUpdate) this.jobMap.update(job.jobId, { state: status, ownershipReleased, updatedAt: Date.now() });
    return { ownershipReleased, status, unitState: ownershipReleased ? 'released' : this.owner.unitState };
  }

  // Authoritative thread/read: return the turn for this job, or null if unreadable/ambiguous.
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

  // Reconcile the owner for a resolved turn status. A read_only unit never acquires
  // a writer. On a terminal status the writer is reconciled + released.
  _reconcileOwner({ unitId, turnStatus, isWriter = true }) {
    const uid = unitId || makeMutationUnitId();
    if (isWriter) {
      if (this.owner.owner === 'none') this.owner.acquire('codex', uid);
      else if (this.owner.owner !== 'codex') this.owner.acquire('codex', uid);
    }
    if (TERMINAL_TURN_STATES.includes(turnStatus)) {
      if (isWriter && this.owner.owner === 'codex') {
        this.owner.markUnitState('reconciled');
        this.owner.release();
      }
      return { unitId: uid, ownershipReleased: true, unitState: 'released' };
    }
    if (turnStatus === 'inProgress') {
      if (isWriter && this.owner.owner === 'codex') this.owner.markUnitState('running');
      return { unitId: uid, ownershipReleased: false, unitState: isWriter ? 'running' : 'none' };
    }
    if (isWriter && this.owner.owner === 'codex') this.owner.markUnitState('unknown');
    return { unitId: uid, ownershipReleased: false, unitState: isWriter ? 'unknown' : 'none' };
  }

  async _ensureConnected() {
    if (!this.client.isRunning) await this.client.connect();
    else if (!this.client._connected) await this.client.connect();
  }

  async start({ prompt, cwd = null, accessMode = null, workspaceRoot = null, workspaceId = null } = {}) {
    await this._ensureConnected();
    if (!ACCESS_MODES.includes(accessMode)) {
      throw new Error(`codex start requires an explicit accessMode (one of: ${ACCESS_MODES.join(', ')}); refusing to default to read-only`);
    }
    const sandbox = SANDBOX_MODE_BY_ACCESS[accessMode];
    const isWriter = accessMode !== 'read_only';

    const jobId = makeJobId();
    const mutationUnitId = makeMutationUnitId();
    this.jobMap.save(jobId, { jobId, mutationUnitId, accessMode, sandbox, isWriter, workspaceRoot, workspaceId, threadId: null, turnId: null, state: 'created', ownershipReleased: false, createdAt: Date.now(), updatedAt: Date.now() });

    const threadParams = { ...(cwd ? { cwd } : {}), sandbox };
    const threadRes = await this.client.request('thread/start', threadParams);
    const threadId = threadRes && threadRes.thread && threadRes.thread.id;
    if (!threadId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      throw new Error('thread/start returned no thread id');
    }
    this.jobMap.update(jobId, { threadId, state: 'thread_ready', updatedAt: Date.now() });

    // Only a WRITER acquires codex ownership bound to the persisted mutationUnitId
    // BEFORE turn/start. A read_only unit never acquires (owner stays none).
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
      turnRes = await this.client.request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], ...(cwd ? { cwd } : {}) });
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

    this.jobMap.update(jobId, { turnId, state: 'running', updatedAt: Date.now() });
    return { jobId, threadId, turnId, state: 'running', accessMode, sandbox, isWriter, mutationOwner: this.owner.owner };
  }

  load(jobId) { return this.jobMap.load(jobId); }

  async get({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);

    let live = false;
    let recoveryRequired = false;
    let readErrorCode = null;
    let thread = null;
    let terminalStatus = null;
    try {
      const r = await this.client.request('thread/read', { threadId: job.threadId, includeTurns: true });
      thread = r && r.thread || null;
      live = true;
    } catch (e) {
      readErrorCode = (e && e.message ? e.message : 'read-error').slice(0, 200);
      recoveryRequired = true;
    }
    if (!this.client.isRunning) recoveryRequired = true;

    const turn = thread && Array.isArray(thread.turns) ? thread.turns.find((t) => t && t.id === job.turnId) || null : null;
    const assistantText = turn ? extractAssistantText(turn) : null;
    const pendingApprovals = pendingForJob(job, this._approvals);

    let ownershipReleased = job.ownershipReleased === true;
    if (!ownershipReleased && this.owner.owner === 'none' && turn && TERMINAL_TURN_STATES.includes(turn.status)) {
      ownershipReleased = true;
    }
    if (turn && TERMINAL_TURN_STATES.includes(turn.status)) {
      const rel = this._releaseUnitOnTerminal(job, turn.status);
      ownershipReleased = rel.ownershipReleased;
      terminalStatus = turn.status;
      if (rel.ownershipReleased) recoveryRequired = false;
    }

    // Consistent mutationUnitState: never 'released' unless ownership was actually
    // released. A read_only / never-held unit reports 'none' (no writer held).
    let mutationUnitState;
    if (ownershipReleased) mutationUnitState = 'released';
    else if (this.owner.owner === 'none') mutationUnitState = 'none';
    else mutationUnitState = this.owner.unitState;

    const nextAction = recoveryRequired ? 'codex_reconcile' : null;

    return {
      jobId,
      threadId: job.threadId,
      turnId: job.turnId,
      accessMode: job.accessMode || null,
      sandbox: job.sandbox || null,
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

  async continue({ jobId, instruction }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    if (!job.threadId) throw new Error(`job ${jobId} has no threadId`);
    if (!instruction || typeof instruction !== 'string' || !instruction.trim()) throw new Error('continue requires a non-empty instruction');

    // Continue the SAME thread; sandbox/accessMode are inherited (never escalated).
    // A read_only job creates a new mutation unit but does NOT acquire a writer.
    const mutationUnitId = makeMutationUnitId();
    const isWriter = this._isWriter(job);
    if (isWriter) this.owner.acquire('codex', mutationUnitId); // fails if the previous unit is active
    this.jobMap.update(jobId, { mutationUnitId, accessMode: job.accessMode || null, sandbox: job.sandbox || null, isWriter, ownershipReleased: false, state: 'starting', updatedAt: Date.now() });

    let turnRes;
    try {
      turnRes = await this.client.request('turn/start', { threadId: job.threadId, input: [{ type: 'text', text: instruction, text_elements: [] }] });
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

    this.jobMap.update(jobId, { turnId, state: 'running', updatedAt: Date.now() });
    return { jobId, threadId: job.threadId, turnId, state: 'running', accessMode: job.accessMode || null, sandbox: job.sandbox || null, mutationOwner: this.owner.owner };
  }

  // Public authoritative reconciliation (MCP codex_reconcile). Reconnects via
  // thread/resume + thread/read. NEVER creates a new turn or a generic force-unlock.
  // terminal -> release; inProgress -> retain writer; ambiguous -> fail closed.
  async reconcile({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    await this._ensureConnected();
    if (!job.threadId || !job.turnId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      return { jobId, reconciled: false, resolution: 'unresolved', recoveryRequired: true, reason: 'no thread/turn identity to reconcile' };
    }

    let resumed;
    try {
      resumed = await this.client.request('thread/resume', { threadId: job.threadId, ...(job.cwd ? { cwd: job.cwd } : {}) });
    } catch (e) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      return { jobId, reconciled: false, resolution: 'unresolved', recoveryRequired: true, reason: 'resume failed: ' + String(e.message || e).slice(0, 160) };
    }
    const resumedThreadId = resumed && resumed.thread && resumed.thread.id;
    if (!resumedThreadId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      return { jobId, reconciled: false, resolution: 'unresolved', recoveryRequired: true, reason: 'thread/resume returned no thread id' };
    }
    // Authoritative thread/read for the real turn state.
    let read;
    try {
      read = await this.client.request('thread/read', { threadId: job.threadId, includeTurns: true });
    } catch (e) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      return { jobId, reconciled: false, resolution: 'unresolved', recoveryRequired: true, reason: 'thread/read failed: ' + String(e.message || e).slice(0, 160) };
    }
    const thread = read && read.thread;
    const turns = thread && Array.isArray(thread.turns) ? thread.turns : [];
    const turn = turns.find((t) => t && t.id === job.turnId) || null;

    if (turn && TERMINAL_TURN_STATES.includes(turn.status)) {
      const rel = this._releaseUnitOnTerminal(job, turn.status);
      return { jobId, reconciled: true, resolution: 'terminal', state: turn.status, ownershipReleased: rel.ownershipReleased, recoveryRequired: false, mutationUnitId: job.mutationUnitId || null };
    }
    if (turn && turn.status === 'inProgress') {
      // Retain writer (a writer keeps its lock; a read_only unit holds none).
      if (this._isWriter(job)) {
        if (this.owner.owner === 'none') this.owner.acquire('codex', job.mutationUnitId || makeMutationUnitId());
        else if (this.owner.owner === 'codex') this.owner.markUnitState('running');
      }
      this.jobMap.update(jobId, { state: 'running', updatedAt: Date.now() });
      return { jobId, reconciled: true, resolution: 'in_progress', state: 'running', ownershipReleased: false, recoveryRequired: false, mutationUnitId: job.mutationUnitId || null };
    }

    // Ambiguous / unreadable / no matching turn -> fail closed.
    this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
    return { jobId, reconciled: false, resolution: 'unresolved', recoveryRequired: true, reason: 'ambiguous or unreadable turn state' };
  }

  // Official App Server recovery: initialize -> thread/resume -> thread/read.
  async resume({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    await this._ensureConnected();

    if (!job.threadId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      throw new Error(`cannot reconcile job ${jobId}: no thread identity; refusing to create a duplicate`);
    }

    let resumed;
    try {
      resumed = await this.client.request('thread/resume', { threadId: job.threadId, ...(job.cwd ? { cwd: job.cwd } : {}) });
    } catch (e) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      throw e;
    }
    const resumedThreadId = resumed && resumed.thread && resumed.thread.id;
    if (!resumedThreadId) throw new Error('thread/resume returned no thread id');

    const read = await this.client.request('thread/read', { threadId: job.threadId, includeTurns: true });
    const thread = read && read.thread;
    const turns = thread && Array.isArray(thread.turns) ? thread.turns.filter((t) => t && t.id) : [];

    const unitId = job.mutationUnitId || makeMutationUnitId();
    const isWriter = this._isWriter(job);

    let resolvedTurnId = job.turnId || null;
    if (resolvedTurnId) {
      const known = turns.find((t) => t.id === resolvedTurnId);
      if (known) {
        const state = TERMINAL_TURN_STATES.includes(known.status) ? known.status : (known.status === 'inProgress' ? 'running' : known.status);
        this.jobMap.update(jobId, { turnId: resolvedTurnId, state, updatedAt: Date.now() });
        this._reconcileOwner({ unitId, turnStatus: TERMINAL_TURN_STATES.includes(known.status) ? known.status : (known.status === 'inProgress' ? 'inProgress' : 'unknown'), isWriter });
        return this.get({ jobId });
      }
      resolvedTurnId = null;
    }

    if (!resolvedTurnId) {
      const active = turns.filter((t) => t.status === 'inProgress' || t.status === 'interrupted');
      if (active.length === 1) {
        const turnId = active[0].id;
        const state = active[0].status === 'inProgress' ? 'running' : active[0].status;
        this.jobMap.update(jobId, { turnId, state, updatedAt: Date.now() });
        this._reconcileOwner({ unitId, turnStatus: TERMINAL_TURN_STATES.includes(active[0].status) ? active[0].status : (active[0].status === 'inProgress' ? 'inProgress' : 'unknown'), isWriter });
        return this.get({ jobId });
      }
      if (active.length !== 1 || turns.length === 0) {
        this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
        throw new Error(`cannot reconcile job ${jobId}: ambiguous turn state on thread ${job.threadId}; refusing to guess`);
      }
    }

    this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
    throw new Error(`cannot reconcile job ${jobId}: ambiguous turn state; refusing to guess`);
  }

  // Bounded authoritative interrupt reconciliation.
  async _boundedReconcile(jobId, attempts = 3, delayMs = 150) {
    const job = this.jobMap.load(jobId);
    if (!job) return { jobId, reconciliation: 'unresolved', ownershipReleased: false, recoveryRequired: true };
    for (let i = 0; i < attempts; i++) {
      const turn = await this._authoritativeTurn(job);
      if (turn && TERMINAL_TURN_STATES.includes(turn.status)) {
        const rel = this._releaseUnitOnTerminal(job, turn.status);
        return {
          jobId, state: turn.status, reconciliation: 'confirmed', ownershipReleased: rel.ownershipReleased,
          recoveryRequired: false, mutationUnitId: job.mutationUnitId || null,
        };
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    this.jobMap.update(jobId, { state: 'interrupted', updatedAt: Date.now() });
    return {
      jobId, state: 'interrupted', reconciliation: 'unresolved', ownershipReleased: false,
      recoveryRequired: true, mutationUnitId: job.mutationUnitId || null,
    };
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
