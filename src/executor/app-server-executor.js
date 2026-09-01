// chatgpt-codex-orchestrator: AppServerExecutor (v0.2 M1).
// Productionized wrapper over AppServerClient + JobMap + MutationOwner + approval.
// Exposes a thin, stable MCP-facing facade: start / get / continue / interrupt /
// respondApproval / resume / shutdown. It does NOT expose raw App Server protocol.
//
// Ownership: a mutating unit acquires `codex` ownership BEFORE any mutating
// turn/start. It is released only after the unit reaches a reconciled terminal
// state. Interrupted / unknown state blocks silent release.

import { AppServerClient } from './app-server-client.js';
import { JobMap, makeJobId } from './job-map.js';
import { MutationOwner, MutationOwnerError } from '../state/mutation-owner.js';
import { normalizeApproval, mapDecision, APPROVAL_DECISIONS, ApprovalError } from './approval.js';

const TERMINAL_TURN_STATES = ['completed', 'failed'];

export class AppServerExecutor {
  constructor({ dataRoot = null, codexBin = null, listen = null, cwd = null, client = null, jobMap = null } = {}) {
    this.client = client || new AppServerClient({ codexBin: codexBin || undefined, listen: listen || undefined, cwd: cwd || undefined });
    this.jobMap = jobMap || new JobMap({ dataRoot });
    this.owner = new MutationOwner();
    this._approvals = new Map();      // approvalId -> { requestId, info, resolved }
    this._notifiers = new Set();
    this._setup();
  }

  _setup() {
    this.client.onNotification((note) => this._handleNotification(note));
    this.client.onServerRequest((req) => this._handleServerRequest(req));
  }

  onEvent(handler) { this._notifiers.add(handler); return () => this._notifiers.delete(handler); }
  _emit(event) { for (const h of this._notifiers) { try { h(event); } catch {} } }

  _handleNotification(note) {
    const method = note && note.method;
    if (method === 'turn/started' || method === 'turn/completed') {
      const params = note.params || {};
      const threadId = params.threadId;
      const turn = params.turn || {};
      const job = this.jobMap.findByThread(threadId);
      const state = turn.status || (method === 'turn/completed' ? 'completed' : 'running');
      if (job) this.jobMap.update(job.jobId, { state, turnId: turn.id || job.turnId, updatedAt: Date.now() });
    }
    this._emit(note);
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

    // 1) provisional job entry BEFORE starting any turn (reconciliation anchor).
    const jobId = makeJobId();
    this.jobMap.save(jobId, { jobId, threadId: null, turnId: null, state: 'created', createdAt: Date.now(), updatedAt: Date.now() });

    // 2) thread/start may establish the thread.
    const threadParams = { ...(cwd ? { cwd } : {}), ...(sandbox ? { sandbox } : {}) };
    const threadRes = await this.client.request('thread/start', threadParams);
    const threadId = threadRes && threadRes.thread && threadRes.thread.id;
    if (!threadId) {
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      throw new Error('thread/start returned no thread id');
    }

    // 3) persist threadId immediately when known.
    this.jobMap.update(jobId, { threadId, state: 'thread_ready', updatedAt: Date.now() });

    // 4) acquire codex mutation ownership BEFORE any mutating turn/start.
    try {
      this.owner.acquire('codex');
    } catch (e) {
      // Ow[n]ership failed: no mutating turn may have started.
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      throw e;
    }

    // 5) record state before the mutating turn.
    this.jobMap.update(jobId, { state: 'starting', updatedAt: Date.now() });

    // 6) turn/start (the mutating turn).
    let turnRes;
    try {
      turnRes = await this.client.request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], ...(cwd ? { cwd } : {}) });
    } catch (e) {
      // Outcome uncertain/failed after ownership acquired: do NOT silently release.
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

    // 7) persist turnId immediately when known; only then acknowledge start.
    this.jobMap.update(jobId, { turnId, state: 'running', updatedAt: Date.now() });
    return { jobId, threadId, turnId, state: 'running' };
  }

  load(jobId) { return this.jobMap.load(jobId); }

  async get({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    let thread = null;
    try {
      const r = await this.client.request('thread/read', { threadId: job.threadId, includeTurns: true });
      thread = r && r.thread || null;
    } catch { /* read unavailable; fall back to mapping state */ }
    const turn = thread && Array.isArray(thread.turns) ? thread.turns.find((t) => t && t.id === job.turnId) || null : null;
    return {
      jobId,
      threadId: job.threadId,
      turnId: job.turnId,
      state: job.state,
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

    // MUST acquire codex ownership before turn/start (owner=none must acquire).
    this.owner.acquire('codex');
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

  // Reconciliation guard: after a lost local response, attach to an EXISTING
  // thread/turn identity rather than creating a duplicate turn. Never issues a
  // blanket turn/start just because the local acknowledgement was lost.
  async resume({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    await this._ensureConnected();

    if (job.threadId && job.turnId) {
      // Known thread + turn: thread/read and attach to that turn.
      const state = await this.get({ jobId });
      this.owner.acquire('codex');
      return state;
    }

    if (job.threadId && !job.turnId) {
      // Thread exists, turn unknown: inspect thread/read and reconcile ONLY when an
      // existing turn can be identified safely. Never blindly start a new one.
      const r = await this.client.request('thread/read', { threadId: job.threadId, includeTurns: true });
      const thread = r && r.thread;
      const turns = thread && Array.isArray(thread.turns) ? thread.turns.filter((t) => t && t.id) : [];
      const active = turns.filter((t) => t.status === 'inProgress' || t.status === 'interrupted');
      if (active.length === 1) {
        const turnId = active[0].id;
        this.jobMap.update(jobId, { turnId, state: active[0].status === 'inProgress' ? 'running' : active[0].status, updatedAt: Date.now() });
        this.owner.acquire('codex');
        return this.get({ jobId });
      }
      // Ambiguous: fail closed rather than guessing.
      this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
      throw new Error(`cannot reconcile job ${jobId}: ambiguous turn state on thread ${job.threadId}; refusing to guess`);
    }

    // No thread at all: nothing to reconcile without a thread.
    this.jobMap.update(jobId, { state: 'recovery_required', updatedAt: Date.now() });
    throw new Error(`cannot reconcile job ${jobId}: no thread identity; refusing to create a duplicate`);
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
    // Bind approval to the correct job/thread/turn.
    if (info.threadId && info.threadId !== job.threadId) {
      throw new ApprovalError(`approval ${approvalId} does not belong to job ${jobId} (thread mismatch)`);
    }
    if (info.turnId && job.turnId && info.turnId !== job.turnId) {
      throw new ApprovalError(`approval ${approvalId} does not belong to job ${jobId} (turn mismatch)`);
    }

    // Map orchestrator-approved decision to the exact method-specific wire response.
    const result = mapDecision({ method: info.method, decision });
    this.client.respondRequest(pending.requestId, result);
    pending.resolved = true;
    this._approvals.delete(key);
    return { jobId, approvalId, decision, method: info.method, ok: true };
  }

  // Release ownership after the unit reaches reconciled terminal state.
  release({ force = false } = {}) { return this.owner.release({ force }); }
  markUnitState(state) { return this.owner.markUnitState(state); }

  async shutdown() { await this.client.close(); }
}

export { TERMINAL_TURN_STATES };
