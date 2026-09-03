// LEGACY / EXPERIMENTAL RUNTIME: this module is NOT on the canonical Direct Brain Loop\n// path. The default \\-command\ uses the current Codex agent + built-in browser\n// (see src/legacy/direct-mode.js). Retained for compatibility/experimental use only.\n// chatgpt-codex-orchestrator: TaskManager / lifecycle entry (Batch A, Gate B + D).
// startTask / resumeTask / getTaskStatus / cancelTask. Owns the task-state store and
// a resumable, idempotent engine that drives Brain <-> Codex, persists after every
// mutation, and never silently re-runs a confirmed side-effect.
// Alpha.2: PLAN / REPLAN are Brain -> Orchestrator control/state operations (not
// forwarded to Codex); PLAN stepId is the canonical orchestration step identity;
// normal TASK/RESULT are compact by default; reviewed steps compact into durable
// stepSummaries; verification tiers + 2-REVISE escalation; verification commands
// are resolved and injected per step boundary from the verification policy.
import fs from 'node:fs';
import path from 'node:path';
import {
  newTaskState, saveState, loadState, addStep, findStep, setStepStatus, compactStep,
  bumpReviseRetries, resetReviseRetries, defaultVerificationPolicy,
} from '../task-state.js';
import { runtimePaths } from '../runtime-paths.js';
import {
  parseBrainOutput, buildResult, resultToText, checkAcceptanceGate, registerAcceptances, applyEvidence,
  normalizeEvidence, parseEvidenceBlock, buildCompactTask, buildFullTaskPacket, packetSize, ProtocolError,
} from '../protocol.js';
import { buildVerificationPlan, resolveVerificationCommands, resolveVerificationLevel, isDocOnlyStep, assertMandatoryVerification } from '../verification.js';

const STEP_ID_PREFIX = 'step-';

export class TaskManager {
  constructor({ stateDir, dataStore = null }) {
    this.stateDir = stateDir || runtimePaths().tasks;
    this.dataStore = dataStore || { save: (s) => saveState(this.stateDir, s), load: (id) => loadState(this.stateDir, id) };
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  async persist(state) { await this.dataStore.save(state); }
  async load(taskId) { return await this.dataStore.load(taskId); }

  async startTask({ goal, repoDir, brain, executor, sessionFactory = null, maxRounds = Infinity, taskId, conversationMode = 'new', adopted = false }) {
    const state = newTaskState({ taskId, repoDir, goal, conversationMode, adopted });
    await this.persist(state);
    const ctx = { brain, executor, sessionFactory };
    await this._engine(state, ctx, { maxRounds });
    return { taskId: state.taskId, state };
  }

  async resumeTask({ taskId, brain, executor, sessionFactory = null, maxRounds = Infinity }) {
    const state = await this.load(taskId);
    if (state.status === 'completed' || state.status === 'cancelled') return { taskId, state, result: { done: true } };

    if (this._needsRecovery(state)) {
      state.status = 'recovery_required';
      await this.persist(state);
      return { taskId, state, result: { done: false, recoveryRequired: true } };
    }

    const ctx = { brain, executor, sessionFactory };
    await this._engine(state, ctx, { maxRounds });
    return { taskId, state };
  }

  async getTaskStatus(taskId) {
    const s = await this.load(taskId);
    return { taskId, status: s.status, round: s.round, lastControl: s.lastControl };
  }

  async cancelTask(taskId) {
    const s = await this.load(taskId);
    s.status = 'cancelled';
    await this.persist(s);
    return { taskId, status: s.status };
  }

  // Evidence hardening (B3): only explicit evidence counts as pass.
  _extractEvidence(step, res) {
    if (res && Array.isArray(res.evidence) && res.evidence.length) return res.evidence.map((e) => normalizeEvidence(e));
    const parsed = parseEvidenceBlock(res?.resultText || '');
    if (parsed.length) return parsed;
    return [];
  }
  // Parse a brain reply; if it is structurally invalid, send ONE schema-repair
  // request to the same brain conversation and re-parse.
  async _parseOrRepair(state, ctx, replyText) {
    try { return parseBrainOutput(replyText).control; }
    catch (e) {
      const repair = 'Your previous response was invalid: it is missing a required field. Respond with a single complete JSON object: {"control":"TASK"|"REVISE"|"ASK_USER"|"DONE"|"PLAN"|"REPLAN","stepId":"...","instruction":"...","acceptance":[...]}. Preserve the original control/step intent. Do not execute any code.';
      const r2 = await ctx.brain.send(repair);
      return parseBrainOutput(r2.reply).control; // throws if still invalid
    }
  }
  _needsRecovery(state) {
    const st = state.inFlightStep ? findStep(state, state.inFlightStep) : null;
    // Only an 'executing' step may have produced an unconfirmed side effect; a freshly created ('received') step is safe to run.
    return st && st.status === 'executing';
  }

  async _bindBrain(brain, sessionFactory, state) {
    if (state.conversationId && state.ownedTabId && typeof sessionFactory === 'function') {
      return await sessionFactory({ tabId: state.ownedTabId, conversationId: state.conversationId, conversationUrl: state.conversationUrl });
    }
    return brain;
  }

  async advanceOne(state, ctx) { return this._nextAction(state, ctx); }

  async _engine(state, ctx, { maxRounds } = {}) {
    ctx.brain = await this._bindBrain(ctx.brain, ctx.sessionFactory, state);
    let guard = 0;
    while (guard++ < 2000) {
      if (state.status === 'completed' || state.status === 'cancelled' || state.status === 'recovery_required') break;
      if (state.round >= maxRounds) break;
      const stop = await this._nextAction(state, ctx);
      if (stop) break;
    }
    return { done: state.status === 'completed' };
  }

  async _nextAction(state, ctx) {
    // 1) no conversation yet -> send goal
    if (!state.conversationId) {
      const r = await ctx.brain.send(state.goal);
      state.conversationId = r.conversationId || ctx.brain.conversationId;
      state.conversationUrl = r.conversationUrl || ctx.brain.conversationUrl;
      state.ownedTabId = ctx.brain.ownedTabId;
      const parsed = await this._parseOrRepair(state, ctx, r.reply);
      state.lastControl = parsed.control;
      state.pendingControl = parsed;
      if (!state.metrics) state.metrics = {};
      state.metrics.firstValidPlanTaskAt = Date.now();
      state.metrics.bootstrapToolCount = (state.metrics.bootstrapToolCount || 0) + 1;
      state.metrics.broadDiscoveryOccurred = false;
      await this.persist(state);
      return false;
    }

    const ctrl = state.pendingControl || { control: state.lastControl };
    const control = ctrl.control;
    if (control === 'DONE') return this._handleDone(state);
    if (control === 'ASK_USER') { state.status = 'awaiting_user'; await this.persist(state); return true; }
    if (control === 'PLAN') return this._handlePlan(state, ctx, ctrl);
    if (control === 'REPLAN') return this._handleReplan(state, ctx, ctrl);
    if (control === 'TASK' || control === 'REVISE') return this._handleTask(state, ctx, ctrl);
    state.status = 'recovery_required';
    await this.persist(state);
    return true;
  }

  async _handleDone(state) {
    const gate = checkAcceptanceGate(state.acceptanceRegistry);
    if (gate.allPass) {
      const blocks = this._mandatoryVerificationBlocked(state);
      if (!blocks.length) { state.status = 'completed'; state.lastControl = 'DONE'; await this.persist(state); return true; }
      state.status = 'awaiting_user';
      state.lastControl = 'DONE';
      state.verificationBlock = blocks;
      await this.persist(state);
      return true;
    }
    state.status = 'awaiting_user';
    state.lastControl = 'DONE';
    state.acceptanceBlock = gate.failures.map((f) => ({ id: f.id, status: f.status, text: f.text }));
    await this.persist(state);
    return true;
  }

  // A mandatory milestone/final boundary that has no completed steps blocks DONE:
  // the required verification must actually run and produce evidence, not be skipped.
  _mandatoryVerificationBlocked(state) {
    const plan = state.plan;
    if (!plan || !Array.isArray(plan.milestones) || !Array.isArray(plan.steps)) return [];
    const completed = new Set(state.completedSteps || []);
    const blocks = [];
    for (const m of plan.milestones) {
      if (m.verification !== 'milestone' && m.verification !== 'final') continue;
      const stepsInM = plan.steps.filter((s) => s.milestoneId === m.milestoneId);
      const missing = stepsInM.filter((s) => !completed.has(s.stepId));
      if (missing.length) {
        blocks.push({ milestoneId: m.milestoneId, verification: m.verification, missingSteps: missing.map((s) => s.stepId) });
      }
    }
    return blocks;
  }

  // PLAN applies the contract + plan + verificationPolicy, builds a bounded
  // repoContext, then requests the next concrete control. It is NOT forwarded to Codex.
  async _handlePlan(state, ctx, ctrl) {
    if (ctrl.taskContract) state.taskContract = ctrl.taskContract;
    if (ctrl.plan) state.plan = ctrl.plan;
    if (ctrl.verificationPolicy) state.verificationPolicy = { ...defaultVerificationPolicy(), ...ctrl.verificationPolicy };
    if (ctrl.taskContract && ctrl.taskContract.verificationPolicyRef) state.projectProfileRef = ctrl.taskContract.verificationPolicyRef;
    state.repoContext = await this._buildRepoContext(state);
    state.currentStepId = null;
    state.status = 'running';
    state.lastControl = 'PLAN';
    await this.persist(state);
    await this._requestNextControl(state, ctx);
    return false;
  }

  async _handleReplan(state, ctx, ctrl) {
    if (ctrl.taskContractPatch) state.taskContract = { ...(state.taskContract || {}), ...ctrl.taskContractPatch };
    else if (ctrl.taskContract) state.taskContract = ctrl.taskContract;
    if (ctrl.planPatch) state.plan = { ...(state.plan || {}), ...ctrl.planPatch };
    else if (ctrl.plan) state.plan = ctrl.plan;
    if (ctrl.verificationPolicy) state.verificationPolicy = { ...defaultVerificationPolicy(), ...ctrl.verificationPolicy };
    state.repoContext = await this._buildRepoContext(state);
    state.currentStepId = null;
    state.lastControl = 'REPLAN';
    await this.persist(state);
    await this._requestNextControl(state, ctx);
    return false;
  }

  async _requestNextControl(state, ctx) {
    if (!ctx.brain) return;
    const prompt = 'Plan registered. Send the next control as a single JSON object: {"control":"TASK"|"REVISE"|"ASK_USER"|"DONE", ...}. If no remaining work, send {"control":"DONE"}. Do not repeat the full plan.';
    const r = await ctx.brain.send(prompt);
    const parsed = await this._parseOrRepair(state, ctx, r.reply);
    state.lastControl = parsed.control;
    state.pendingControl = parsed;
    await this.persist(state);
  }

  // --- Plan step identity (canonical stepId) -----------------------------------
  _findPlanStep(state, stepId) {
    if (!state.plan || !Array.isArray(state.plan.steps)) return null;
    return state.plan.steps.find((s) => s.stepId === stepId) || null;
  }

  _nextPendingPlanStepId(state) {
    const plan = state.plan;
    if (!plan || !Array.isArray(plan.steps)) return null;
    const done = new Set(state.completedSteps || []);
    const pending = plan.steps.find((s) => !done.has(s.stepId));
    return pending ? pending.stepId : null;
  }

  // Deterministically resolve the canonical step identity + milestone for a control.
  // PLAN stepId is authoritative. If a planned step cannot be resolved to a declared
  // milestone where the plan is milestone-based, surface a deterministic ProtocolError
  // rather than guessing the first milestone.
  _resolveStepIdentity(state, ctrl) {
    const plan = state.plan;
    const planMode = !!(plan && Array.isArray(plan.steps) && plan.steps.length);
    if (!planMode) {
      return { stepId: STEP_ID_PREFIX + (state.round + 1), planMode: false, milestoneId: null, milestone: null };
    }
    let stepId = null;
    if (ctrl.stepId) {
      // An explicit stepId is authoritative: it must be a declared plan step.
      if (this._findPlanStep(state, ctrl.stepId)) stepId = ctrl.stepId;
      else throw new ProtocolError(`PLAN step ${ctrl.stepId} is not a declared step in the plan`);
    } else if (state.currentStepId && this._findPlanStep(state, state.currentStepId)) {
      stepId = state.currentStepId;
    } else {
      stepId = this._nextPendingPlanStepId(state);
    }
    if (!stepId) {
      throw new ProtocolError(`PLAN step not resolvable for control ${ctrl.control}: ctrl.stepId=${ctrl.stepId} currentStepId=${state.currentStepId}`);
    }
    const planStep = this._findPlanStep(state, stepId);
    const milestoneId = (planStep && planStep.milestoneId) || null;
    const milestones = (plan && Array.isArray(plan.milestones)) ? plan.milestones : [];
    if (milestones.length && !milestoneId) {
      // Milestone-based plan: a step MUST resolve to a declared milestone.
      throw new ProtocolError(`PLAN step ${stepId} has no declared milestone`);
    }
    const milestone = (milestoneId && milestones.find((m) => m.milestoneId === milestoneId)) || null;
    return { stepId, planMode: true, milestoneId, milestone };
  }

  // A milestone/final boundary declared on the plan step's milestone is a mandatory
  // orchestrator boundary that cannot be silently downgraded.
  _stepMandatoryLevel(state, milestone) {
    if (!milestone) return null;
    const mv = milestone.verification;
    if (mv === 'milestone' || mv === 'final') return mv;
    return null;
  }

  _stepVerificationLevel(ctrl, state, step = null) {
    const base = (ctrl.verification && ctrl.verification.level) || (state.verificationPolicy && state.verificationPolicy.defaultLevel) || 'step';
    return resolveVerificationLevel({ policy: state.verificationPolicy, requested: base, docOnly: isDocOnlyStep(step) });
  }

  _verificationCommands(state, level, commandsOverride = null) {
    const sources = commandsOverride || (state.repoContext && state.repoContext.verificationCommands) || (state.verificationPolicy && state.verificationPolicy.commands);
    return resolveVerificationCommands({ level, policy: state.verificationPolicy, commands: sources });
  }

  _recordMetrics(state, packet, escalate, vp) {
    if (!state.metrics) state.metrics = {};
    state.metrics.stepPacketBytes = packetSize(packet);
    state.metrics.stepPacketEscalated = escalate;
    if (vp.fullSuite) state.metrics.fullSuiteVerificationCount = (state.metrics.fullSuiteVerificationCount || 0) + 1;
  }

  // Resolve the effective verification level + commands for the current step. The
  // orchestrator resolves commands relevant to the step/boundary ONLY (never the
  // whole policy every turn). Mandatory milestone/final boundaries always carry
  // their commands into the packet so required verification cannot silently disappear.
  _resolveVerificationForStep(state, ctrl, stepId, milestone) {
    const mandatory = this._stepMandatoryLevel(state, milestone);
    const requested = (ctrl.verification && ctrl.verification.level) || (state.verificationPolicy && state.verificationPolicy.defaultLevel) || 'step';
    const docOnly = isDocOnlyStep(milestone || {});
    const vp = buildVerificationPlan({ policy: state.verificationPolicy, requested, mandatory, docOnly });
    const commands = this._verificationCommands(state, vp.level);
    return { vp, mandatory, requested, commands, level: vp.level };
  }

  _buildVerificationDirective(level, commands) {
    const verification = {};
    if (level) verification.level = level;
    if (commands && commands.length) verification.commands = commands;
    return verification;
  }

  async _buildRepoContext(state) {
    try {
      const { PacketContextProvider } = await import('./context-provider.js');
      const p = new PacketContextProvider({ repoDir: state.repoDir, maxBytes: 4000, maxFiles: 8 });
      const pk = p.buildPacket();
      return {
        repoDir: state.repoDir,
        snapshotAt: new Date().toISOString(),
        gitStatus: pk.gitStatus || '',
        gitDiff: pk.gitDiff || '',
        repoMap: (pk.repoMap || []).slice(0, 8),
        fileSnippets: (pk.fileSnippets || []).slice(0, 4),
        truncated: !!pk.truncated,
        providers: (pk.provenance && pk.provenance.providers) || [],
      };
    } catch (e) {
      return { repoDir: state.repoDir, snapshotAt: new Date().toISOString(), error: e.message };
    }
  }

  async _handleTask(state, ctx, ctrl) {
    const { stepId, planMode, milestoneId, milestone } = this._resolveStepIdentity(state, ctrl);
    const active = state.inFlightStep ? findStep(state, state.inFlightStep) : null;
    const existing = planMode ? findStep(state, stepId) : null;

    // Creating or re-opening a step is the only place where REVISE retries are
    // counted and where the (compact or escalated) packet is built. This applies
    // when there is no active step, the active step is already reviewed, OR a
    // reviewed plan step is being re-issued. It must NOT swallow an in-flight
    // (received/executing/...) step in the legacy no-PLAN path.
    const shouldStartOrReopen = (!active || active.status === 'reviewed') || (existing && existing.status === 'reviewed');
    if (shouldStartOrReopen) {
      return this._startOrReopenStep(state, ctx, ctrl, { stepId, planMode, milestoneId, milestone, active, existing });
    }

    const step = active;
    if (step.status === 'received') {
      step.status = 'executing';
      await this.persist(state);
      const evReq = (step.acceptance || []).map((a) => `acceptanceId="${a.id}"`).join(' ');
      let prompt = step.instruction + (evReq ? `\n\nWhen done, output a line starting with EVIDENCE: followed by a JSON array of {acceptanceId,status,kind,summary} for each of: ${evReq}.` : '');
      if (step.verification && Array.isArray(step.verification.commands) && step.verification.commands.length) {
        prompt += `\n\nRun the following verification for this ${step.verification.level} boundary and include the outcome in your EVIDENCE:\n` + step.verification.commands.map((c) => `- ${c}`).join('\n');
      }
      const res = await ctx.executor.execute(prompt);
      state.codexSessionId = res.sessionId || state.codexSessionId;
      step.result = res;
      step.status = 'executed';
      await this.persist(state);
      return false;
    }
    if (step.status === 'executed') {
      const result = buildResult({
        stepId: step.stepId,
        status: resStatus(step.result),
        summary: step.result?.resultText || '',
        changed: [],
        filesChanged: [],
        tests: [],
        evidence: this._extractEvidence(step, step.result),
        blockers: step.result?.error ? [step.result.error] : [],
      });
      step.resultObj = result;
      applyEvidence(state, result); // appends to evidenceLedger + updates acceptanceRegistry
      if (state.repoContext) { state.repoContext.lastResultChanged = result.changed || []; state.repoContext.lastResultAt = new Date().toISOString(); }
      if (!state.metrics) state.metrics = {};
      state.metrics.resultPacketBytes = packetSize(result);
      step.status = 'result_recorded';
      await this.persist(state);
      return false;
    }
    if (step.status === 'result_recorded' || step.status === 'result_sent') {
      if (step.status === 'result_recorded') step.status = 'result_sent';
      const replyRes = await ctx.brain.send(resultToText(step.resultObj));
      const parsed = await this._parseOrRepair(state, ctx, replyRes.reply);
      setStepStatus(state, step.stepId, 'reviewed'); // triggers completedSteps + compactStep
      state.inFlightStep = null;
      state.round += 1;
      state.lastControl = parsed.control;
      state.pendingControl = parsed;
      state.currentStepId = null;
      await this.persist(state);
      return false;
    }
    return false;
  }

  // Start a fresh step or re-open a reviewed plan step. Returns false (continue).
  async _startOrReopenStep(state, ctx, ctrl, { stepId, planMode, milestoneId, milestone, active, existing }) {
    const isRevise = ctrl.control === 'REVISE';
    let reviseCount;
    if (isRevise) {
      reviseCount = (existing && existing.reviseCount) ? existing.reviseCount + 1 : (state.reviseRetries || 0) + 1;
      if (existing) existing.reviseCount = reviseCount; else bumpReviseRetries(state);
    } else {
      reviseCount = 0;
      if (existing) existing.reviseCount = 0; else resetReviseRetries(state);
    }
    const escalate = isRevise && reviseCount >= 2;

    const instruction = ctrl.instruction || ctrl.text || ctrl.directive || '';
    const acceptance = Array.isArray(ctrl.acceptance) ? ctrl.acceptance : [];
    const { vp, commands, level: effectiveLevel } = this._resolveVerificationForStep(state, ctrl, stepId, milestone);
    // Mandatory milestone/final boundaries require executable configured commands.
    assertMandatoryVerification({ level: effectiveLevel, commands });
    const verification = this._buildVerificationDirective(effectiveLevel, commands);

    const packet = escalate
      ? buildFullTaskPacket({ stepId, instruction, acceptance, taskContract: state.taskContract, plan: state.plan, verificationPolicy: state.verificationPolicy, verificationCommands: commands, milestoneId, verification })
      : buildCompactTask({ stepId, instruction, acceptance, verificationLevel: effectiveLevel, defaultLevel: state.verificationPolicy?.defaultLevel || 'step', verificationCommands: commands, verification });

    if (existing && existing.status === 'reviewed') {
      Object.assign(existing, {
        control: ctrl.control, instruction, acceptance, status: 'received',
        receivedAt: new Date().toISOString(), reviseCount, milestoneId, verification,
      });
      state.inFlightStep = stepId;
      state.currentStepId = stepId;
      registerAcceptances(state, ctrl);
      this._recordMetrics(state, packet, escalate, vp);
      await this.persist(state);
      return false;
    }

    if (!active || active.status === 'reviewed') {
      addStep(state, {
        stepId, control: ctrl.control, instruction, acceptance, status: 'received',
        reviseCount, milestoneId, verification,
      });
      state.inFlightStep = stepId;
      state.currentStepId = stepId;
      registerAcceptances(state, ctrl);
      this._recordMetrics(state, packet, escalate, vp);
      await this.persist(state);
      return false;
    }
    return false;
  }

}

function resStatus(res) {
  if (!res) return 'unknown';
  return res.success ? 'success' : 'failure';
}
