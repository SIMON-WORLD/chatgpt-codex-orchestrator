// chatgpt-codex-orchestrator: TaskManager / lifecycle entry (Batch A, Gate B + D).
// startTask / resumeTask / getTaskStatus / cancelTask. Owns the task-state store and
// a resumable, idempotent engine that drives Brain <-> Codex, persists after every
// mutation, and never silently re-runs a confirmed side-effect.
import fs from 'node:fs';
import path from 'node:path';
import { newTaskState, saveState, loadState, addStep, findStep } from './task-state.js';
import { runtimePaths } from './runtime-paths.js';
import {
  parseBrainOutput, buildResult, resultToText, checkAcceptanceGate, registerAcceptances, applyEvidence,
  normalizeEvidence, parseEvidenceBlock,
} from './protocol.js';

const STEP_ID_PREFIX = 'step-';

export class TaskManager {
  constructor({ stateDir, dataStore = null }) {
    this.stateDir = stateDir || runtimePaths().tasks;
    this.dataStore = dataStore || { save: (s) => saveState(this.stateDir, s), load: (id) => loadState(this.stateDir, id) };
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  persist(state) { this.dataStore.save(state); }
  load(taskId) { return this.dataStore.load(taskId); }

  async startTask({ goal, repoDir, brain, executor, sessionFactory = null, maxRounds = Infinity, taskId, conversationMode = 'new', adopted = false }) {
    const state = newTaskState({ taskId, repoDir, goal, conversationMode, adopted });
    this.persist(state);
    const ctx = { brain, executor, sessionFactory };
    await this._engine(state, ctx, { maxRounds });
    return { taskId: state.taskId, state };
  }

  async resumeTask({ taskId, brain, executor, sessionFactory = null, maxRounds = Infinity }) {
    const state = this.load(taskId);
    if (state.status === 'completed' || state.status === 'cancelled') return { taskId, state, result: { done: true } };

    if (this._needsRecovery(state)) {
      state.status = 'recovery_required';
      this.persist(state);
      return { taskId, state, result: { done: false, recoveryRequired: true } };
    }

    const ctx = { brain, executor, sessionFactory };
    await this._engine(state, ctx, { maxRounds });
    return { taskId, state };
  }

  getTaskStatus(taskId) {
    const s = this.load(taskId);
    return { taskId, status: s.status, round: s.round, lastControl: s.lastControl };
  }

  async cancelTask(taskId) {
    const s = this.load(taskId);
    s.status = 'cancelled';
    this.persist(s);
    return { taskId, status: s.status };
  }

  // Evidence hardening (B3): only explicit evidence counts as pass. We never
  // auto-pass an acceptance merely because the codex process exited 0.
  _extractEvidence(step, res) {
    if (res && Array.isArray(res.evidence) && res.evidence.length) return res.evidence.map((e) => normalizeEvidence(e));
    const parsed = parseEvidenceBlock(res?.resultText || '');
    if (parsed.length) return parsed;
    return [];
  }
  // Parse a brain reply; if it is structurally invalid (e.g. missing instruction on
  // TASK/REVISE), send ONE schema-repair request to the SAME brain conversation and
  // re-parse. Never execute Codex until a valid control is obtained.
  async _parseOrRepair(state, ctx, replyText) {
    try { return parseBrainOutput(replyText).control; }
    catch (e) {
      const repair = 'Your previous response was invalid: it is missing the required "instruction" field. Respond with a single complete JSON object: {"control":"TASK"|"REVISE","stepId":"...","instruction":"<concise instruction>","acceptance":[{"id":"<id>","required":true,"text":"<acceptance text>"}]}. Preserve the original control/step intent. Do not execute any code.';
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

  // One bounded orchestration unit (turn-sliced). Delegates to _nextAction, which
  // makes exactly one durable transition. Returns true if the task should stop now.
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
      this.persist(state);
      return false;
    }

    const ctrl = state.pendingControl || { control: state.lastControl };
    const control = ctrl.control;
    if (control === 'DONE') return this._handleDone(state);
    if (control === 'ASK_USER') { state.status = 'awaiting_user'; this.persist(state); return true; }
    if (control === 'TASK' || control === 'REVISE') return this._handleTask(state, ctx, ctrl);
    state.status = 'recovery_required';
    this.persist(state);
    return true;
  }

  _handleDone(state) {
    const gate = checkAcceptanceGate(state.acceptanceRegistry);
    if (gate.allPass) { state.status = 'completed'; state.lastControl = 'DONE'; this.persist(state); return true; }
    state.status = 'awaiting_user';
    state.lastControl = 'DONE';
    state.acceptanceBlock = gate.failures.map((f) => ({ id: f.id, status: f.status, text: f.text }));
    this.persist(state);
    return true;
  }

  async _handleTask(state, ctx, ctrl) {
    const active = state.inFlightStep ? findStep(state, state.inFlightStep) : null;

    if (!active || active.status === 'reviewed') {
      const stepId = STEP_ID_PREFIX + (state.round + 1);
      const instruction = ctrl.instruction || ctrl.text || ctrl.directive || '';
      const acceptance = Array.isArray(ctrl.acceptance) ? ctrl.acceptance : [];
      addStep(state, { stepId, control: ctrl.control, instruction, acceptance, status: 'received' });
      state.inFlightStep = stepId;
      registerAcceptances(state, ctrl);
      this.persist(state);
      return false;
    }

    const step = active;
    if (step.status === 'received') {
      step.status = 'executing';
      this.persist(state);
      const evReq = (step.acceptance || []).map((a) => `acceptanceId="${a.id}"`).join(' ');
      const prompt = step.instruction + (evReq ? `\n\nWhen done, output a line starting with EVIDENCE: followed by a JSON array of {acceptanceId,status,kind,summary} for each of: ${evReq}.` : '');
      const res = await ctx.executor.execute(prompt);
      state.codexSessionId = res.sessionId || state.codexSessionId;
      step.result = res;
      step.status = 'executed';
      this.persist(state);
      return false;
    }
    if (step.status === 'executed') {
      const result = buildResult({
        stepId: step.stepId,
        status: resStatus(step.result),
        summary: step.result?.resultText || '',
        filesChanged: [],
        tests: [],
        evidence: this._extractEvidence(step, step.result),
        blockers: step.result?.error ? [step.result.error] : [],
      });
      step.resultObj = result;
      applyEvidence(state, result);
      step.status = 'result_recorded';
      this.persist(state);
      return false;
    }
    if (step.status === 'result_recorded' || step.status === 'result_sent') {
      if (step.status === 'result_recorded') step.status = 'result_sent';
      const replyRes = await ctx.brain.send(resultToText(step.resultObj));
      const parsed = await this._parseOrRepair(state, ctx, replyRes.reply);
      step.status = 'reviewed';
      if (!state.completedSteps.includes(step.stepId)) state.completedSteps.push(step.stepId);
      state.inFlightStep = null;
      state.round += 1;
      state.lastControl = parsed.control;
      state.pendingControl = parsed;
      this.persist(state);
      return false;
    }
    return false;
  }
}

function resStatus(res) {
  if (!res) return 'unknown';
  return res.success ? 'success' : 'failure';
}