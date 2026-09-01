// chatgpt-codex-orchestrator: AppServerExecutor (v0.2 M1).
// Productionized wrapper over AppServerClient + JobMap + MutationOwner + approval.
// Exposes a thin, stable MCP-facing facade: start / get / continue / interrupt /
// respondApproval / resume / shutdown. It does NOT expose raw App Server protocol.
//
// Ownership: a mutating unit acquires `codex` ownership bound to a unitId BEFORE
// any mutating turn/start. Only one unit may be active per workspace; a new unit
// may begin only after the previous unit is reconciled / released. Interrupted /
// unknown state blocks silent release.
//
// Recovery: after a process death, active jobs are marked recovery_required and
// the owner unit becomes unknown; resume() uses thread/resume + thread/read to
// reattach by identity and NEVER silently creates a duplicate thread/turn.

import { AppServerClient } from './app-server-client.js';
import { JobMap, makeJobId } from './job-map.js';
import { MutationOwner, MutationOwnerError } from '../state/mutation-owner.js';
import { normalizeApproval, mapDecision, APPROVAL_DECISIONS, ApprovalError } from './approval.js';

const TERMINAL_TURN_STATES = ['completed', 'failed'];
const RECOVERY_STATES = ['created', 'thread_ready', 'starting', 'running'];

export class AppServerExecutor {
  constructor({ dataRoot = null, codexBin = null, listen = null, cwd = null, client = null, jobMap = null } = {}) {
    this.client = client || new AppServerClient({ codexBin: codexBin || undefined, listen: listen || undefined, cwd: cwd || undefined });
    this.jobMap = jobMap || new JobMap({ dataRoot });
    this.owner = new MutationOwner();
    this._approvals = new Map();      // approvalId -> { requestId, info, resolved }
    this._notifiers = new Set();
    this._unitCounter = 0;
    this._setup();
  }

  _nextUnitId() { return `${Date.now()}-${++this._unitCounter}`; }

  _setup() {
    this.client.onNotification((note) => this._handleNotification(note));
    this.client.onServerRequest((req) => this._handleServerRequest(req));
    this.client.onExit((evt) => this._handleClientExit(evt));
  }

  onEvent(handler) { this._notifiers.add(handler); return () => this._notifiers.delete(handler); }
  _emit(event) { for (const h of this._notifiers) { try { h(event); } catch {} } }

  _handleClientExit(evt) {
    if (this.client._closing) return; // clean shutdown, not an unexpected death
    // Unexpected App Server death while active work exists.
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
    if (method === 'turn/started' || method === 'turn/completed') {
      const params = note.params || {};
      const threadId = params.threadId;
      const turn = params.turn || {};
      const job = this.jobMap.findByThread(threadId);
      const state = turn.status || (method === 'turn/completed' ? 'completed' : 'running');
      if (job) this.jobMap.update(job.jobId, { state, turnId: turn.id || job.turnId, updatedAt: Date.now() });
      // Update owner unit toward reconciled terminal state (do not auto-release).
      if (TERMINAL_TURN_STATES.includes(turn.status)) this.owner.markUnitState('reconciled');
      else if (turn.status === 'interrupted') this.owner.markUnitState('interrupted');
    }
    this._emit(note);
  }

  _markReconciled(turnStatus) {
    if (TERMINAL_TURN_STATES.includes(turnStatus)) this.owner.markUnitState('reconciled');
    else if (turnStatus === 'interrupted') this.owner.markUnitState('interrupted');
    else this.owner.markUnitState('running');
  }

  _handleServerRequest(req) {
    const approval = normalizeApproval(req);
    if (approval) {
      this._approvals.set(approval.approvalId, { requestId: req.id, info: approval, resolved: false });
    }
  }

  async _ensureConnected() {
    if (!this.client.isRunning) await this.client.connect();
    else if (!this.client._connected) await this.client.connect();
  }

  async start({ prompt, cwd = null, sandbox = null } = {}) {
    await this._ensureConnected();

    const jobId = makeJobId();
    this.jobMap.save(jobId, { jobId, threadId: null, turnId: null, state: 'created', createdAt: Date.now(), updatedAt: Date.now() });

    const threadParams = { ...(cwd ? { cwd } : {}), ...(sandbox ? { sandbox } : {}) };
    const threadRes = await this.client.request('thread/start', threadParams);
    const threadId = threadRes && threadRes.thread && threadRes.thread.id;
    if (!threadId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      throw new Error('thread/start returned no thread id');
    }
    this.jobMap.update(jobId, { threadId, state: 'thread_ready', updatedAt: Date.now() });

    // Acquire codex mutation ownership bound to this unit BEFORE turn/start.
    const unitId = this._nextUnitId();
    try {
      this.owner.acquire('codex', unitId);
    } catch (e) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      throw e;
    }

    this.jobMap.update(jobId, { state: 'starting', updatedAt: Date.now() });

    let turnRes;
    try {
      turnRes = await this.client.request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], ...(cwd ? { cwd } : {}) });
    } catch (e) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      this.owner.markUnitState('unknown');
      throw e;
    }
    const turnId = turnRes && turnRes.turn && turnRes.turn.id;
    if (!turnId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      this.owner.markUnitState('unknown');
      throw new Error('turn/start returned no turn id');
    }

    this.jobMap.update(jobId, { turnId, state: 'running', updatedAt: Date.now() });
    return { jobId, threadId, turnId, state: 'running' };
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

    const turn = thread && Array.isArray(thread.turns) ? thread.turns.find((t) => t && t.id === job.turnId) || null : null;
    return {
      jobId,
      threadId: job.threadId,
      turnId: job.turnId,
      state: job.state,
      live,
      recoveryRequired,
      readErrorCode,
      threadStatus: thread ? thread.status : null,
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

    // Acquire codex ownership for a NEW mutation unit; fails if the previous unit
    // is still an unresolved active unit.
    const unitId = this._nextUnitId();
    this.owner.acquire('codex', unitId);
    this.jobMap.update(jobId, { state: 'starting', updatedAt: Date.now() });

    let turnRes;
    try {
      turnRes = await this.client.request('turn/start', { threadId: job.threadId, input: [{ type: 'text', text: instruction, text_elements: [] }] });
    } catch (e) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      this.owner.markUnitState('unknown');
      throw e;
    }
    const turnId = turnRes && turnRes.turn && turnRes.turn.id;
    if (!turnId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      this.owner.markUnitState('unknown');
      throw new Error('turn/start returned no turn id');
    }
    return this.jobMap.update(jobId, { turnId, state: 'running', updatedAt: Date.now() });
  }

  // Official App Server recovery: initialize -> thread/resume -> thread/read
  // -> reconcile persisted job state. Never blindly issues thread/start or an
  // extra turn/start.
  async resume({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    await this._ensureConnected();

    if (!job.threadId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      throw new Error(`cannot reconcile job ${jobId}: no thread identity; refusing to create a duplicate`);
    }

    // thread/resume reopens the existing thread (official recovery).
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

    let resolvedTurnId = job.turnId || null;
    if (resolvedTurnId) {
      const known = turns.find((t) => t.id === resolvedTurnId);
      if (known) {
        const state = TERMINAL_TURN_STATES.includes(known.status) ? known.status : (known.status === 'inProgress' ? 'running' : known.status);
        this.jobMap.update(jobId, { turnId: resolvedTurnId, state, updatedAt: Date.now() });
        this._markReconciled(known.status);
        return this.get({ jobId });
      }
      // persisted turnId not found in the resumed thread -> fall through to reconcile
      resolvedTurnId = null;
    }

    if (!resolvedTurnId) {
      const active = turns.filter((t) => t.status === 'inProgress' || t.status === 'interrupted');
      if (active.length === 1) {
        const turnId = active[0].id;
        const state = active[0].status === 'inProgress' ? 'running' : active[0].status;
        this.jobMap.update(jobId, { turnId, state, updatedAt: Date.now() });
        this._markReconciled(active[0].status);
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

  async interrupt({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    if (!job.threadId || !job.turnId) throw new Error(`job ${jobId} has no turn to interrupt`);
    await this.client.request('turn/interrupt', { threadId: job.threadId, turnId: job.turnId });
    this.jobMap.update(jobId, { state: 'interrupted', updatedAt: Date.now() });
    return { jobId, state: 'interrupted' };
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

export { TERMINAL_TURN_STATES };
