// chatgpt-codex-orchestrator: durable canonical Governance runtime (Brain Continuity core).
// Wraps GovernanceService with namespace-scoped persistence + single canonical writer +
// Parent authority generation/fencing + bounded semantic re-entry + takeover.
//
// Semantics preserved from GovernanceService (never duplicated here):
//   - task/step/acceptance/evidence/executorStatus/machineGate/brainAcceptance lifecycle
//   - terminal DONE immutability + idempotent repeated DONE
//   - RESULT-bearing step is never silently re-executed
//   - ASK_USER / recovery-required conditions survive restart without fresh reset
//
// Durable semantics added here:
//   - every successful mutation persists (atomic + known-good backup) under the dataRoot
//   - restart = new DurableGovernanceService over the same dataRoot/namespace
//   - mutations on an established task require the current opaque authority token;
//     a stale/missing token after takeover is rejected as stale_authority
//   - takeover increments the authority generation and mints a new token for the new
//     Parent session; it NEVER cancels/restarts/duplicates delegated Codex execution
//     (execution reconciliation is delegated to the existing executor.recover path)
//   - bounded semantic recovery: 0 -> not_found, 1 -> unique, >1 -> ambiguous; never
//     guesses "most recent"; corruption anywhere in the namespace fails closed
//   - a Context Capsule is derived from durable structured state (no transcript dump)
//   - capability observations stay ephemeral: the capsule always requires rediscovery
//   - loss of the in-memory proof-reuse cache only forces conservative re-verification
import crypto from 'node:crypto';
import path from 'node:path';
import { GovernanceService, GovernanceError } from './index.js';
import { GovernanceStore, GovernanceStoreError, GOVERNANCE_SCHEMA_VERSION } from './store.js';
import { GovernanceWriterGuard, GovernanceWriterError } from './writer-guard.js';
import { buildContextCapsule, buildExecutionSummary } from './capsule.js';
import { createProofLedger, createDirectMetrics } from '../direct-governance.js';

export { GovernanceStoreError, GovernanceWriterError, GOVERNANCE_SCHEMA_VERSION };
export { GovernanceStore } from './store.js';
export { GovernanceWriterGuard, WRITER_STALE_MS_DEFAULT } from './writer-guard.js';

export function makeAuthorityToken() { return crypto.randomUUID(); }

function newAuthority(now) {
  return { generation: 0, token: makeAuthorityToken(), createdAt: now(), lastTakeoverAt: null };
}

export function governanceError(message, code) {
  const e = new GovernanceError(message);
  e.code = code || 'governance_error';
  return e;
}

// Deterministic bounded semantic resolution across the namespace store. Shared by
// recoverSemantic (continuation) and resolveSemantic (read-only discovery).
function scopeMatches(env, { taskId = null, projectKey = null, identity = null }) {
  if (taskId != null && env.taskId !== taskId) return false;
  if (projectKey != null && env.projectKey !== projectKey) return false;
  if (identity != null && env.identity !== identity) return false;
  return true;
}

export class DurableGovernanceService {
  constructor({ dataRoot, namespace = 'default', writerId = null, proofLedger = null, metrics = null, allowPublish = true, now = null, heartbeatMs = 5 * 60 * 1000, pidAlive = null, autoWriter = true } = {}) {
    if (!dataRoot) throw new GovernanceError('durable governance requires a dataRoot');
    const clock = now || (() => Date.now());
    this.dataRoot = path.resolve(dataRoot);
    this.namespace = String(namespace);
    this.writerId = writerId || `governance-${process.pid}-${crypto.randomUUID()}`;
    this.store = new GovernanceStore({ dataRoot: this.dataRoot, namespace: this.namespace });
    this.guard = new GovernanceWriterGuard({ dataRoot: this.dataRoot, namespace: this.namespace, writerId: this.writerId, staleMs: heartbeatMs, now: clock, pidAlive: pidAlive || null });
    this.svc = new GovernanceService({
      proofLedger: proofLedger || createProofLedger(),
      metrics: metrics || createDirectMetrics(),
      allowPublish,
    });
    this._clock = clock;
    this._meta = null; // { taskId, projectKey, identity, authority }
    this._closed = false;
    if (autoWriter) this.guard.acquire();
  }

  get durable() { return true; }
  get taskId() { return this.svc.state.taskId; }
  get proofLedger() { return this.svc.proofLedger; }

  close() {
    if (!this._closed) {
      try { this.guard.release(); } catch {}
      this._closed = true;
    }
  }

  _ensureOpen() {
    if (this._closed) throw new GovernanceError('durable governance runtime is closed');
  }

  // Hydrate the in-memory GovernanceService from the durable envelope for a task.
  _hydrateTask(taskId) {
    const env = this.store.loadTask(taskId);
    this.svc.state = structuredClone(env.state);
    this._meta = {
      taskId: env.taskId,
      projectKey: env.projectKey ?? null,
      identity: env.identity ?? null,
      authority: env.authority && typeof env.authority === 'object' ? { ...env.authority } : null,
    };
    return env;
  }

  _metaFor(activeTaskId, normalized) {
    let meta = this._meta;
    if (meta && meta.taskId === activeTaskId) {
      if (normalized.projectKey != null && meta.projectKey == null) meta.projectKey = normalized.projectKey;
      if (normalized.identity != null && meta.identity == null) meta.identity = normalized.identity;
      return meta;
    }
    if (this.store.hasTask(activeTaskId)) {
      const env = this.store.loadTask(activeTaskId);
      return {
        taskId: env.taskId,
        projectKey: env.projectKey ?? null,
        identity: env.identity ?? null,
        authority: env.authority && typeof env.authority === 'object' ? { ...env.authority } : null,
      };
    }
    return {
      taskId: activeTaskId,
      projectKey: normalized.projectKey ?? null,
      identity: normalized.identity ?? null,
      authority: null,
    };
  }

  _persist(taskId, meta) {
    this.store.saveTask(taskId, {
      state: this.svc.state,
      projectKey: meta ? meta.projectKey : null,
      identity: meta ? meta.identity : null,
      authority: meta && meta.authority ? { ...meta.authority } : null,
    });
    try { this.guard.refresh(); } catch {}
  }

  _authorityPublic(meta) {
    if (!meta) return null;
    return {
      taskId: meta.taskId,
      projectKey: meta.projectKey ?? null,
      identity: meta.identity ?? null,
      generation: meta.authority && typeof meta.authority.generation === 'number' ? meta.authority.generation : 0,
    };
  }

  // Fencing: once a task has an authority token, every mutation must present the
  // current token. A stale/missing token is stale_authority (fail closed).
  _checkAuthority(args) {
    const meta = this._meta;
    if (!meta) return;
    if (!meta.authority || meta.authority.token == null) {
      throw governanceError(
        `stale_authority: task ${meta.taskId} has no active authority token; perform a bounded takeover before mutating`,
        'stale_authority',
      );
    }
    const presented = args.authorityToken ?? null;
    if (presented !== meta.authority.token) {
      throw governanceError(
        `stale_authority: task ${meta.taskId} authority generation ${meta.authority.generation} is fenced; present the current authority token or perform a bounded takeover`,
        'stale_authority',
      );
    }
  }

  // Is this transition starting a genuinely NEW task (fresh authority, no token yet)?
  _isFreshTaskStart(args) {
    if (!args.taskId) return false;
    if (this.store.hasTask(args.taskId)) return false;
    const activeTaskId = this.svc.state.taskId;
    if (activeTaskId == null) return true;
    // A sequential new task after a terminal DONE at a PLAN boundary.
    return this.svc.state.control === 'DONE' && args.control === 'PLAN';
  }

  transition(args = {}) {
    this._ensureOpen();
    const normalized = { ...args };
    // Restart continuation: no active task in memory, but the requested taskId already
    // exists durably -> hydrate it before applying the control.
    if (this.svc.state.taskId == null && normalized.taskId != null && this.store.hasTask(normalized.taskId)) {
      this._hydrateTask(normalized.taskId);
    }
    const freshStart = this._isFreshTaskStart(normalized);
    if (!freshStart) this._checkAuthority(normalized);
    const result = this.svc.transition(normalized);
    const activeTaskId = this.svc.state.taskId;
    if (!activeTaskId) return result;
    const meta = this._metaFor(activeTaskId, normalized);
    const minted = !meta.authority || meta.authority.token == null;
    if (minted) meta.authority = newAuthority(this._clock);
    this._meta = meta;
    this._persist(activeTaskId, meta);
    const out = { ...result, durable: true, authority: this._authorityPublic(meta) };
    if (minted) out.authorityToken = meta.authority.token;
    return out;
  }

  recordResult(args = {}) {
    this._ensureOpen();
    const normalized = { ...args };
    if (this.svc.state.taskId == null && normalized.taskId != null && this.store.hasTask(normalized.taskId)) {
      this._hydrateTask(normalized.taskId);
    }
    this._checkAuthority(normalized);
    const result = this.svc.recordResult(normalized);
    const activeTaskId = this.svc.state.taskId;
    if (!activeTaskId) return result;
    const meta = this._meta || { taskId: activeTaskId, projectKey: null, identity: null, authority: null };
    this._meta = meta;
    this._persist(activeTaskId, meta);
    return { ...result, durable: true, authority: this._authorityPublic(meta) };
  }

  status() {
    const base = this.svc.status();
    return {
      ...base,
      durable: true,
      namespace: this.namespace,
      schemaVersion: GOVERNANCE_SCHEMA_VERSION,
      authority: this._authorityPublic(this._meta),
    };
  }

  // Read-only bounded semantic recovery discovery: 0 -> not_found, 1 -> unique
  // (returns the single in-progress task), >1 -> ambiguous. Corruption fails closed.
  recoverSemantic({ taskId = null, projectKey = null, identity = null } = {}) {
    this._ensureOpen();
    if (taskId == null && projectKey == null && identity == null) {
      return { ok: false, error: 'bad_request', reason: 'semantic recovery requires taskId and/or projectKey and/or identity' };
    }
    const scan = this.store.scanStrict();
    if (scan.corruptCount > 0) {
      return { ok: false, error: 'corrupt', corruptCount: scan.corruptCount, reason: `${scan.corruptCount} durable governance task file(s) are unreadable; refusing to infer absence` };
    }
    const matches = scan.tasks.filter((e) => scopeMatches(e, { taskId, projectKey, identity }));
    const active = matches.filter((e) => !e.state || e.state.control !== 'DONE');
    if (active.length === 0) {
      return { ok: false, error: 'not_found', reason: matches.length ? 'only terminal DONE governance task(s) match this scope; no in-progress task to recover' : 'no governance task matches the semantic scope', terminalMatches: matches.length };
    }
    if (active.length > 1) {
      return { ok: false, error: 'ambiguous', matchCount: active.length, reason: `${active.length} in-progress governance tasks match this scope; refine semantic scope (no most-recent guessing)` };
    }
    const env = active[0];
    return { ok: true, taskId: env.taskId, projectKey: env.projectKey, identity: env.identity, control: env.state ? env.state.control : null };
  }

  // Read-only resolution that also surfaces a unique terminal DONE task (status only).
  resolveSemantic({ taskId = null, projectKey = null, identity = null } = {}) {
    this._ensureOpen();
    if (taskId == null && projectKey == null && identity == null) {
      return { ok: false, error: 'bad_request', reason: 'semantic recovery requires taskId and/or projectKey and/or identity' };
    }
    const scan = this.store.scanStrict();
    if (scan.corruptCount > 0) {
      return { ok: false, error: 'corrupt', corruptCount: scan.corruptCount, reason: `${scan.corruptCount} durable governance task file(s) are unreadable; refusing to infer absence` };
    }
    const matches = scan.tasks.filter((e) => scopeMatches(e, { taskId, projectKey, identity }));
    if (matches.length === 0) return { ok: false, error: 'not_found', reason: 'no governance task matches the semantic scope' };
    if (matches.length > 1) {
      return { ok: false, error: 'ambiguous', matchCount: matches.length, reason: `${matches.length} governance tasks match this scope; refine semantic scope (no most-recent guessing)` };
    }
    const env = matches[0];
    const terminal = !!(env.state && env.state.control === 'DONE');
    return { ok: true, taskId: env.taskId, projectKey: env.projectKey, identity: env.identity, control: env.state ? env.state.control : null, terminal };
  }

  // Exact load for restart restoration (restores authoritative state for a known task,
  // including a terminal DONE task whose immutability must survive restart).
  loadTask(taskId) {
    this._ensureOpen();
    if (!taskId) throw governanceError('loadTask requires a taskId', 'bad_request');
    const env = this._hydrateTask(taskId);
    return {
      ok: true,
      taskId: env.taskId,
      projectKey: env.projectKey ?? null,
      identity: env.identity ?? null,
      control: env.state ? env.state.control : null,
      terminal: !!(env.state && env.state.control === 'DONE'),
      authority: this._authorityPublic(this._meta),
    };
  }

  // Bounded Parent takeover: resolve the single task, increment the durable authority
  // generation, and mint a new opaque fencing token for the new Parent session. A
  // takeover attempted with a stale (non-current) token is rejected as stale_authority.
  // Takeover NEVER touches delegated execution; reconcile that through the executor.
  takeover({ taskId = null, projectKey = null, identity = null, authorityToken = null } = {}) {
    this._ensureOpen();
    const rec = this.resolveSemantic({ taskId, projectKey, identity });
    if (!rec.ok) throw governanceError(`${rec.error}: ${rec.reason}`, rec.error);
    const env = this.store.loadTask(rec.taskId);
    const current = env.authority && env.authority.token ? env.authority : null;
    if (current && authorityToken != null && authorityToken !== current.token) {
      throw governanceError(`stale_authority: cannot take over task ${env.taskId} with a stale authority token (current generation ${current.generation})`, 'stale_authority');
    }
    const generation = (env.authority && typeof env.authority.generation === 'number' ? env.authority.generation : 0) + 1;
    const authority = {
      generation,
      token: makeAuthorityToken(),
      createdAt: env.authority && env.authority.createdAt ? env.authority.createdAt : this._clock(),
      lastTakeoverAt: this._clock(),
    };
    this.svc.state = structuredClone(env.state);
    this._meta = {
      taskId: env.taskId,
      projectKey: env.projectKey ?? null,
      identity: env.identity ?? null,
      authority,
    };
    this._persist(env.taskId, this._meta);
    const execution = buildExecutionSummary(this.svc.state, { taskId: env.taskId, identity: this._meta.identity });
    const capsule = this.capsule({ execution });
    return {
      ok: true,
      taskId: env.taskId,
      authority: { generation: authority.generation, token: authority.token },
      capsule,
      execution,
    };
  }

  capsule({ execution = null } = {}) {
    return buildContextCapsule(this.svc.state, {
      taskId: this.svc.state.taskId,
      projectKey: this._meta ? this._meta.projectKey : null,
      identity: this._meta ? this._meta.identity : null,
      authority: this._meta ? this._meta.authority : null,
      execution,
    });
  }
}

export function createDurableGovernanceService(opts) { return new DurableGovernanceService(opts); }

// Takeover orchestration used by the MCP/runtime boundary. After the durable
// governance takeover, a still-valid delegated Codex execution is reconciled through
// the EXISTING bounded recover path (never start/continue/interrupt/duplicate). A
// reconcile failure surfaces as execution.reconciled=false (recovery-required), not as
// a cancelled or restarted execution.
export async function reconcileDelegatedExecution({ executor = null, workspaceId = null, workspaceRoot = null, binding = null } = {}) {
  if (!executor || typeof executor.recover !== 'function') {
    return { attempted: false, reason: 'no reconciling executor available' };
  }
  const b = binding || {};
  if (!b.identity && !b.taskId && !b.stepId) {
    return { attempted: false, reason: 'no semantic execution binding to reconcile' };
  }
  const result = await executor.recover({ workspaceId: workspaceId || null, workspaceRoot: workspaceRoot || null, taskId: b.taskId ?? null, stepId: b.stepId ?? null, identity: b.identity ?? null });
  return { attempted: true, reconciled: true, action: 'recover', result };
}

export async function performContinuityTakeover({ service, executor = null, workspaceId = null, workspaceRoot = null, scope = {} }) {
  if (!service || typeof service.takeover !== 'function') throw governanceError('continuity takeover requires a durable governance service', 'bad_request');
  const takeoverResult = service.takeover(scope);
  let execution = { attempted: false, ...takeoverResult.execution };
  if (executor && takeoverResult.execution && takeoverResult.execution.binding) {
    try {
      const rec = await reconcileDelegatedExecution({ executor, workspaceId, workspaceRoot, binding: takeoverResult.execution.binding });
      execution = { ...execution, ...rec };
    } catch (e) {
      execution = {
        ...execution,
        attempted: true,
        reconciled: false,
        action: 'recover',
        error: e && typeof e.toJSON === 'function' ? e.toJSON() : { name: e && e.name, message: e && e.message },
      };
    }
  }
  return { ...takeoverResult, execution };
}
