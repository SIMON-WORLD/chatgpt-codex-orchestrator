// chatgpt-codex-orchestrator: Governance (v0.2 M4 r1).
// The arbitrator of correctness over the router/executor layer. Reuses the existing
// acceptance / evidence / machine-gate / Brain-acceptance / publication gates from
// protocol.js, direct-governance.js, protocol-integrity.js and publication-transaction.js.
//
// Lifecycle contract (r1):
//   Brain TASK (step s, acceptance contract)        -> authorizes execution (gates pending)
//   Executor RESULT (recordResult on active step)   -> writes executorStatus/evidence/gate
//   Brain next control (TASK s+1 / PUBLISH / DONE)   -> explicit acceptance of prior step
//   REVISE                                         -> keeps step identity, reopens invalidated
//
// Governance NEVER performs a workspace mutation itself.

import { CONTROLS, validateLifecycleAfterDone, normalizeEvidence } from '../protocol.js';
import { evaluateDirectAcceptanceGate, normalizeAcceptanceItem, createProofLedger, createDirectMetrics } from '../direct-governance.js';
import { buildAskUserEnvelope } from '../protocol-integrity.js';
import { publicationReadyForDone } from '../publication-transaction.js';
import { buildHandoff } from '../state/handoff.js';

export const GOV_CONTROLS = CONTROLS;
export const GOV_ROUTES = ['CHATGPT_NATIVE', 'CHATGPT_DIRECT_LOCAL', 'CODEX_DELEGATE', 'HYBRID'];

export class GovernanceError extends Error {
  constructor(msg) { super(msg); this.name = 'GovernanceError'; }
}

const EXECUTOR_OK = 'success';
const GATE_PASS = 'pass';

function newStep(stepId, acceptance = []) {
  return {
    stepId,
    acceptance: (acceptance || []).map(normalizeAcceptanceItem).filter(Boolean),
    evidence: [],
    executorStatus: 'unknown',
    machineGate: 'pending',
    brainAcceptance: 'pending',
    changed: [],
  };
}

export class GovernanceService {
  constructor({ proofLedger = createProofLedger(), metrics = createDirectMetrics(), allowPublish = true } = {}) {
    this.proofLedger = proofLedger;
    this.metrics = metrics;
    this.allowPublish = allowPublish;
    this.state = this._freshState();
  }

  _freshState() {
    return {
      taskId: null,
      control: null,
      route: null,
      localRoute: null,
      planRevision: 0,
      currentStepId: null,
      previousStepId: null,
      steps: {},
      awaitingUser: false,
      askUser: null,
      publicationRequired: false,
      publishResult: null,
      published: false,
      history: [],
    };
  }

  _requireControl(control) {
    if (!CONTROLS.includes(control)) throw new GovernanceError(`unknown governance control: ${control}`);
  }
  _requireTask(control) {
    if (!this.state.taskId) throw new GovernanceError(`a taskId is required before a ${control} transition`);
  }
  // Bind the taskId once. After the first bind it stays stable: a different taskId is
  // a GovernanceError, and an omitted taskId uses the already-bound taskId.
  _bindTask(taskId) {
    if (taskId == null) return;
    if (this.state.taskId && this.state.taskId !== taskId) throw new GovernanceError(`taskId mismatch: already bound to ${this.state.taskId}, got ${taskId}`);
    if (!this.state.taskId) this.state.taskId = taskId;
  }
  _pushHistory(entry) { this.state.history.push({ ...entry, at: Date.now() }); }
  // Terminal state: this task reached a successful (terminal) DONE.
  _isTerminalDone() { return this.state.control === 'DONE'; }

  // Reset task-scoped state for a NEW sequential task in the same persistent runtime.
  // Does NOT touch taskId (the caller binds the new id), proofLedger, or metrics.
  _resetTask() {
    this.state.taskId = null;
    this.state.control = null;
    this.state.route = null;
    this.state.localRoute = null;
    this.state.planRevision = 0;
    this.state.currentStepId = null;
    this.state.previousStepId = null;
    this.state.steps = {};
    this.state.awaitingUser = false;
    this.state.askUser = null;
    this.state.publicationRequired = false;
    this.state.publishResult = null;
    this.state.published = false;
    this.state.history = [];
  }

  // Keep each acceptance item's .status truthful against current evidence.
  _syncAcceptanceStatus(step) {
    for (const a of step.acceptance) {
      const ev = step.evidence.find((e) => e.acceptanceId === a.id);
      if (ev) a.status = ev.status;
      else if (a.status == null) a.status = 'missing';
      // When evidence is cleared (e.g. REVISE) the caller sets a.status = 'pending'.
    }
  }

  // Idempotent result for a repeated DONE on a terminal task.
  _terminalDoneResult() {
    const cur = this.currentStep;
    return {
      ok: true, accepted: true, blocked: false, reason: null,
      control: 'DONE',
      taskId: this.state.taskId,
      stepId: this.state.currentStepId,
      previousStepId: this.state.previousStepId,
      route: this.state.route,
      localRoute: this.state.localRoute,
      executorStatus: cur ? cur.executorStatus : 'success',
      machineGate: cur ? cur.machineGate : 'pass',
      brainAcceptance: 'accepted',
      publicationRequired: this.state.publicationRequired,
      nextAction: 'done',
      handoff: this._buildHandoff('DONE', 'done', false),
    };
  }


  _step(stepId) { return this.state.steps[stepId] || null; }
  get currentStep() { return this._step(this.state.currentStepId); }

  _setCurrentStepAcceptance(step, acceptance) {
    step.acceptance = (acceptance || []).map(normalizeAcceptanceItem).filter(Boolean);
  }

  _computeMachineGate(step) {
    const gate = evaluateDirectAcceptanceGate({
      acceptance: step.acceptance.map((a) => ({ id: a.id, required: a.required, requiredEvidenceLevel: a.requiredEvidenceLevel })),
      evidence: step.evidence.map((e) => ({ acceptanceId: e.acceptanceId, status: e.status, evidenceLevel: e.evidenceLevel })),
    });
    return gate.ok ? 'pass' : 'fail';
  }

  // Hard execution gates: executor must have succeeded and the machine gate must pass.
  _stepHardOk(step) {
    return !!step && step.executorStatus === EXECUTOR_OK && step.machineGate === GATE_PASS;
  }
  // Full acceptance authority: hard gates AND explicit Brain acceptance.
  _isStepAccepted(step) {
    return this._stepHardOk(step) && step.brainAcceptance === 'accepted';
  }

  _invalidateProofs(acceptanceIds) {
    for (const id of (acceptanceIds || [])) {
      const p = this.proofLedger.get(id);
      if (!p) continue;
      // Re-record as stale, preserving metadata; isFresh() then returns false.
      this.proofLedger.record({ acceptanceId: id, status: 'stale', kind: p.kind || 'verify', summary: p.summary || '', relevantFiles: p.relevantFiles || [], dependencyFree: p.dependencyFree === true, verificationId: p.verificationId || null, stepId: p.stepId || null });
    }
  }

  // ---- Brain controls -------------------------------------------------------
  transition({ taskId = null, stepId = null, control, route = null, localRoute = null, acceptance = null, reviseDelta = null, whyBlocked = '', minimalUserAction = '', expectedFields = [], question = '', resumeControlId = null } = {}) {
    this._requireControl(control);
    // Sequential task boundary in one persistent runtime: a NEW taskId at a terminal-DONE
    // + PLAN boundary starts a fresh task lifecycle. Otherwise a taskId change is rejected.
    if (taskId != null && this.state.taskId && taskId !== this.state.taskId) {
      if (this._isTerminalDone() && control === 'PLAN') { this._resetTask(); }
      else { throw new GovernanceError(`cannot start new task ${taskId}: current task ${this.state.taskId} is not terminal DONE at a PLAN boundary`); }
    }
    this._bindTask(taskId);
    this._requireTask(control);

    // Terminal guard: after a successful terminal DONE on THIS task, no other control is
    // accepted. Repeated DONE is idempotent (state is immutable after DONE).
    if (this._isTerminalDone()) {
      if (control === 'DONE') return this._terminalDoneResult();
      const life = validateLifecycleAfterDone(control);
      throw new GovernanceError(life.reason);
    }

    if (route) this.state.route = route;
    if (localRoute) this.state.localRoute = localRoute;

    let blocked = false;
    let reason = null;
    let nextAction = null;

    switch (control) {
      case 'PLAN':
        this.state.planRevision += 1;
        this.state.awaitingUser = false;
        nextAction = 'task';
        break;

      case 'REPLAN':
        this.state.planRevision += 1;
        this.state.awaitingUser = false;
        nextAction = 'replan_confirm';
        break;

      case 'TASK': {
        this.state.awaitingUser = false;
        if (!stepId) throw new GovernanceError('TASK requires a stepId');
        const advancing = !!this.state.currentStepId && stepId !== this.state.currentStepId;
        if (advancing) {
          const prior = this._step(this.state.currentStepId);
          if (!this._stepHardOk(prior)) {
            throw new GovernanceError(`cannot advance from step ${this.state.currentStepId}: prior step is not execution+gate ready (executor success and machine gate pass required)`);
          }
          // Brain explicitly accepts the prior step by advancing to a new one.
          prior.brainAcceptance = 'accepted';
          this.state.previousStepId = this.state.currentStepId;
        }
        this.state.currentStepId = stepId;
        const existing = this._step(stepId);
        if (existing) {
          // Re-issue TASK on the SAME step. Never clear a RESULT.
          const hasResult = existing.executorStatus !== 'unknown' || existing.machineGate !== 'pending' || existing.evidence.length > 0 || existing.changed.length > 0;
          if (hasResult) {
            blocked = true;
            reason = 'TASK reissue on a step that already has a RESULT: use REVISE to re-execute this step, or a new stepId to advance';
            nextAction = 'blocked_task_reissue';
            break;
          }
          // Idempotent reissue of the same execution authorization (still fresh): keep
          // executorStatus/gate/evidence unchanged, refresh the acceptance contract.
          if (acceptance) this._setCurrentStepAcceptance(existing, acceptance);
          existing.brainAcceptance = 'pending';
          nextAction = 'execute';
        } else {
          const step = newStep(stepId, acceptance);
          this.state.steps[stepId] = step;
          nextAction = 'execute';
        }
        break;
      }

      case 'REVISE': {
        if (!stepId) throw new GovernanceError('REVISE requires a stepId');
        this.state.currentStepId = stepId;
        const step = this._step(stepId) || newStep(stepId, acceptance);
        this.state.steps[stepId] = step;
        if (acceptance) this._setCurrentStepAcceptance(step, acceptance);
        step.brainAcceptance = 'revise';
        let reopened = [];
        if (reviseDelta) {
          // Deterministic reopen: any acceptance listed in invalidate (and not preserved)
          // is reopened, regardless of its prior accepted/pending status, so re-verification
          // is required before the step can pass again.
          const invalidate = new Set(reviseDelta.invalidate || []);
          const preserve = new Set(reviseDelta.preserve || []);
          reopened = step.acceptance.filter((a) => invalidate.has(a.id) && !preserve.has(a.id)).map((a) => a.id);
          for (const id of reopened) {
            const acc = step.acceptance.find((a) => a.id === id);
            if (acc) acc.status = 'pending';
          }
          const invalidated = new Set(reopened);
          step.evidence = step.evidence.filter((e) => !invalidated.has(e.acceptanceId));
          if (reopened.length) this._invalidateProofs(reopened);
          for (const id of reopened) this._pushHistory({ type: 'acceptance', stepId: id, acceptance: 'revise' });
        }
        // Revert to a re-executable state.
        step.executorStatus = 'unknown';
        step.machineGate = 'pending';
        nextAction = 'revise_execute';
        break;
      }

      case 'ASK_USER':
        this.state.awaitingUser = true;
        this.state.askUser = buildAskUserEnvelope({ whyBlocked, minimalUserAction, readOnly: true, expectedFields: expectedFields || [], question, resumeControlId });
        blocked = true;
        reason = 'awaiting user decision';
        nextAction = 'awaiting_user';
        break;

      case 'PUBLISH': {
        this.state.awaitingUser = false;
        const cur = this.currentStep;
        if (!this._stepHardOk(cur)) { blocked = true; reason = 'PUBLISH requires the current step to be execution+gate ready (executor success + machine gate pass)'; nextAction = 'blocked_publish_acceptance'; break; }
        if (!this.allowPublish) { blocked = true; reason = 'publish disabled'; nextAction = 'blocked_publish_disabled'; break; }
        // Brain authorizes publication => explicit acceptance of the milestone.
        cur.brainAcceptance = 'accepted';
        this.state.publicationRequired = true;
        nextAction = 'publication_pending';
        break;
      }

      case 'DONE': {
        this.state.awaitingUser = false;
        const cur = this.currentStep;
        if (!cur) { blocked = true; reason = 'DONE blocked: no active step'; nextAction = 'blocked_done'; break; }
        if (cur.executorStatus !== EXECUTOR_OK) { blocked = true; reason = 'DONE blocked: executor result is not success'; nextAction = 'blocked_done'; break; }
        if (cur.machineGate !== GATE_PASS) { blocked = true; reason = 'DONE blocked: machine gate not passed'; nextAction = 'blocked_done'; break; }
        if (this.state.publicationRequired && !publicationReadyForDone(this.state.publishResult)) {
          blocked = true; reason = 'DONE blocked: publication required but no successful readback result'; nextAction = 'blocked_done_publication'; break;
        }
        // Brain DONE is explicit acceptance of the current step (terminal).
        cur.brainAcceptance = 'accepted';
        this.state.control = 'DONE';
        nextAction = 'done';
        break;
      }

      default:
        nextAction = 'none';
    }

    if (control !== 'DONE') this.state.control = control;

    this._pushHistory({ control, blocked: !!blocked, reason, nextAction });
    const cur = this.currentStep;
    const handoff = this._buildHandoff(control, nextAction, blocked);
    return {
      ok: !blocked,
      accepted: !blocked,
      blocked: !!blocked,
      reason,
      control,
      taskId: this.state.taskId,
      stepId: this.state.currentStepId,
      previousStepId: this.state.previousStepId,
      route: this.state.route,
      localRoute: this.state.localRoute,
      executorStatus: cur ? cur.executorStatus : 'unknown',
      machineGate: cur ? cur.machineGate : 'pending',
      brainAcceptance: cur ? cur.brainAcceptance : 'pending',
      publicationRequired: this.state.publicationRequired,
      nextAction,
      handoff,
    };
  }

  // ---- Executor RESULT ingestion --------------------------------------------
  recordResult({ taskId = null, stepId = null, executorStatus = 'unknown', evidence = null, changed = null, publication = null } = {}) {
    // Terminal contract: after a successful DONE, the task state is immutable. A RESULT
    // cannot be ingested again (fail-closed); the state is left completely unchanged.
    if (this._isTerminalDone()) throw new GovernanceError('governance is terminal after DONE: recordResult is not allowed on this task');
    this._bindTask(taskId);
    if (!this.state.taskId) throw new GovernanceError('recordResult requires a taskId');
    if (!stepId) throw new GovernanceError('recordResult requires a stepId');
    if (stepId !== this.state.currentStepId) throw new GovernanceError(`recordResult must target the active step ${String(this.state.currentStepId)}, got ${stepId}`);

    const step = this._step(stepId);
    step.executorStatus = executorStatus;

    if (evidence) step.evidence = (evidence || []).map(normalizeEvidence).filter((e) => e && e.acceptanceId);
    this._syncAcceptanceStatus(step);
    if (changed) {
      step.changed = Array.isArray(changed) ? changed : (changed ? [changed] : []);
      const staleCount = this.proofLedger.invalidateOnChange(step.changed);
      this._pushHistory({ type: 'proof', event: 'invalidate_on_change', staleCount, changed: step.changed });
    }

    step.machineGate = this._computeMachineGate(step);
    step.brainAcceptance = 'pending'; // Brain acceptance happens on advancement / PUBLISH / DONE

    let recordedProofs = 0;
    for (const e of step.evidence) {
      if (e.status !== 'pass') continue;
      const acc = step.acceptance.find((a) => a.id === e.acceptanceId);
      const proof = acc && acc.proof;
      if (proof && ((proof.relevantFiles && proof.relevantFiles.length) || proof.dependencyFree || proof.verificationId)) {
        this.proofLedger.record({ acceptanceId: e.acceptanceId, status: 'pass', kind: e.kind || 'verify', summary: e.summary || '', relevantFiles: proof.relevantFiles || [], dependencyFree: proof.dependencyFree === true, verificationId: proof.verificationId || null, stepId });
        recordedProofs += 1;
        this._pushHistory({ type: 'proof', event: 'record', acceptanceId: e.acceptanceId, stepId });
      }
    }

    if (publication) {
      this.state.publishResult = publication;
      this.state.published = !!(publication && publication.ok);
      this._pushHistory({ type: 'publication', ok: !!(publication && publication.ok) });
    }

    this._pushHistory({ type: 'result', stepId, executorStatus, machineGate: step.machineGate, changed: step.changed });

    const handoff = this._buildResultHandoff(step);
    return {
      ok: true,
      taskId: this.state.taskId,
      stepId,
      executorStatus,
      machineGate: step.machineGate,
      brainAcceptance: step.brainAcceptance,
      recordedProofs,
      proofReusableByAcceptance: step.evidence.filter((e) => e.status === 'pass').map((e) => ({ acceptanceId: e.acceptanceId, reusable: this.proofLedger.isReusable(e.acceptanceId) })),
      changed: step.changed,
      publicationRequired: this.state.publicationRequired,
      publishResult: this.state.publishResult,
      published: this.state.published,
      handoff,
    };
  }

  _buildResultHandoff(step) {
    return buildHandoff({
      taskId: this.state.taskId,
      stepId: step.stepId,
      control: this.state.control,
      route: this.state.route,
      localRoute: this.state.localRoute,
      acceptance: step.acceptance.map((a) => ({ id: a.id, required: a.required !== false })),
      evidenceSummary: step.evidence.map((e) => ({ acceptanceId: e.acceptanceId, status: e.status, kind: e.kind, summary: e.summary || null })),
      changed: step.changed,
      machineGate: step.machineGate,
      brainAcceptance: step.brainAcceptance,
    });
  }

  _buildHandoff(control, nextAction, blocked) {
    const cur = this.currentStep;
    return buildHandoff({
      taskId: this.state.taskId,
      stepId: this.state.currentStepId,
      control: this.state.control || control,
      route: this.state.route,
      localRoute: this.state.localRoute,
      acceptance: cur ? cur.acceptance.map((a) => ({ id: a.id, required: a.required !== false })) : [],
      evidenceSummary: cur ? cur.evidence.map((e) => ({ acceptanceId: e.acceptanceId, status: e.status, kind: e.kind, summary: e.summary || null })) : [],
      changed: cur ? cur.changed : [],
      machineGate: cur ? cur.machineGate : 'pending',
      brainAcceptance: cur ? cur.brainAcceptance : 'pending',
      nextAction: blocked ? null : nextAction,
    });
  }

  status() {
    const steps = {};
    for (const [id, s] of Object.entries(this.state.steps)) {
      steps[id] = {
        stepId: id,
        acceptance: s.acceptance.map((a) => ({ id: a.id, required: a.required !== false, status: a.status || 'missing' })),
        evidence: s.evidence.map((e) => ({ acceptanceId: e.acceptanceId, status: e.status, kind: e.kind, summary: e.summary || null })),
        executorStatus: s.executorStatus,
        machineGate: s.machineGate,
        brainAcceptance: s.brainAcceptance,
        changed: s.changed,
      };
    }
    const acceptedSteps = Object.entries(this.state.steps).filter(([, s]) => s.brainAcceptance === 'accepted').map(([id]) => id);
    return {
      taskId: this.state.taskId,
      control: this.state.control,
      route: this.state.route,
      localRoute: this.state.localRoute,
      currentStepId: this.state.currentStepId,
      previousStepId: this.state.previousStepId,
      steps,
      acceptedSteps,
      publicationRequired: this.state.publicationRequired,
      publishResult: this.state.publishResult,
      published: this.state.published,
      awaitingUser: this.state.awaitingUser,
      askUser: this.state.askUser || null,
      planned: this.state.planRevision > 0,
      history: this.state.history.slice(-8),
    };
  }
}

export function createGovernanceService(opts) { return new GovernanceService(opts); }
export function governanceGateOk({ executorStatus = 'unknown', machineGate = 'pending', brainAcceptance = 'pending' } = {}) {
  return executorStatus === 'success' && machineGate === 'pass' && brainAcceptance === 'accepted';
}
