// chatgpt-codex-orchestrator: Alpha.4 canonical Direct Brain Loop controller.
//
// This is the SINGLE executable entrypoint for the canonical Alpha.4 Direct
// Brain Loop. It owns exactly one runId / provider / DirectRunLedger /
// DirectRunCoordinator / DirectGovernance and enforces the protocol mechanics
// (takeover contract, canonical envelope extraction, one FORMAT_REPAIR, control
// identity + monotonic cursor, RESULT payloadHash, nonce send, Brain acceptance
// transition, resume/delivery recovery). The calling Codex agent provides only
// task execution + real evidence; it never reassembles protocol primitives.
//
// Canonical mode is 'direct-alpha4'. This module does NOT import or use the
// legacy TaskService / TaskManager / LoopController / worker-bootstrap path.

import path from 'node:path';
import {
  createDirectRunCoordinator,
  createDirectRunLedger,
  extractCanonicalEnvelope,
  validateStructuredEnvelope,
  formatRepairPrompt,
  buildTakeoverContract,
  applyBrainAcceptanceTransition,
  computePayloadHash,
  evaluateMilestoneAcceptance,
} from './protocol-integrity.js';
import {
  createDirectGovernance,
  createProofLedger,
  createDirectMetrics,
  buildBootstrapEvidence,
} from './direct-governance.js';
import {
  createChatGPTBrowserProvider,
  evaluatePublicationGate,
  evaluateDoneGate,
} from './direct-mode.js';
import { isTerminalControl } from './protocol.js';

export const DIRECT_ALPHA4_MODE = 'direct-alpha4';

// Runtime mode guard: any canonical Direct run must be in direct-alpha4 mode.
// Callers that try to drive the legacy TaskService/LoopController path from this
// entrypoint are rejected.
export function assertDirectAlpha4Mode(mode) {
  if (mode !== DIRECT_ALPHA4_MODE) {
    throw new Error(`[direct-alpha4] invalid mode '${mode}'; expected '${DIRECT_ALPHA4_MODE}'`);
  }
}

// Create the canonical Direct run controller. `provider` is injectable so an
// offline/scripted Brain can drive the protocol deterministically (tests), while
// the real runtime omits it and gets the built-in ChatGPT browser provider.
export function createDirectRun({ runId = null, dataRoot = null, repoDir = null, provider = null, turnOptions = {} } = {}) {
  const rid = runId || ('run-' + Date.now());
  const ledger = createDirectRunLedger({ dataRoot, runId: rid });
  if (typeof ledger.load === 'function') { try { ledger.load(); } catch {} }
  const coordinator = createDirectRunCoordinator({ runId: rid, ledger });
  const gov = createDirectGovernance({ proofLedger: createProofLedger(), metrics: createDirectMetrics() });
  const metrics = gov.state.metrics;
  const providerInstance = provider || createChatGPTBrowserProvider({ turnOptions });
  const ledgerPath = dataRoot ? path.join(dataRoot, 'direct-runs', rid + '.json') : null;

  const ctl = {
    mode: DIRECT_ALPHA4_MODE,
    runId: rid,
    repoDir: repoDir || null,
    dataRoot: dataRoot || null,
    provider: providerInstance,
    ledger,
    coordinator,
    governance: gov,
    orchestratorHead: null,
    lastStepId: null,
    frozenResult: null,
    pendingResult: null,
    deliveredResultId: null,
    // Canonical run metrics: governance metrics + coordinator-level counts.
    metrics() {
      const m = metrics.snapshot();
      const cm = coordinator.metrics();
      return { ...m, coordinator: cm };
    },

    // Compact, self-reporting runtime provenance (diagnostics only; no prompts/secrets).
    statusPacket() {
      assertDirectAlpha4Mode(ctl.mode);
      return {
        mode: ctl.mode,
        orchestratorHead: ctl.orchestratorHead || null,
        runId: rid,
        conversationId: ledger.state.conversationId || null,
        conversationUrl: ledger.state.conversationUrl || null,
        ledgerPath,
      };
    },

    setOrchestratorHead(head) { ctl.orchestratorHead = head; },

    // FIRST TURN: build dynamic takeover + bootstrap, send, extract/validate the
    // first Brain reply (one FORMAT_REPAIR allowed), accept the control, persist.
    async start({ goal = null, gitRun = null, bootstrap = null, allowRepair = true } = {}) {
      const takeover = buildTakeoverContract({ runId: rid });
      let b = bootstrap;
      if (b == null && repoDir) b = buildBootstrapEvidence({ repoDir, gitRun });
      const bText = b == null ? '' : (typeof b === 'string' ? b : JSON.stringify(b));
      const msg = [takeover, bText, goal ? ('Goal: ' + goal) : ''].filter(Boolean).join('\n\n');
      const first = await ctl.provider.send(msg, { nonce: 'takeover-' + rid });
      metrics.set('timeToFirstBrainControl', Date.now() - metrics.data.startedAt);
      if (first && first.conversationId) {
        ledger.state.conversationId = first.conversationId;
        ledger.state.conversationUrl = first.conversationUrl || null;
        ledger.persist();
      }
      const res = await ctl.acceptBrainReply(first && first.reply, { allowRepair });
      return { ...res, firstReply: first };
    },

    // Adopt an existing ChatGPT conversation (no new conversation created).
    async adoptConversation({ conversationUrl = null, conversationId = null, title = null } = {}) {
      const identity = await ctl.provider.adoptConversation({ conversationUrl, conversationId, title });
      ledger.state.conversationId = identity.conversationId;
      ledger.state.conversationUrl = identity.conversationUrl;
      ledger.persist();
      return identity;
    },

    // NEXT CONTROL: extract the canonical envelope, validate, send ONE FORMAT_REPAIR
    // if necessary (then fail closed), accept the control (monotonic sequence, one
    // outstanding, stale/acked validation), apply the deterministic Brain acceptance
    // transition for the prior milestone, persist.
    async acceptBrainReply(reply, { allowRepair = true, repairControlId = null } = {}) {
      let env = extractCanonicalEnvelope(reply);
      let v = validateStructuredEnvelope(env);
      if (!v.ok) {
        if (!allowRepair) return { ok: false, error: 'invalid envelope', errors: v.errors };
        metrics.bump('protocolRepairCount');
        const tc = repairControlId || coordinator.state.lastAcceptedControlId;
        const repairPrompt = formatRepairPrompt({ runId: rid, controlId: tc });
        const rr = await ctl.provider.send(repairPrompt, { nonce: 'repair-' + rid + '-' + Date.now() });
        env = extractCanonicalEnvelope(rr && rr.reply);
        v = validateStructuredEnvelope(env);
        if (!v.ok) return { ok: false, error: 'invalid envelope after one FORMAT_REPAIR', errors: v.errors };
      }
      metrics.bump('brainTurns');
      const accepted = coordinator.acceptControl(env);
      if (!accepted.ok) { metrics.bump('staleControlRejectedCount'); return { ok: false, reason: accepted.reason }; }
      const acc = applyBrainAcceptanceTransition({
        control: env.control,
        prevStepId: ctl.lastStepId,
        reviseDelta: env.reviseDelta,
        acceptanceStates: gov.state.brainAcceptance,
      });
      gov.state.brainAcceptance = acc.acceptanceStates;
      ledger.state.brainAcceptance = acc.acceptanceStates;
      if (env.control === 'TASK') metrics.bump('taskCount');
      else if (env.control === 'REVISE') metrics.bump('reviseCount');
      else if (env.control === 'REPLAN') metrics.bump('replanCount');
      else if (env.control === 'ASK_USER') metrics.bump('askUserCount');
      else if (env.control === 'PUBLISH') metrics.bump('publishCount');
      ctl.lastStepId = env.stepId;
      ledger.persist();
      return { ok: true, control: env, sequence: accepted.sequence, brainAcceptance: acc.acceptanceStates, transitions: acc.transitions };
    },
    // RESULT TURN: semantic result -> governance.transition ONCE -> machineGate ->
    // stable resultId -> computePayloadHash -> coordinator.recordResult (verifies
    // hash, no send before ok) -> persist frozen RESULT -> JSON serialization.
    prepareResult({ stepId = null, executorStatus = 'success', changed = [], evidence = [], blockers = [] } = {}) {
      const outstanding = coordinator.state.outstandingControlId;
      const ctrl = coordinator.state.controls[outstanding];
      const seq = ctrl ? ctrl.sequence : (coordinator.state.lastAcceptedSequence + 1);
      const sid = stepId || (ctrl ? ctrl.stepId : ctl.lastStepId);
      const machine = gov.transition({ stepId: sid, acceptance: ctrl ? ctrl.acceptance : [], result: { changed, evidence } });
      const machineGate = machine.gate.ok ? 'pass' : 'fail';
      const resultId = 'r' + seq;
      const result = {
        runId: rid, resultId, inReplyToControlId: outstanding, sequence: seq, stepId: sid,
        executorStatus, machineGate, changed, evidence, blockers,
      };
      result.payloadHash = computePayloadHash(result);
      const rec = coordinator.recordResult(result);
      if (!rec.ok) { metrics.bump('staleControlRejectedCount'); return { ok: false, reason: rec.reason, machineGate }; }
      ledger.persist();
      ctl.frozenResult = result;
      ctl.deliveredResultId = null;
      return { ok: true, result, machineGate, machine, serialized: JSON.stringify(result) };
    },

    // Send the frozen RESULT as a STRING with a correlation nonce. On provider/
    // composer uncertainty keep the SAME frozen resultId + payloadHash for recovery.
    async sendResult({ serialized = null } = {}) {
      const result = ctl.frozenResult;
      if (!result) return { ok: false, reason: 'no frozen result; call prepareResult first' };
      const text = serialized || JSON.stringify(result);
      try {
        const r = await ctl.provider.send(text, { nonce: 'r-' + rid + '-' + result.resultId });
        ctl.deliveredResultId = result.resultId;
        return { ok: true, resultId: result.resultId, reply: (r && r.reply) || null };
      } catch (e) {
        metrics.bump('deliveryAckTimeoutCount');
        ctl.pendingResult = result;
        return { ok: false, reason: String((e && e.message) || e), pending: true, resultId: result.resultId };
      }
    },

    // Resume from the DirectRunLedger: reopen the SAME conversation binding, recover
    // the current run/control/result cursor, and retransmit the SAME frozen
    // resultId + payloadHash only when it was sent but not yet acknowledged.
    // Bounded canonical recovery; do not fall back to user click/paste first.
    async resume({ provider = null, reopen = true } = {}) {
      if (provider) ctl.provider = provider;
      gov.state.brainAcceptance = ledger.state.brainAcceptance || {};
      const lastCtl = coordinator.state.controls[coordinator.state.lastAcceptedControlId];
      ctl.lastStepId = lastCtl ? lastCtl.stepId : null;
      if (reopen && ledger.state.conversationId && ctl.provider && typeof ctl.provider.resume === 'function') {
        try {
          await ctl.provider.resume({ tabId: null, conversationId: ledger.state.conversationId, conversationUrl: ledger.state.conversationUrl });
        } catch { /* provider may need a fresh open; leave bounded */ }
      }
      const sent = coordinator.state.lastSentResultId;
      const acked = coordinator.state.acknowledgedResultIds || [];
      if (sent && !acked.includes(sent) && coordinator.state.results[sent]) {
        const stored = coordinator.state.results[sent];
        metrics.bump('resultRetransmitCount');
        ctl.frozenResult = stored;
        coordinator.retransmit({ resultId: stored.resultId, payloadHash: stored.payloadHash });
        try {
          const r = await ctl.provider.send(JSON.stringify(stored), { nonce: 'r-' + rid + '-' + stored.resultId });
          ctl.deliveredResultId = stored.resultId;
          return { ok: true, retransmitted: true, resultId: stored.resultId, reply: (r && r.reply) || null };
        } catch (e) {
          metrics.bump('deliveryAckTimeoutCount');
          ctl.pendingResult = stored;
          return { ok: false, retransmitted: true, resultId: stored.resultId, reason: String((e && e.message) || e), pending: true };
        }
      }
      return { ok: true, retransmitted: false, lastAcceptedSequence: coordinator.state.lastAcceptedSequence, outstandingControlId: coordinator.state.outstandingControlId, lastSentResultId: sent };
    },

    // Publication / terminal gates are controller-owned decisions; the caller runs
    // the publication transaction mechanics (git commit/push) under these gates.
    publicationGate(opts = {}) { return evaluatePublicationGate(opts); },
    doneGate(opts = {}) { return evaluateDoneGate(opts); },
    isTerminal(control) { return isTerminalControl(control); },
    setBrainAcceptance({ stepId, acceptance }) { return gov.setBrainAcceptance({ stepId, acceptance }); },
    machineGateStatus() { return gov.machineGateStatus(); },
    evaluateMilestoneAcceptance(opts) { return evaluateMilestoneAcceptance(opts); },
  };
  return ctl;
}
