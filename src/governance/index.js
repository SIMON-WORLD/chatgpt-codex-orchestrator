// chatgpt-codex-orchestrator: Governance (v0.2 M4).
// The arbitrator of correctness over the router/executor layer. Reuses the existing
// acceptance / evidence / machine-gate / Brain-acceptance / publication gates from
// protocol.js, direct-governance.js, protocol-integrity.js and publication-transaction.js.
//
// Governance decides WHAT should happen and WHEN a milestone is accepted. Routing only
// decides WHO executes. Governance NEVER performs a workspace mutation itself.

import { CONTROLS, validateLifecycleAfterDone, normalizeEvidence } from '../protocol.js';
import { evaluateDirectAcceptanceGate, normalizeAcceptanceItem, createProofLedger, createDirectMetrics } from '../direct-governance.js';
import { applyBrainAcceptanceTransition, applyReviseDelta, buildAskUserEnvelope } from '../protocol-integrity.js';
import { publicationReadyForDone } from '../publication-transaction.js';
import { buildHandoff } from '../state/handoff.js';

export const GOV_CONTROLS = CONTROLS;
export const GOV_ROUTES = ['CHATGPT_NATIVE', 'CHATGPT_DIRECT_LOCAL', 'CODEX_DELEGATE', 'HYBRID'];

export class GovernanceError extends Error {
  constructor(msg) { super(msg); this.name = 'GovernanceError'; }
}

// When the machine gate is passed for a TASK/RESULT cycle, a prior step may be
// Brain-accepted. Controls that carry an accepted prior milestone:
const ADVANCEMENT_CONTROLS = ['TASK', 'PUBLISH', 'DONE'];

export class GovernanceService {
  constructor({ proofLedger = createProofLedger(), metrics = createDirectMetrics(), allowPublish = true } = {}) {
    this.proofLedger = proofLedger;
    this.metrics = metrics;
    this.allowPublish = allowPublish;
    this.state = this._freshState();
  }

  _freshState() {
    return {
      taskId: null, stepId: null, prevStepId: null, control: null,
      route: null, localRoute: null, planRevision: 0,
      acceptance: [], evidence: [], acceptanceStates: {}, changed: [],
      executorStatus: 'unknown', machineGate: 'pending', brainAcceptance: 'pending',
      awaitingUser: false, askUser: null, published: false, publishResult: null,
      history: [],
    };
  }

  _requireControl(control) {
    if (!CONTROLS.includes(control)) throw new GovernanceError(`unknown governance control: ${control}`);
  }
  _requireIdentity(control) {
    if (!this.state.taskId || !this.state.stepId) throw new GovernanceError(`taskId/stepId are required before a ${control} transition`);
  }
  _pushHistory(entry) { this.state.history.push({ ...entry, at: Date.now() }); }

  _setAcceptance(acceptance) {
    for (const raw of (acceptance || [])) {
      const a = normalizeAcceptanceItem(raw);
      if (!a) continue;
      const ex = this.state.acceptance.find((x) => x.id === a.id);
      if (ex) {
        ex.required = a.required;
        ex.text = a.text;
        ex.proof = a.proof;
        ex.requiredEvidenceLevel = a.requiredEvidenceLevel || ex.requiredEvidenceLevel;
      } else {
        this.state.acceptance.push({ ...a, status: 'missing' });
      }
    }
  }

  _setEvidence(evidence) {
    for (const raw of (evidence || [])) {
      const e = normalizeEvidence(raw);
      if (!e || !e.acceptanceId) continue;
      const ex = this.state.evidence.find((x) => x.acceptanceId === e.acceptanceId);
      if (ex) {
        ex.status = e.status;
        ex.evidenceLevel = e.evidenceLevel;
        ex.kind = e.kind;
        ex.summary = e.summary;
      } else {
        this.state.evidence.push({ acceptanceId: e.acceptanceId, status: e.status, evidenceLevel: e.evidenceLevel, kind: e.kind, summary: e.summary });
      }
    }
  }

  _computeMachineGate() {
    const gate = evaluateDirectAcceptanceGate({
      acceptance: this.state.acceptance.map((a) => ({ id: a.id, required: a.required, requiredEvidenceLevel: a.requiredEvidenceLevel })),
      evidence: this.state.evidence.map((e) => ({ acceptanceId: e.acceptanceId, status: e.status, evidenceLevel: e.evidenceLevel })),
    });
    return gate.ok ? 'pass' : 'fail';
  }

  // Apply a single Brain control. Returns a compact transition result + handoff.
  transition({ taskId = null, stepId = null, control, route = null, localRoute = null, acceptance = null, evidence = null, reviseDelta = null, executorStatus = 'unknown', changed = null, publication = null, whyBlocked = '', minimalUserAction = '', expectedFields = [], question = '', resumeControlId = null } = {}) {
    this._requireControl(control);
    if (taskId) this.state.taskId = taskId;
    if (stepId) this.state.stepId = stepId;
    this._requireIdentity(control);

    // Terminal guard: after a successful DONE, no other control is accepted.
    if (this.state.control === 'DONE' && control !== 'DONE') {
      const life = validateLifecycleAfterDone(control);
      throw new GovernanceError(life.reason);
    }

    if (route) this.state.route = route;
    if (localRoute) this.state.localRoute = localRoute;
    if (executorStatus !== undefined) this.state.executorStatus = executorStatus;
    if (changed !== null && changed !== undefined) this.state.changed = Array.isArray(changed) ? changed : (changed ? [changed] : []);
    if (acceptance) this._setAcceptance(acceptance);
    if (evidence) this._setEvidence(evidence);

    const machineGate = this._computeMachineGate();
    const prevStepId = this.state.prevStepId;
    const bt = applyBrainAcceptanceTransition({ control, prevStepId, reviseDelta, acceptanceStates: this.state.acceptanceStates });
    this.state.acceptanceStates = bt.acceptanceStates;
    for (const t of bt.transitions) this._pushHistory({ type: 'acceptance', stepId: t.stepId, acceptance: t.acceptance });

    let blocked = false;
    let reason = null;
    let nextAction = null;
    let brainAcceptance;

    switch (control) {
      case 'PLAN':
        this.state.planRevision += 1;
        this.state.awaitingUser = false;
        brainAcceptance = 'pending';
        nextAction = 'task';
        break;

      case 'REPLAN':
        this.state.planRevision += 1;
        this.state.awaitingUser = false;
        brainAcceptance = 'pending';
        nextAction = 'replan_confirm';
        break;

      case 'TASK':
        this.state.awaitingUser = false;
        if (this.state.prevStepId) this.state.acceptanceStates[this.state.prevStepId] = 'accepted';
        brainAcceptance = this.state.acceptanceStates[this.state.stepId] || 'pending';
        nextAction = machineGate === 'pass' ? 'execute' : 'blocked_incomplete_acceptance';
        if (machineGate !== 'pass') { blocked = true; reason = 'machine gate not passed: incomplete acceptance evidence'; }
        break;

      case 'REVISE':
        this.state.awaitingUser = false;
        // REVISE keeps task/step identity. applyBrainAcceptanceTransition already
        // reopened invalidated acceptances; re-apply to surface reopen history.
        if (reviseDelta) {
          const rd = applyReviseDelta({ delta: reviseDelta, acceptanceStates: this.state.acceptanceStates });
          this.state.acceptanceStates = rd.acceptanceStates;
          for (const id of rd.reopened) this._pushHistory({ type: 'acceptance', stepId: id, acceptance: 'revise' });
        }
        brainAcceptance = 'pending';
        nextAction = 'revise_execute';
        break;

      case 'ASK_USER':
        this.state.awaitingUser = true;
        this.state.askUser = buildAskUserEnvelope({ whyBlocked, minimalUserAction, readOnly: true, expectedFields: expectedFields || [], question, resumeControlId });
        brainAcceptance = 'pending';
        nextAction = 'awaiting_user';
        blocked = true;
        reason = 'awaiting user decision';
        break;

      case 'PUBLISH':
        this.state.awaitingUser = false;
        if (!this.allowPublish) { blocked = true; reason = 'publish disabled'; nextAction = 'blocked_publish_disabled'; brainAcceptance = 'pending'; break; }
        if (machineGate !== 'pass') { blocked = true; reason = 'publication gate not satisfied: machine gate not passed'; nextAction = 'blocked_publication_gate'; brainAcceptance = 'pending'; break; }
        this.state.publishResult = publication || null;
        this.state.published = !!(publication && publication.ok);
        if (this.state.prevStepId) this.state.acceptanceStates[this.state.prevStepId] = 'accepted';
        brainAcceptance = 'accepted';
        nextAction = 'publication_ready';
        break;

      case 'DONE':
        this.state.awaitingUser = false;
        if (machineGate !== 'pass') { blocked = true; reason = 'DONE blocked: machine gate not passed'; nextAction = 'blocked_done'; brainAcceptance = 'pending'; break; }
        if (this.state.prevStepId) this.state.acceptanceStates[this.state.prevStepId] = 'accepted';
        const pub = publication || this.state.publishResult;
        if (pub && !publicationReadyForDone(pub)) { blocked = true; reason = 'DONE blocked: publication readiness not satisfied'; nextAction = 'blocked_done_publication'; brainAcceptance = 'pending'; break; }
        this.state.brainAcceptance = 'accepted';
        this.state.executorStatus = 'success';
        nextAction = 'done';
        break;

      default:
        brainAcceptance = 'pending';
        nextAction = 'none';
    }

    // Persist control: a blocked DONE never becomes terminal; every other control is
    // recorded as the active control.
    if (control === 'DONE') {
      if (!blocked) this.state.control = 'DONE';
    } else {
      this.state.control = control;
    }
    this.state.machineGate = machineGate;
    this.state.brainAcceptance = (control === 'DONE' && !blocked) ? 'accepted' : (brainAcceptance || 'pending');

    this._pushHistory({ control, blocked: !!blocked, reason, machineGate, nextAction });

    const handoff = this._buildHandoff(control, nextAction, blocked);
    return {
      ok: !blocked,
      accepted: !blocked,
      blocked: !!blocked,
      reason,
      control,
      taskId: this.state.taskId,
      stepId: this.state.stepId,
      route: this.state.route,
      localRoute: this.state.localRoute,
      machineGate,
      brainAcceptance: this.state.brainAcceptance,
      nextAction,
      handoff,
    };
  }

  _buildHandoff(control, nextAction, blocked) {
    return buildHandoff({
      taskId: this.state.taskId,
      stepId: this.state.stepId,
      control: this.state.control || control,
      route: this.state.route,
      localRoute: this.state.localRoute,
      acceptance: this.state.acceptance.map((a) => ({ id: a.id, required: a.required !== false })),
      evidenceSummary: this.state.evidence.map((e) => ({ acceptanceId: e.acceptanceId, status: e.status, kind: e.kind, summary: e.summary || null })),
      changed: this.state.changed,
      machineGate: this.state.machineGate,
      brainAcceptance: this.state.brainAcceptance,
      nextAction: blocked ? null : nextAction,
    });
  }

  status() {
    const acceptedSteps = Object.entries(this.state.acceptanceStates).filter(([, s]) => s === 'accepted').map(([id]) => id);
    return {
      taskId: this.state.taskId,
      stepId: this.state.stepId,
      control: this.state.control,
      route: this.state.route,
      localRoute: this.state.localRoute,
      machineGate: this.state.machineGate,
      brainAcceptance: this.state.brainAcceptance,
      awaitingUser: this.state.awaitingUser,
      published: this.state.published,
      planned: this.state.planRevision > 0,
      acceptedSteps,
      history: this.state.history.slice(-8),
    };
  }
}

export function createGovernanceService(opts) { return new GovernanceService(opts); }
export function governanceGateOk({ machineGate = 'pending', brainAcceptance = 'pending' } = {}) {
  return machineGate === 'pass' && brainAcceptance === 'accepted';
}
