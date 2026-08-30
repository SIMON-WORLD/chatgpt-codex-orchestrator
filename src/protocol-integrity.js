// chatgpt-codex-orchestrator: Alpha.4 protocol integrity (Direct Brain Loop).
//
// Pure, injectable helpers for the remaining release blockers: explicit
// Executor / Machine / Brain authority separation, epistemic evidence levels,
// a mandatory canonical structured Brain envelope, control/RESULT identity +
// monotonic cursor, piggyback delivery ACK (no standalone ACK turns), a small
// atomic Direct run ledger, and a lightweight REVISE delta / ASK_USER envelope.
// No worker/daemon, no new Brain provider, no workflow engine, no telemetry.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONTROLS } from './protocol.js';

// --- 1) Executor / Machine / Brain authority --------------------------------
export const EXECUTOR_STATUSES = ['success', 'failure', 'blocked', 'unknown'];
export const MACHINE_GATES = ['pass', 'fail', 'pending'];
export const BRAIN_ACCEPTANCES = ['pending', 'accepted', 'revise', 'rejected'];

// A milestone is globally accepted only when the executor result is acceptable,
// the machine gate passes, AND the Brain explicitly accepts/advances it.
export function evaluateMilestoneAcceptance({ executorStatus = 'unknown', machineGate = 'pending', brainAcceptance = 'pending' } = {}) {
  const executorOk = executorStatus === 'success';
  const reason = [];
  if (!executorOk) reason.push(`executorStatus is not acceptable (${executorStatus})`);
  if (machineGate !== 'pass') reason.push(`machineGate is ${machineGate} (need pass)`);
  if (brainAcceptance !== 'accepted') reason.push(`brainAcceptance is ${brainAcceptance} (need accepted)`);
  return { accepted: reason.length === 0, reason: reason.join('; ') };
}

// --- 2) Evidence epistemic level --------------------------------------------
export const EVIDENCE_LEVELS = ['observed', 'inferred', 'user_verified', 'unobservable'];

// inferred cannot satisfy an observed requirement; user_verified may satisfy an
// acceptance explicitly allowing it; unobservable is never silently pass.
export function evaluateEvidenceLevel({ evidenceLevel = 'observed', requiredEvidenceLevel = null } = {}) {
  const lvl = evidenceLevel || 'observed';
  if (lvl === 'unobservable') return { ok: false, level: lvl, reason: 'unobservable evidence cannot satisfy any acceptance (never silently converted to pass)' };
  if (!requiredEvidenceLevel) return { ok: true, level: lvl };
  if (requiredEvidenceLevel === 'observed' && lvl !== 'observed') return { ok: false, level: lvl, reason: `inferred (${lvl}) cannot satisfy an observed requirement` };
  if (requiredEvidenceLevel === 'user_verified' && !['user_verified', 'observed'].includes(lvl)) return { ok: false, level: lvl, reason: `only user_verified/observed satisfies user_verified requirement (got ${lvl})` };
  return { ok: true, level: lvl };
}

// --- 3) Canonical structured Brain envelope ----------------------------------
export const ENVELOPE_FIELDS = ['runId', 'controlId', 'sequence', 'control', 'stepId', 'instruction', 'acceptance', 'ackResultId', 'reviseDelta', 'askUser'];


// Strict structured envelope extraction for canonical Direct Mode. Returns the
// envelope object only when it carries runId + controlId; otherwise null (do NOT
// fall back to prose parsing).
export function extractCanonicalEnvelope(input) {
  if (input && typeof input === 'object' && input.runId && input.controlId) return input;
  const text = String(input || '');
  try { const o = JSON.parse(text); if (o && o.runId && o.controlId) return o; } catch {}
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { const o = JSON.parse(m[0]); if (o && o.runId && o.controlId) return o; } catch {} }
  return null;
}

export function validateStructuredEnvelope(env) {
  if (!env || typeof env !== 'object') return { ok: false, errors: ['envelope is not an object'] };
  const errors = [];
  if (!env.runId) errors.push('runId required');
  if (!env.controlId) errors.push('controlId required');
  if (typeof env.sequence !== 'number' || !Number.isInteger(env.sequence)) errors.push('sequence must be an integer');
  if (!CONTROLS.includes(env.control)) errors.push(`control must be one of ${CONTROLS.join(', ')}`);
  if (!env.stepId) errors.push('stepId required');
  if ((env.control === 'TASK' || env.control === 'REVISE') && !env.instruction) errors.push('instruction required for TASK/REVISE');
  return { ok: errors.length === 0, errors };
}

export function formatRepairPrompt() {
  return 'Restate the immediately previous control in canonical structured form only. Do not replan or change its instruction/acceptance.';
}

// --- 4/5) Control / RESULT identity, monotonic cursor, piggyback ACK ---------
function canonicalSort(arr) {
  return (Array.isArray(arr) ? arr : []).slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

// Canonical stable payload hash for a RESULT, computed from its semantic payload.
export function computePayloadHash(result) {
  const payload = {
    runId: result.runId,
    resultId: result.resultId,
    inReplyToControlId: result.inReplyToControlId,
    sequence: result.sequence,
    stepId: result.stepId,
    executorStatus: result.executorStatus,
    machineGate: result.machineGate,
    changed: canonicalSort(result.changed || []),
    evidence: canonicalSort((result.evidence || []).map((e) => ({ acceptanceId: e.acceptanceId, status: e.status, evidenceLevel: e.evidenceLevel, kind: e.kind, summary: e.summary }))),
    blockers: canonicalSort(result.blockers || []),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function createDirectRunCoordinator({ runId = null, ledger = null } = {}) {
  const st = (ledger && ledger.state) ? ledger.state : (ledger || {
    runId: null,
    lastAcceptedSequence: 0,
    lastAcceptedControlId: null,
    outstandingControlId: null,
    lastSentResultId: null,
    lastAcknowledgedResultId: null,
    processedControlIds: [],
    processedResultIds: [],
    acknowledgedResultIds: [],
    controls: {},
    results: {},
    metrics: { staleControlRejectedCount: 0, duplicateResultCount: 0, resultRetransmitCount: 0, deliveryAckTimeoutCount: 0, protocolIntegrityFailure: 0 },
  });
  // Normalize coordinator state (works with or without a persisted ledger).
  st.controls = st.controls || {};
  st.results = st.results || {};
  st.acknowledgedResultIds = st.acknowledgedResultIds || [];
  st.metrics = st.metrics || { staleControlRejectedCount: 0, duplicateResultCount: 0, resultRetransmitCount: 0, deliveryAckTimeoutCount: 0, protocolIntegrityFailure: 0 };
  if (runId) st.runId = runId;
  if (ledger) st.runId = st.runId || (ledger.state && ledger.state.runId) || runId;
  const bump = (field) => { if (st.metrics && field in st.metrics) st.metrics[field] = (st.metrics[field] || 0) + 1; };
  const persist = () => { if (ledger) try { ledger.persist(); } catch {} };
  if (ledger && ledger.state) ledger.state.runId = ledger.state.runId || st.runId;

  return {
    state: st,
    metrics() { return { ...st.metrics }; },
    // Accept a Brain control. Enforces runId, strict sequence increase, one
    // outstanding, no re-execution, and validates any piggyback ackResultId.
    acceptControl(env) {
      const v = validateStructuredEnvelope(env);
      if (!v.ok) return { ok: false, reason: 'invalid envelope', errors: v.errors };
      if (st.runId && env.runId !== st.runId) return { ok: false, reason: 'runId mismatch' };
      if (env.sequence <= (st.lastAcceptedSequence || 0)) { bump('staleControlRejectedCount'); persist(); return { ok: false, reason: 'stale control (sequence not strictly increasing)' }; }
      if (st.outstandingControlId && st.outstandingControlId !== env.controlId) { bump('staleControlRejectedCount'); persist(); return { ok: false, reason: 'another control is still outstanding' }; }
      if (st.processedControlIds.includes(env.controlId)) { bump('staleControlRejectedCount'); persist(); return { ok: false, reason: 'control already processed (do not re-execute)' }; }
      // Piggyback ACK must reference a genuinely sent/unacknowledged RESULT for this run.
      if (env.ackResultId) {
        const acked = st.results[env.ackResultId];
        if (!acked) { bump('staleControlRejectedCount'); persist(); return { ok: false, reason: 'ackResultId unknown/stale (not a genuinely sent result for this run)' }; }
        if (!st.acknowledgedResultIds.includes(env.ackResultId)) st.acknowledgedResultIds.push(env.ackResultId);
        st.lastAcknowledgedResultId = env.ackResultId;
      }
      st.lastAcceptedControlId = env.controlId;
      st.lastAcceptedSequence = env.sequence;
      st.outstandingControlId = env.controlId;
      st.processedControlIds.push(env.controlId);
      st.controls[env.controlId] = { controlId: env.controlId, sequence: env.sequence, control: env.control, stepId: env.stepId, instruction: env.instruction, acceptance: env.acceptance };
      persist();
      return { ok: true, sequence: env.sequence };
    },
    // Record a RESULT. Duplicate-first idempotent handling: a real duplicate arriving
    // after the first RESULT (outstandingControlId already null) must be accepted.
    recordResult(result) {
      if (st.processedResultIds.includes(result.resultId)) {
        const prior = st.results[result.resultId];
        if (prior && (prior.payloadHash !== result.payloadHash || prior.inReplyToControlId !== result.inReplyToControlId)) {
          bump('protocolIntegrityFailure'); persist();
          return { ok: false, reason: 'duplicate resultId with different payload/control (protocol integrity failure)', resultId: result.resultId };
        }
        bump('duplicateResultCount'); persist();
        return { ok: true, duplicate: true, resultId: result.resultId, payloadHash: result.payloadHash };
      }
      // Full RESULT identity validation.
      if (st.runId && result.runId !== st.runId) return { ok: false, reason: 'runId mismatch' };
      if (!result.resultId) return { ok: false, reason: 'resultId required' };
      if (!result.payloadHash) return { ok: false, reason: 'payloadHash required' };
      if (result.inReplyToControlId !== st.outstandingControlId) { bump('staleControlRejectedCount'); persist(); return { ok: false, reason: 'RESULT does not match the outstanding control', outstanding: st.outstandingControlId, got: result.inReplyToControlId }; }
      const ctl = st.controls[result.inReplyToControlId];
      if (!ctl || ctl.sequence !== result.sequence) { bump('staleControlRejectedCount'); persist(); return { ok: false, reason: 'RESULT sequence does not match the outstanding control' }; }
      st.processedResultIds.push(result.resultId);
      st.results[result.resultId] = { ...result };
      st.lastSentResultId = result.resultId;
      st.outstandingControlId = null;
      persist();
      return { ok: true, duplicate: false, resultId: result.resultId, payloadHash: result.payloadHash };
    },
    // Retransmission must reuse the exact resultId + payloadHash (never generate a new id).
    retransmit(result) { bump('resultRetransmitCount'); persist(); return { resultId: result.resultId, payloadHash: result.payloadHash }; },
    // Expose metrics from the active run state (for the dogfood report).
    metricsSnapshot() { return { metrics: st.metrics, lastAcknowledgedResultId: st.lastAcknowledgedResultId, lastSentResultId: st.lastSentResultId, outstandingControlId: st.outstandingControlId }; },
  };
}

// --- 7) Minimal durable Direct run ledger ------------------------------------
// A SMALL atomic JSON checkpoint under the configured Direct data root. NOT a
// daemon/database/recovery subsystem. Persists only machine state needed for safe
// resume; never raw prompts / transcripts / logs / secrets / credentials.
export function createDirectRunLedger({ dataRoot = null, runId }) {
  const file = dataRoot ? path.join(dataRoot, 'direct-runs', (runId || 'run') + '.json') : null;
  const base = {
    runId: runId || null,
    conversationId: null,
    conversationUrl: null,
    lastAcceptedControlId: null,
    lastAcceptedSequence: 0,
    outstandingControlId: null,
    lastSentResultId: null,
    lastAcknowledgedResultId: null,
    processedControlIds: [],
    processedResultIds: [],
    acknowledgedResultIds: [],
    controls: {},
    results: {},
    metrics: { staleControlRejectedCount: 0, duplicateResultCount: 0, resultRetransmitCount: 0, deliveryAckTimeoutCount: 0, protocolIntegrityFailure: 0 },
    brainAcceptance: {},
    frozenDecisions: [],
    publication: null,
  };
  const state = { ...base };
  return {
    state,
    set(field, value) { if (field in state) state[field] = value; },
    snapshot() { return JSON.parse(JSON.stringify(state)); },
    persist() { if (!file) return { persisted: false }; try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, file); return { persisted: true, path: file }; } catch (e) { return { persisted: false, error: String(e) }; } },
    load() { if (!file || !fs.existsSync(file)) return null; try { const loaded = JSON.parse(fs.readFileSync(file, 'utf8')); Object.assign(state, loaded); return loaded; } catch { return null; } },
    // On resume: combine with envelopes visible in the SAME conversation and fail
    // closed on disagreement.
    agreeWith(conversationId, lastAcceptedControlId) {
      if (state.conversationId && conversationId && state.conversationId !== conversationId) return { ok: false, reason: 'ledger/conversation disagreement' };
      if (state.lastAcceptedControlId && lastAcceptedControlId && state.lastAcceptedControlId !== lastAcceptedControlId) return { ok: false, reason: 'ledger/control disagreement' };
      state.conversationId = state.conversationId || conversationId;
      return { ok: true };
    },
  };
}

// --- 8) REVISE delta contract (lightweight) ----------------------------------
export function applyReviseDelta({ delta = {}, acceptanceStates = {} }) {
  const preserve = new Set(delta.preserve || []);
  const invalidate = new Set(delta.invalidate || []);
  const next = {};
  const reopened = [];
  for (const [id, status] of Object.entries(acceptanceStates)) {
    // Only an explicitly invalidated conclusion becomes pending; a preserved
    // accepted milestone is never silently reopened even if it is also invalidated.
    if (invalidate.has(id) && !preserve.has(id)) { next[id] = 'pending'; if (status === 'accepted') reopened.push(id); }
    else next[id] = status;
  }
  return { acceptanceStates: next, reopened, changeScope: delta.changeScope || [], forbidden: delta.forbidden || [] };
}

// --- 9) Standard ASK_USER envelope -------------------------------------------
export function buildAskUserEnvelope({ whyBlocked = '', minimalUserAction = '', readOnly = true, expectedFields = [], resumeControlId = null, question = '' }) {
  return { kind: 'ASK_USER', whyBlocked, minimalUserAction, readOnly, expectedFields, resumeControlId, question };
}
