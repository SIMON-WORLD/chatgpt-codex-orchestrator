// chatgpt-codex-orchestrator: Alpha.4 canonical Direct Brain Loop controller.
//
// This is the SINGLE executable entrypoint for the canonical Alpha.4 Direct
// Brain Loop. It owns exactly one runId / provider / DirectRunLedger /
// DirectRunCoordinator / DirectGovernance and enforces the protocol mechanics
// (takeover contract, canonical envelope extraction, one FORMAT_REPAIR, control
// identity + monotonic cursor, RESULT payloadHash, nonce send, mandatory
// piggyback ACK, Brain acceptance transition, resume/delivery recovery). The
// calling Codex agent provides only task execution + real evidence; it never
// reassembles protocol primitives.
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
  // Exactly one browser-bound provider session per run.
  let providerSessionOpen = false;

  // Controller-owned advancement authority gate (single equivalent of
  // evaluateMilestoneAcceptance). A prior milestone may only become Brain-accepted
  // when: there is a prior RESULT for that step, its executorStatus === success
  // AND machineGate === pass, and the next advancement control correctly
  // acknowledges that RESULT via ackResultId. REVISE / ASK_USER / PLAN / REPLAN
  // never silently accept a failed/unacknowledged milestone.
  function advancementGate(env) {
    const advance = ['TASK', 'PUBLISH', 'DONE'].includes(env.control);
    const prevResultId = coordinator.state.lastSentResultId;
    const prevResult = prevResultId ? coordinator.state.results[prevResultId] : null;
    // Mandatory piggyback ACK: if a RESULT was sent and is not yet acknowledged,
    // ANY next Brain control (PLAN/TASK/REVISE/REPLAN/ASK_USER/PUBLISH/DONE) must
    // ackResultId the last sent RESULT. This closes delivery for every lifecycle,
    // not only advancement controls, and rejects wrong/missing ACK.
    if (prevResultId && prevResult && env.ackResultId !== prevResultId) {
      return {
        advance, priorAccepted: false, protocolFailure: true,
        reason: 'next control must piggyback ackResultId equal to the last sent RESULT',
        expectedAckResultId: prevResultId, got: env.ackResultId || null, resultId: prevResultId,
      };
    }
    if (!advance) {
      // REVISE / ASK_USER / PLAN / REPLAN: a correct ACK proves delivery; they never
      // silently accept a failed/unacknowledged prior milestone.
      return { advance: false, priorAccepted: false, protocolFailure: false };
    }
    if (!prevResultId || !prevResult) {
      // First actionable control: nothing prior to advance.
      return { advance: true, priorAccepted: false, protocolFailure: false };
    }
    // Advancement: prior RESULT must be genuinely acceptable (success + pass). A
    // correct ACK does NOT by itself make the prior milestone accepted.
    const authoritative = evaluateMilestoneAcceptance({
      executorStatus: prevResult.executorStatus,
      machineGate: prevResult.machineGate,
      brainAcceptance: 'accepted',
    });
    if (!authoritative.accepted) {
      return {
        advance: true, priorAccepted: false, protocolFailure: true,
        reason: 'prior RESULT not acceptable for advancement (executorStatus != success or machineGate != pass)',
        resultId: prevResultId, executorStatus: prevResult.executorStatus, machineGate: prevResult.machineGate,
      };
    }
    return { advance: true, priorAccepted: true, protocolFailure: false, resultId: prevResultId };
  }

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

    // FIRST TURN: if no conversation is already bound, open the provider exactly
    // once (a brand-new Brain conversation); if a conversation was adopted/resumed
    // (ledger conversationId present) do NOT open a second browser runtime. Then
    // build the dynamic takeover + bootstrap, send it, extract/validate the first
    // Brain reply (one FORMAT_REPAIR allowed), accept the control, persist.
    async start({ goal = null, gitRun = null, bootstrap = null, allowRepair = true, openUrl = 'https://chatgpt.com/' } = {}) {
      if (!providerSessionOpen) {
        if (ledger.state.conversationId) {
          try { await ctl.provider.resume({ tabId: null, conversationId: ledger.state.conversationId, conversationUrl: ledger.state.conversationUrl }); } catch { /* bounded */ }
        } else {
          const identity = await ctl.provider.open({ url: openUrl });
          if (identity && identity.conversationId) {
            ledger.state.conversationId = identity.conversationId;
            ledger.state.conversationUrl = identity.conversationUrl || null;
            ledger.persist();
          }
        }
        providerSessionOpen = true;
      }
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
      providerSessionOpen = true;
      ledger.state.conversationId = identity.conversationId;
      ledger.state.conversationUrl = identity.conversationUrl;
      ledger.persist();
      return identity;
    },

    // Expose the controller-owned advancement gate (for tests / runtime authority).
    evaluateAdvancement(env) { return advancementGate(env); },

    // NEXT CONTROL: extract the canonical envelope, validate, send ONE FORMAT_REPAIR
    // if necessary (then fail closed), enforce the advancement authority gate, accept
    // the control (monotonic sequence, one outstanding, stale/acked validation), apply
    // the deterministic Brain acceptance transition ONLY when the gate passes, then
    // persist accepted state.
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
      const gate = advancementGate(env);
      if (gate.protocolFailure) {
        // Do not advance, do not mark prior accepted, do not accept the control,
        // and do not persist an accepted state.
        metrics.bump('staleControlRejectedCount');
        return { ok: false, protocolIntegrity: true, reason: gate.reason, controlId: env.controlId, expectedAckResultId: gate.expectedAckResultId, got: gate.got, resultId: gate.resultId };
      }
      const accepted = coordinator.acceptControl(env);
      if (!accepted.ok) { metrics.bump('staleControlRejectedCount'); return { ok: false, reason: accepted.reason }; }
      // Determine the Brain acceptance transition from the gate result (one
      // deterministic path; never silently accept a failed/unacknowledged milestone).
      let acc = { acceptanceStates: gov.state.brainAcceptance, transitions: [] };
      if (gate.priorAccepted && ctl.lastStepId) {
        acc = applyBrainAcceptanceTransition({
          control: env.control,
          prevStepId: ctl.lastStepId,
          reviseDelta: env.reviseDelta,
          acceptanceStates: gov.state.brainAcceptance,
        });
      } else if (env.control === 'REVISE') {
        acc = applyBrainAcceptanceTransition({
          control: 'REVISE',
          reviseDelta: env.reviseDelta,
          acceptanceStates: gov.state.brainAcceptance,
        });
      }
      // Only persist accepted Brain state after the gate passes (fix: never persist
      // accepted on executor failure / machineGate fail / unacknowledged RESULT).
      gov.state.brainAcceptance = acc.acceptanceStates;
      ledger.state.brainAcceptance = acc.acceptanceStates;
      if (env.control === 'TASK') metrics.bump('taskCount');
      else if (env.control === 'REVISE') metrics.bump('reviseCount');
      else if (env.control === 'REPLAN') metrics.bump('replanCount');
      else if (env.control === 'ASK_USER') metrics.bump('askUserCount');
      else if (env.control === 'PUBLISH') metrics.bump('publishCount');
      ctl.lastStepId = env.stepId;
      ledger.persist();
      return { ok: true, control: env, sequence: accepted.sequence, brainAcceptance: acc.acceptanceStates, transitions: acc.transitions, priorAccepted: gate.priorAccepted };
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
      providerSessionOpen = true;
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
