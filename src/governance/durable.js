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
//   - mutations on an established task require the current opaque Parent authority token,
//     except for the narrower Issue #34 execution-continuation claim described below
//   - bounded execution claims are independently fenced and authorize only the already-
//     approved current CHATGPT_DIRECT_LOCAL step; they never confer Parent control authority
//   - takeover increments the Parent authority generation and mints a new token for the new
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
import { GovernanceStore, GovernanceStoreError, GOVERNANCE_SCHEMA_VERSION, encodeGovernanceComponent } from './store.js';
import { GovernanceWriterGuard, GovernanceWriterError } from './writer-guard.js';
import { buildContextCapsule, buildExecutionSummary } from './capsule.js';
import { createProofLedger, createDirectMetrics } from '../direct-governance.js';

export { GovernanceStoreError, GovernanceWriterError, GOVERNANCE_SCHEMA_VERSION };
export { GovernanceStore } from './store.js';
export { GovernanceWriterGuard, WRITER_STALE_MS_DEFAULT } from './writer-guard.js';

export function makeAuthorityToken() { return crypto.randomUUID(); }

function newAuthority(now) {
  return { generation: 0, token: makeAuthorityToken(), createdAt: now(), lastTakeoverAt: null, executionClaim: null };
}

function executionClaimGeneration(authority) {
  const claim = authority && authority.executionClaim;
  return claim && Number.isInteger(claim.generation) && claim.generation >= 0 ? claim.generation : 0;
}

function fenceExecutionClaimValue(authority, now) {
  const claim = authority && authority.executionClaim;
  if (!claim) return null;
  if (claim.token == null) return { ...claim, token: null };
  return {
    generation: executionClaimGeneration(authority) + 1,
    token: null,
    taskId: claim.taskId ?? null,
    stepId: claim.stepId ?? null,
    workspaceRoot: claim.workspaceRoot ?? null,
    parentGeneration: claim.parentGeneration ?? null,
    claimedAt: claim.claimedAt ?? null,
    fencedAt: now(),
  };
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

// Canonical workspace-root helpers for task-scoped mutation authorization. The stored
// root is the resolved absolute path; comparisons are case-insensitive on Windows and
// ignore trailing separators so a refreshed workspaceId for the SAME canonical root is
// always recognized (no process-local workspaceId persistence).
function canonicalWorkspaceRoot(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw governanceError('workspaceRoot must be a path string', 'bad_request');
  return path.resolve(String(value));
}
function eqRoots(a, b) {
  if (!a || !b) return false;
  const x = path.resolve(String(a).replace(/[\\/]+$/, ''));
  const y = path.resolve(String(b).replace(/[\\/]+$/, ''));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export class DurableGovernanceService {
  constructor({ dataRoot, namespace = 'default', writerId = null, proofLedger = null, metrics = null, allowPublish = true, now = null, heartbeatMs = 5 * 60 * 1000, pidAlive = null, autoWriter = true, store = null } = {}) {
    if (!dataRoot) throw new GovernanceError('durable governance requires a dataRoot');
    const clock = now || (() => Date.now());
    this.dataRoot = path.resolve(dataRoot);
    this.namespace = String(namespace);
    this.writerId = writerId || `governance-${process.pid}-${crypto.randomUUID()}`;
    // store may be injected (same dataRoot/namespace) for deterministic failure tests.
    this.store = store || new GovernanceStore({ dataRoot: this.dataRoot, namespace: this.namespace });
    this.guard = new GovernanceWriterGuard({ dataRoot: this.dataRoot, namespace: this.namespace, writerId: this.writerId, staleMs: heartbeatMs, now: clock, pidAlive: pidAlive || null });
    this.svc = new GovernanceService({
      proofLedger: proofLedger || createProofLedger(),
      metrics: metrics || createDirectMetrics(),
      allowPublish,
    });
    this._clock = clock;
    this._meta = null; // { taskId, projectKey, identity, authority, workspaceRoot }
    this._closed = false;
    this._recoveryRequired = false; // set when a persistence failure left no known committed snapshot in memory
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

  // After a persistence failure that could not be rolled back to a committed
  // snapshot, the runtime is fail-closed until the committed snapshot is reloaded.
  _ensureRecoverable() {
    if (this._recoveryRequired) {
      throw governanceError('durable governance is in a recovery-required state after a persistence failure; reload the committed snapshot (loadTask) before mutating', 'recovery_required');
    }
  }

  // Restore in-memory state to the last committed durable snapshot after a failed
  // write, so status() never presents an uncommitted transition as canonical truth.
  _restoreCommitted(taskId) {
    try {
      const env = this.store.loadTask(taskId);
      this.svc.state = structuredClone(env.state);
      this._meta = {
        taskId: env.taskId,
        projectKey: env.projectKey ?? null,
        identity: env.identity ?? null,
        workspaceRoot: env.workspaceRoot ?? null,
        authority: env.authority && typeof env.authority === 'object' ? structuredClone(env.authority) : null,
      };
      this._recoveryRequired = false;
    } catch {
      // The committed snapshot itself is unreadable: fail closed (do not present the
      // uncommitted in-memory state as canonical).
      this._recoveryRequired = true;
    }
  }

  // Hydrate the in-memory GovernanceService from the durable envelope for a task.
  _hydrateTask(taskId) {
    const env = this.store.loadTask(taskId);
    this.svc.state = structuredClone(env.state);
    this._meta = {
      taskId: env.taskId,
      projectKey: env.projectKey ?? null,
      identity: env.identity ?? null,
      workspaceRoot: env.workspaceRoot ?? null,
      authority: env.authority && typeof env.authority === 'object' ? structuredClone(env.authority) : null,
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
        workspaceRoot: env.workspaceRoot ?? null,
        authority: env.authority && typeof env.authority === 'object' ? structuredClone(env.authority) : null,
      };
    }
    return {
      taskId: activeTaskId,
      projectKey: normalized.projectKey ?? null,
      identity: normalized.identity ?? null,
      workspaceRoot: normalized.workspaceRoot ?? null,
      authority: null,
    };
  }

  // Ownership is fail-closed and checked BEFORE every durable state write. If this
  // writer's slot was reclaimed/ousted, the mutation throws writer_conflict and no
  // state is written. refresh() re-asserts ownership after the write and is never
  // swallowed, so a concurrently lost slot surfaces as an error on the mutation.
  _persist(taskId, meta) {
    this.guard.assertOwned();
    try {
      this.store.saveTask(taskId, {
        state: this.svc.state,
        projectKey: meta ? meta.projectKey : null,
        identity: meta ? meta.identity : null,
        workspaceRoot: meta ? (meta.workspaceRoot ?? null) : null,
        authority: meta && meta.authority ? structuredClone(meta.authority) : null,
      });
    } catch (e) {
      // The write did not commit: roll the in-memory lifecycle back to the last
      // committed durable snapshot so an uncommitted transition is never canonical.
      this._restoreCommitted(taskId);
      throw e;
    }
    // refresh() re-asserts ownership after the commit and is never swallowed. If it
    // throws, the snapshot is already committed (authoritative) - do NOT roll back a
    // write that may have atomically committed.
    this.guard.refresh();
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

  _executionClaimPublic(meta) {
    const claim = meta && meta.authority && meta.authority.executionClaim;
    if (!claim) return null;
    return {
      generation: executionClaimGeneration(meta.authority),
      active: claim.token != null,
      taskId: claim.taskId ?? null,
      stepId: claim.stepId ?? null,
      workspaceRoot: claim.workspaceRoot ?? null,
      parentGeneration: claim.parentGeneration ?? null,
      claimedAt: claim.claimedAt ?? null,
      fencedAt: claim.fencedAt ?? null,
    };
  }

  _fenceExecutionClaim(meta) {
    if (!meta || !meta.authority || !meta.authority.executionClaim) return;
    meta.authority.executionClaim = fenceExecutionClaimValue(meta.authority, this._clock);
  }

  // Fencing: once a task has a Parent authority token, every Parent-authorized mutation
  // must present the current token. Execution claims never pass this gate.
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

  _assertExecutionClaimable(stepId) {
    const state = this.svc.state;
    if (!state || !state.taskId) throw governanceError('no active durable governance task is loaded', 'no_active_task');
    if (state.control === 'DONE') throw governanceError(`task ${state.taskId} is terminal DONE and cannot be claimed for execution`, 'execution_not_claimable');
    if (state.awaitingUser || state.control === 'ASK_USER') throw governanceError(`task ${state.taskId} is awaiting user input and is not executable`, 'execution_not_claimable');
    if (state.control !== 'TASK' && state.control !== 'REVISE') {
      throw governanceError(`task ${state.taskId} control ${String(state.control)} is not an executable TASK/REVISE step`, 'execution_not_claimable');
    }
    if (!stepId || state.currentStepId !== stepId) {
      throw governanceError(`step_mismatch: execution claim must target current step ${String(state.currentStepId)}, got ${String(stepId)}`, 'step_mismatch');
    }
    const directLocal = state.route === 'CHATGPT_DIRECT_LOCAL' || (state.route === 'HYBRID' && state.localRoute === 'CHATGPT_DIRECT_LOCAL');
    if (!directLocal) {
      throw governanceError(`route_mismatch: current step route ${String(state.route)} / localRoute ${String(state.localRoute)} is not CHATGPT_DIRECT_LOCAL`, 'route_mismatch');
    }
    const step = state.steps && state.steps[stepId];
    if (!step || step.executorStatus !== 'unknown' || step.machineGate !== 'pending') {
      throw governanceError(`current step ${stepId} is not in an executable pending state`, 'execution_not_claimable');
    }
  }

  _checkExecutionClaim({ taskId = null, stepId = null, executionToken = null, workspaceRoot = null, requireWorkspace = false } = {}) {
    const meta = this._meta;
    if (!meta || !meta.taskId || !this.svc.state || !this.svc.state.taskId) {
      throw governanceError('no active durable governance task is loaded for execution authorization', 'no_active_task');
    }
    if (taskId != null && String(taskId) !== String(meta.taskId)) {
      throw governanceError(`task_mismatch: execution taskId ${taskId} does not match active task ${meta.taskId}`, 'task_mismatch');
    }
    const claim = meta.authority && meta.authority.executionClaim;
    if (stepId != null && claim && String(stepId) !== String(claim.stepId)) {
      throw governanceError(`step_mismatch: execution RESULT step ${stepId} does not match claimed step ${claim.stepId}`, 'step_mismatch');
    }
    if (!claim || claim.token == null || executionToken == null || String(executionToken) !== String(claim.token)) {
      throw governanceError(`stale_execution_claim: task ${meta.taskId} has no matching active execution claim`, 'stale_execution_claim');
    }
    if (claim.taskId !== meta.taskId || claim.stepId !== this.svc.state.currentStepId || !eqRoots(claim.workspaceRoot, meta.workspaceRoot)) {
      throw governanceError(`stale_execution_claim: execution claim no longer matches the current task/step/workspace`, 'stale_execution_claim');
    }
    if (!meta.authority || claim.parentGeneration !== meta.authority.generation) {
      throw governanceError(`stale_execution_claim: Parent authority changed after execution claim generation ${claim.generation}`, 'stale_execution_claim');
    }
    if (requireWorkspace) {
      const root = this._resolveWorkspaceRoot(workspaceRoot);
      if (!root || !eqRoots(root, meta.workspaceRoot) || !eqRoots(root, claim.workspaceRoot)) {
        throw governanceError(`workspace_mismatch: execution workspace ${root || '(none)'} does not match claimed canonical workspace ${claim.workspaceRoot}`, 'workspace_mismatch');
      }
    }
    this._assertExecutionClaimable(claim.stepId);
    return claim;
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
    this._ensureRecoverable();
    this.guard.assertOwned(); // fail closed before ANY control mutation
    const normalized = { ...args };
    if (normalized.taskId != null) encodeGovernanceComponent(normalized.taskId, 'taskId'); // fail closed on unsafe ids before any mutation
    const activeTaskId = this.svc.state.taskId;
    // F1: an already-persisted durable task must never be reopened under another
    // task's authority (or silently reset as if fresh). Switching to a persisted
    // target while a different task is bound is rejected before any mutation; both
    // in-memory state and the durable snapshot stay unchanged. Only a genuinely NEW
    // (not yet persisted) taskId may start at a terminal DONE + PLAN boundary.
    if (activeTaskId != null && normalized.taskId != null && normalized.taskId !== activeTaskId && this.store.hasTask(normalized.taskId)) {
      throw governanceError(`cannot switch to already-persisted task ${normalized.taskId} while task ${activeTaskId} is active; a durable task cannot be reopened under another task's authority`, 'task_reopen_rejected');
    }
    // Restart continuation: no active task in memory, but the requested taskId already
    // exists durably -> hydrate it before applying the control (authority then binds to
    // the target task).
    if (activeTaskId == null && normalized.taskId != null && this.store.hasTask(normalized.taskId)) {
      this._hydrateTask(normalized.taskId);
    }
    const normalizedRoot = this._resolveWorkspaceRoot(normalized.workspaceRoot);
    this._assertRootCompatible(normalized.taskId || this.svc.state.taskId, normalizedRoot);
    const freshStart = this._isFreshTaskStart(normalized);
    if (freshStart) this._assertNewTaskAdmission();
    if (!freshStart) this._checkAuthority(normalized);
    const result = this.svc.transition(normalized);
    const newActiveTaskId = this.svc.state.taskId;
    if (!newActiveTaskId) return result;
    const meta = this._metaFor(newActiveTaskId, normalized);
    const minted = !meta.authority || meta.authority.token == null;
    if (minted) meta.authority = newAuthority(this._clock);
    else this._fenceExecutionClaim(meta); // any later Parent control fences prior bounded execution authority
    if (normalizedRoot && !meta.workspaceRoot) meta.workspaceRoot = normalizedRoot;
    this._meta = meta;
    this._persist(newActiveTaskId, meta);
    const out = { ...result, durable: true, workspaceRoot: meta.workspaceRoot ?? null, authority: this._authorityPublic(meta), executionClaim: this._executionClaimPublic(meta) };
    if (minted) out.authorityToken = meta.authority.token;
    return out;
  }

  recordResult(args = {}) {
    this._ensureOpen();
    this._ensureRecoverable();
    this.guard.assertOwned(); // fail closed before ANY RESULT mutation
    const normalized = { ...args };
    if (normalized.taskId != null) encodeGovernanceComponent(normalized.taskId, 'taskId'); // fail closed on unsafe ids before any mutation
    if (this.svc.state.taskId == null && normalized.taskId != null && this.store.hasTask(normalized.taskId)) {
      this._hydrateTask(normalized.taskId);
    }
    if (normalized.authorityToken != null && normalized.executionToken != null) {
      throw governanceError('RESULT must use either Parent authorityToken or bounded executionToken, not both', 'bad_request');
    }
    if (normalized.executionToken != null) {
      this._checkExecutionClaim({ taskId: normalized.taskId, stepId: normalized.stepId, executionToken: normalized.executionToken });
    } else {
      this._checkAuthority(normalized);
    }
    const result = this.svc.recordResult(normalized);
    const activeTaskId = this.svc.state.taskId;
    if (!activeTaskId) return result;
    const meta = this._meta || { taskId: activeTaskId, projectKey: null, identity: null, authority: null };
    this._fenceExecutionClaim(meta); // RESULT completes the claimed execution unit
    this._meta = meta;
    this._persist(activeTaskId, meta);
    return { ...result, durable: true, authority: this._authorityPublic(meta), executionClaim: this._executionClaimPublic(meta) };
  }

  status() {
    const base = this.svc.status();
    return {
      ...base,
      durable: true,
      namespace: this.namespace,
      schemaVersion: GOVERNANCE_SCHEMA_VERSION,
      recoveryRequired: this._recoveryRequired,
      workspaceRoot: this._meta ? (this._meta.workspaceRoot ?? null) : null,
      authority: this._authorityPublic(this._meta),
      executionClaim: this._executionClaimPublic(this._meta),
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
    this._recoveryRequired = false; // successful reload of the committed snapshot
    return {
      ok: true,
      taskId: env.taskId,
      projectKey: env.projectKey ?? null,
      identity: env.identity ?? null,
      control: env.state ? env.state.control : null,
      terminal: !!(env.state && env.state.control === 'DONE'),
      workspaceRoot: env.workspaceRoot ?? null,
      authority: this._authorityPublic(this._meta),
      executionClaim: this._executionClaimPublic(this._meta),
    };
  }

  // Bounded Parent takeover: resolve the single task, increment the durable authority
  // generation, and mint a new opaque fencing token for the new Parent session. A
  // takeover attempted with a stale (non-current) token is rejected as stale_authority.
  // Takeover NEVER touches delegated execution; reconcile that through the executor.
  takeover({ taskId = null, projectKey = null, identity = null, authorityToken = null, workspaceRoot = null } = {}) {
    this._ensureOpen();
    this._ensureRecoverable();
    this.guard.assertOwned(); // fail closed before a takeover can persist new authority
    if (taskId != null) encodeGovernanceComponent(taskId, 'taskId'); // fail closed on unsafe ids
    const rec = this.resolveSemantic({ taskId, projectKey, identity });
    if (!rec.ok) throw governanceError(`${rec.error}: ${rec.reason}`, rec.error);
    const env = this.store.loadTask(rec.taskId);
    const canonicalRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (canonicalRoot && env.workspaceRoot && !eqRoots(canonicalRoot, env.workspaceRoot)) {
      throw governanceError(`workspace_mismatch: task ${env.taskId} is bound to canonical workspace ${env.workspaceRoot}; takeover under ${canonicalRoot} rejected`, 'workspace_mismatch');
    }
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
      executionClaim: fenceExecutionClaimValue(env.authority, this._clock),
    };
    this.svc.state = structuredClone(env.state);
    this._meta = {
      taskId: env.taskId,
      projectKey: env.projectKey ?? null,
      identity: env.identity ?? null,
      workspaceRoot: canonicalRoot || env.workspaceRoot || null,
      authority,
    };
    this._persist(env.taskId, this._meta);
    const execution = buildExecutionSummary(this.svc.state, { taskId: env.taskId, identity: this._meta.identity });
    const capsule = this.capsule({ execution });
    return {
      ok: true,
      taskId: env.taskId,
      workspaceRoot: this._meta.workspaceRoot ?? null,
      authority: { generation: authority.generation, token: authority.token },
      executionClaim: this._executionClaimPublic(this._meta),
      capsule,
      execution,
    };
  }

  // ---- Bounded implementation-session execution continuation (Issue #34) -------
  // Claiming does NOT acquire Parent authority. It resolves one active semantic task,
  // binds exact current step + canonical workspace + Direct Local route, increments an
  // independent execution generation, and mints an opaque execution token. Re-claim
  // fences the prior execution token while preserving Parent generation/token exactly.
  claimExecution({ taskId = null, projectKey = null, identity = null, stepId = null, workspaceRoot = null } = {}) {
    this._ensureOpen();
    this._ensureRecoverable();
    this.guard.assertOwned();
    if (taskId != null) encodeGovernanceComponent(taskId, 'taskId');
    if (taskId == null && projectKey == null && identity == null) {
      throw governanceError('execution claim requires bounded semantic task identity', 'bad_request');
    }
    if (!stepId) throw governanceError('execution claim requires the exact current stepId', 'bad_request');
    const rec = this.recoverSemantic({ taskId, projectKey, identity });
    if (!rec.ok) {
      const code = rec.error === 'not_found' && rec.terminalMatches ? 'execution_not_claimable' : rec.error;
      throw governanceError(`${code}: ${rec.reason}`, code);
    }
    if (this.svc.state.taskId != null && this.svc.state.taskId !== rec.taskId) {
      throw governanceError(`task_mismatch: runtime is already bound to task ${this.svc.state.taskId}, not claim target ${rec.taskId}`, 'task_mismatch');
    }
    const env = this.store.loadTask(rec.taskId);
    const root = this._resolveWorkspaceRoot(workspaceRoot);
    if (!env.workspaceRoot) throw governanceError(`task ${env.taskId} has no canonical workspace root and cannot be claimed`, 'workspace_unbound');
    if (!root || !eqRoots(root, env.workspaceRoot)) {
      throw governanceError(`workspace_mismatch: claim workspace ${root || '(none)'} does not match task ${env.taskId} canonical workspace ${env.workspaceRoot}`, 'workspace_mismatch');
    }
    this.svc.state = structuredClone(env.state);
    this._meta = {
      taskId: env.taskId,
      projectKey: env.projectKey ?? null,
      identity: env.identity ?? null,
      workspaceRoot: env.workspaceRoot,
      authority: env.authority && typeof env.authority === 'object' ? structuredClone(env.authority) : null,
    };
    if (!this._meta.authority || this._meta.authority.token == null) {
      throw governanceError(`task ${env.taskId} has no active Parent authorization to continue`, 'stale_authority');
    }
    this._assertExecutionClaimable(stepId);
    const generation = executionClaimGeneration(this._meta.authority) + 1;
    const token = makeAuthorityToken();
    this._meta.authority.executionClaim = {
      generation,
      token,
      taskId: env.taskId,
      stepId,
      workspaceRoot: env.workspaceRoot,
      parentGeneration: this._meta.authority.generation,
      claimedAt: this._clock(),
      fencedAt: null,
    };
    this._persist(env.taskId, this._meta);
    return {
      ok: true,
      taskId: env.taskId,
      stepId,
      workspaceRoot: env.workspaceRoot,
      authority: this._authorityPublic(this._meta),
      executionClaim: this._executionClaimPublic(this._meta),
      executionToken: token,
    };
  }

  // Narrow claim authorization used ONLY by Direct Local apply/workspace-effect verify.
  // Parent-token authorizeMutation remains unchanged for Codex and compatibility paths.
  authorizeExecution({ taskId = null, executionToken = null, workspaceRoot = null } = {}) {
    this._ensureOpen();
    this._ensureRecoverable();
    const claim = this._checkExecutionClaim({ taskId, executionToken, workspaceRoot, requireWorkspace: true });
    return {
      ok: true,
      taskId: this._meta.taskId,
      stepId: claim.stepId,
      workspaceRoot: this._meta.workspaceRoot,
      executionClaim: { generation: claim.generation, parentGeneration: claim.parentGeneration },
    };
  }

  // ---- Task-scoped Parent mutation authorization (Issue #29) -------------------
  // workspaceId/jobId/changeSetId are lookup selectors, not mission authority. A NEW
  // mutation unit is authorized against the CURRENT durable Governance task + its
  // canonical workspace root + CURRENT Parent token. This path remains the only path
  // for new Codex turns and all other Parent-authorized mutation categories.
  authorizeMutation({ taskId = null, authorityToken = null, workspaceRoot = null } = {}) {
    this._ensureOpen();
    this._ensureRecoverable();
    const meta = this._meta;
    if (!meta || !meta.taskId || !this.svc.state || !this.svc.state.taskId) {
      throw governanceError('no active durable governance task in this runtime; recover/takeover the existing task before authorizing a new mutation', 'no_active_task');
    }
    if (this.svc.state.control === 'DONE') {
      throw governanceError(`active task ${meta.taskId} is terminal DONE and cannot authorize a new mutation; a genuinely new PLAN is required`, 'no_active_task');
    }
    if (taskId != null && String(taskId) !== String(meta.taskId)) {
      throw governanceError(`task_mismatch: mutation taskId ${taskId} does not match the active durable governance task ${meta.taskId}`, 'task_mismatch');
    }
    if (!meta.authority || meta.authority.token == null) {
      throw governanceError(`task ${meta.taskId} has no active authority token; perform a bounded takeover before mutating`, 'stale_authority');
    }
    if (authorityToken == null || String(authorityToken) !== String(meta.authority.token)) {
      throw governanceError(`stale_authority: task ${meta.taskId} authority generation ${meta.authority.generation} is fenced; present the current authority token`, 'stale_authority');
    }
    if (meta.workspaceRoot == null) {
      throw governanceError(`task ${meta.taskId} is not bound to a canonical workspace root; bind it via takeover/PLAN with a workspace handle before authorizing a mutation`, 'workspace_unbound');
    }
    const root = this._resolveWorkspaceRoot(workspaceRoot);
    if (!root || !eqRoots(root, meta.workspaceRoot)) {
      throw governanceError(`workspace_mismatch: mutation workspace ${root || '(none)'} does not match task ${meta.taskId} canonical workspace ${meta.workspaceRoot}`, 'workspace_mismatch');
    }
    return { ok: true, taskId: meta.taskId, workspaceRoot: meta.workspaceRoot, authority: { generation: meta.authority.generation } };
  }

  // ---- Durable new-task admission gate (Issue #29) -----------------------------
  // A genuinely NEW PLAN on a fresh/restarted runtime scans the durable namespace
  // before admission: 0 non-terminal tasks allow a genuinely new task; 1 rejects with
  // bounded recovery-required semantics; >1 fails ambiguous. Terminal DONE tasks are
  // never counted (in-process DONE -> new PLAN stays valid) and are never reopened
  // under another task's authority.
  _assertNewTaskAdmission() {
    const scan = this.store.scanStrict();
    if (scan.corruptCount > 0) {
      throw governanceError(`cannot admit a new task: ${scan.corruptCount} durable governance task file(s) are unreadable; refusing to infer absence`, 'corrupt');
    }
    const active = scan.tasks.filter((e) => !e.state || e.state.control !== 'DONE');
    if (active.length === 0) return;
    if (active.length === 1) {
      throw governanceError(`recovery_required: an in-progress durable governance task (${active[0].taskId}) exists; recover/takeover it before admitting a genuinely new PLAN`, 'recovery_required');
    }
    throw governanceError(`ambiguous: ${active.length} in-progress durable governance tasks exist; refusing to admit a genuinely new PLAN (no most-recent guessing)`, 'ambiguous');
  }

  _resolveWorkspaceRoot(value) {
    return canonicalWorkspaceRoot(value);
  }

  // Reject re-binding an already persisted task to a different canonical workspace root
  // BEFORE any in-memory lifecycle mutation can diverge from the durable snapshot.
  _assertRootCompatible(taskId, canonicalRoot) {
    if (canonicalRoot == null || taskId == null) return;
    if (!this.store.hasTask(taskId)) return;
    const env = this.store.loadTask(taskId);
    if (env.workspaceRoot && !eqRoots(env.workspaceRoot, canonicalRoot)) {
      throw governanceError(`workspace_mismatch: task ${env.taskId} is bound to canonical workspace ${env.workspaceRoot}; refusing to re-bind under ${canonicalRoot}`, 'workspace_mismatch');
    }
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
  const takeoverScope = { ...scope };
  if (workspaceRoot) takeoverScope.workspaceRoot = workspaceRoot;
  const takeoverResult = service.takeover(takeoverScope);
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