// chatgpt-codex-orchestrator: AppServerExecutor (v0.2 M1).
// Productionized wrapper over AppServerClient + JobMap + MutationOwner + approval.
// Exposes a thin, stable MCP-facing facade: start / get / continue / interrupt /
// respondApproval / resume / shutdown. It does NOT expose raw App Server protocol.
//
// Ownership: a mutating unit (start/continue) acquires `codex` ownership. It is
// released only after the unit reaches a reconciled terminal state. Interrupted /
// unknown state blocks silent release.

import { AppServerClient } from './app-server-client.js';
import { JobMap, makeJobId } from './job-map.js';
import { MutationOwner } from '../state/mutation-owner.js';
import { normalizeApproval, buildApprovalResponse, APPROVAL_DECISIONS, ApprovalError } from './approval.js';

const TERMINAL_TURN_STATES = ['completed', 'failed', 'interrupted'];

export class AppServerExecutor {
  constructor({ dataRoot = null, codexBin = null, listen = null, cwd = null, client = null, jobMap = null } = {}) {
    this.client = client || new AppServerClient({ codexBin: codexBin || undefined, listen: listen || undefined, cwd: cwd || undefined });
    this.jobMap = jobMap || new JobMap({ dataRoot });
    this.owner = new MutationOwner();
    this._approvals = new Map();      // approvalId -> { requestId, info }
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
    const threadParams = { ...(cwd ? { cwd } : {}), ...(sandbox ? { sandbox } : {}) };
    const threadRes = await this.client.request('thread/start', threadParams);
    const threadId = threadRes && threadRes.thread && threadRes.thread.id;
    if (!threadId) throw new Error('thread/start returned no thread id');

    const turnParams = { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], ...(cwd ? { cwd } : {}) };
    const turnRes = await this.client.request('turn/start', turnParams);
    const turnId = turnRes && turnRes.turn && turnRes.turn.id;
    if (!turnId) throw new Error('turn/start returned no turn id');

    const jobId = makeJobId();
    // Persist mapping BEFORE acknowledging start to the caller.
    this.jobMap.save(jobId, { jobId, threadId, turnId, state: 'running', createdAt: Date.now(), updatedAt: Date.now() });
    this.owner.acquire('codex');

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
    this.owner.assertCanWrite('codex');
    const turnRes = await this.client.request('turn/start', { threadId: job.threadId, input: [{ type: 'text', text: instruction, text_elements: [] }] });
    const turnId = turnRes && turnRes.turn && turnRes.turn.id;
    if (!turnId) throw new Error('turn/start returned no turn id');
    return this.jobMap.update(jobId, { turnId, state: 'running', updatedAt: Date.now() });
  }

  // Reconciliation guard: after a lost local response, attach to the existing
  // thread/turn identity rather than creating a duplicate turn. Never calls
  // turn/start again when a job already has a resolved thread/turn.
  async resume({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    await this._ensureConnected();
    const state = await this.get({ jobId });
    this.owner.acquire('codex');
    return state;
  }

  async interrupt({ jobId }) {
    const job = this.jobMap.load(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    if (!job.threadId || !job.turnId) throw new Error(`job ${jobId} has no turn to interrupt`);
    await this.client.request('turn/interrupt', { threadId: job.threadId, turnId: job.turnId });
    return { jobId, state: 'interrupted' };
  }

  async respondApproval({ jobId = null, approvalId, decision }) {
    if (!APPROVAL_DECISIONS.includes(decision)) throw new ApprovalError(`invalid decision: ${decision}`);
    const key = String(approvalId);
    const pending = this._approvals.get(key);
    if (!pending || pending.resolved) throw new ApprovalError(`unknown or stale approval id: ${approvalId}`);
    const result = buildApprovalResponse({ decision, approval: pending.info });
    this.client.respondRequest(pending.requestId, result);
    pending.resolved = true;
    this._approvals.delete(key);
    return { jobId, approvalId, decision, ok: true };
  }

  // Release ownership after the unit reaches reconciled terminal state.
  release({ force = false } = {}) { return this.owner.release({ force }); }
  markUnitState(state) { return this.owner.markUnitState(state); }

  async shutdown() { await this.client.close(); }
}

export { TERMINAL_TURN_STATES };
