// chatgpt-codex-orchestrator: Durable Task State (Batch A, Gate A).
// Atomic JSON persistence with a schema version, a stable taskId, a step ledger,
// and corruption handling that never silently resets. Alpha.2 adds load-time
// hydration for the delta-packet fields while keeping schemaVersion = 1.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STATE_SCHEMA_VERSION = 1;

export const TASK_STATUSES = ['running', 'awaiting_user', 'recovery_required', 'completed', 'failed', 'cancelled'];
export const STEP_STATUSES = ['received', 'executing', 'executed', 'result_recorded', 'result_sent', 'reviewed'];
export const ACCEPTANCE_STATUSES = ['pass', 'fail', 'unknown', 'missing'];

export class TaskStateCorruptError extends Error {
  constructor(msg) { super(msg); this.name = 'TaskStateCorruptError'; }
}

export function makeTaskId() { return crypto.randomUUID(); }

// Default Alpha.2 verification policy: step-level by default; the full suite runs
// at milestone and final boundaries; documentation-only steps may use a lightweight
// tier (default: 'step'). Repository-specific commands live in Project Profile /
// policy, not here.
export function defaultVerificationPolicy(overrides = {}) {
  return {
    defaultLevel: 'step',
    stepRules: {},
    milestoneRules: { fullTestAt: ['milestone', 'final'] },
    finalRules: { fullTestAt: ['final'] },
    fullTestAt: ['milestone', 'final'],
    docOnlyTier: 'step',
    ...overrides,
  };
}

// On-disk file naming: <taskId>.json inside a state dir.
export function stateFilePath(stateDir, taskId) { return path.join(stateDir, taskId + '.json'); }

// Atomic write: write temp then rename; keep a .bak of the previous good file so a
// single corruption never destroys the last consistent state.
export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  if (fs.existsSync(file)) { try { fs.copyFileSync(file, file + '.bak'); } catch (e) {} }
  fs.renameSync(tmp, file);
  try { fs.copyFileSync(file, file + '.bak'); } catch (e) {} // always keep a good backup
}

function tryRead(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || !obj.taskId) throw new Error('not a task state object');
    return obj;
  } catch (e) {
    throw new TaskStateCorruptError(`corrupt task state at ${file}: ${e.message}`);
  }
}

// Recover real structured evidence from persisted step result data. This is NOT
// fabrication: it only lifts evidence already saved on a step result. A legacy
// acceptanceRegistry `pass` with no backing evidence is not converted.
export function recoverEvidenceFromSteps(steps = []) {
  const out = [];
  for (const st of steps) {
    const source = (st && (st.resultObj || st.result)) || null;
    const evs = source && Array.isArray(source.evidence) ? source.evidence : [];
    for (const e of evs) {
      const norm = typeof e === 'string' ? { acceptanceId: e, status: 'unknown', kind: 'verify', summary: e } : e;
      if (!norm || !norm.acceptanceId) continue;
      out.push({
        id: `ev-${st.stepId || 'step'}:${norm.acceptanceId}`.replace(/[^a-zA-Z0-9:]/g, '_'),
        stepId: st.stepId || null,
        acceptanceId: norm.acceptanceId,
        status: ['pass','fail','unknown'].includes(norm.status) ? norm.status : 'unknown',
        kind: norm.kind || 'verify',
        summary: norm.summary || norm.acceptanceId,
        at: st.updatedAt || new Date().toISOString(),
      });
    }
  }
  return out;
}

// Load-time hydration for the Alpha.2 fields. schemaVersion stays v1; no stored
// data is discarded; defaults fill missing fields for old v1 tasks.
export function hydrateTaskState(state) {
  if (!state || typeof state !== 'object') return state;
  const s = { ...state };
  s.schemaVersion = STATE_SCHEMA_VERSION;
  s.taskContract = s.taskContract ?? null;
  s.repoContext = s.repoContext ?? null;
  s.projectProfileRef = s.projectProfileRef ?? null;
  s.plan = s.plan ?? null;
  s.currentStepId = s.currentStepId ?? null;
  s.verificationPolicy = s.verificationPolicy ? { ...defaultVerificationPolicy(), ...s.verificationPolicy } : defaultVerificationPolicy();
  s.stepSummaries = Array.isArray(s.stepSummaries) ? s.stepSummaries : [];
  s.evidenceLedger = Array.isArray(s.evidenceLedger) ? s.evidenceLedger : recoverEvidenceFromSteps(s.steps || []);
  s.unresolvedRisks = Array.isArray(s.unresolvedRisks) ? s.unresolvedRisks : [];
  if (!Array.isArray(s.steps)) s.steps = [];
  if (!Array.isArray(s.completedSteps)) s.completedSteps = [];
  if (!Array.isArray(s.acceptanceRegistry)) s.acceptanceRegistry = [];
  if (typeof s.reviseRetries !== 'number') s.reviseRetries = 0;
  if (!s.metrics || typeof s.metrics !== 'object') s.metrics = {};
  return s;
}

export function loadState(stateDir, taskId) {
  const file = stateFilePath(stateDir, taskId);
  try { return hydrateTaskState(tryRead(file)); }
  catch (e) {
    // fall back to backup; if that also fails, throw (never silently reset).
    const bak = file + '.bak';
    try { return hydrateTaskState(tryRead(bak)); }
    catch (e2) { throw new TaskStateCorruptError(`task state corrupt (primary and backup) for ${taskId}`); }
  }
}

export function saveState(stateDir, state) {
  atomicWriteJson(stateFilePath(stateDir, state.taskId), state);
}

export function newTaskState({ taskId = makeTaskId(), repoDir, goal, conversationMode = 'new', adopted = false } = {}) {
  const now = new Date().toISOString();
  const s = {
    schemaVersion: STATE_SCHEMA_VERSION,
    taskId,
    repoDir,
    goal,
    status: 'running',
    conversationMode,
    adopted,
    conversationId: null,
    conversationUrl: null,
    ownedTabId: null,
    codexSessionId: null,
    round: 0,
    lastControl: null,
    inFlightStep: null,
    steps: [],
    completedSteps: [],
    acceptanceRegistry: [],
    createdAt: now,
    updatedAt: now,
    // Alpha.2 delta-packet durable fields
    taskContract: null,
    repoContext: null,
    projectProfileRef: null,
    plan: null,
    currentStepId: null,
    verificationPolicy: defaultVerificationPolicy(),
    stepSummaries: [],
    evidenceLedger: [],
    unresolvedRisks: [],
    reviseRetries: 0,
    metrics: {},
  };
  return s;
}

// Merge a patch and bump updatedAt. Keeps schema version.
export function updateState(state, patch = {}) {
  const s = { ...state, ...patch, schemaVersion: STATE_SCHEMA_VERSION, updatedAt: new Date().toISOString() };
  return hydrateTaskState(s);
}

// Step ledger helpers.
export function addStep(state, step) {
  state.steps.push({ receivedAt: new Date().toISOString(), status: 'received', ...step });
  return state.steps[state.steps.length - 1];
}
export function setStepStatus(state, stepId, status, extra = {}) {
  const st = state.steps.find((s) => s.stepId === stepId);
  if (!st) throw new Error(`step not found: ${stepId}`);
  Object.assign(st, extra, { status, updatedAt: new Date().toISOString() });
  if (status === 'result_recorded' || status === 'result_sent' || status === 'reviewed') {
    if (status === 'reviewed') {
      if (!state.completedSteps.includes(stepId)) state.completedSteps.push(stepId);
      compactStep(state, st); // orchestrator-owned compaction when a step is reviewed
    }
  }
  return st;
}
export function findStep(state, stepId) { return state.steps.find((s) => s.stepId === stepId) || null; }

// Compact durable summary produced by reviewed -> compact.
export function buildStepSummary(state, step) {
  if (!step) return null;
  const evidenceRefs = (state.evidenceLedger || []).filter((e) => e.stepId === step.stepId).map((e) => e.id);
  const acceptanceSummary = (step.acceptance || []).map((a) => {
    const reg = (state.acceptanceRegistry || []).find((x) => x.id === a.id);
    return { id: a.id, text: a.text || a.id, status: reg ? reg.status : 'missing' };
  });
  const raw = (step.result && typeof step.result.resultText === 'string') ? step.result.resultText : (step.resultObj && typeof step.resultObj.summary === 'string' ? step.resultObj.summary : '');
  const title = step.title || step.instruction || '';
  return {
    stepId: step.stepId,
    milestoneId: step.milestoneId || null,
    title,
    summary: (step.summary || raw || '').slice(0, 200),
    status: 'reviewed',
    acceptanceSummary,
    evidenceRefs,
    verification: (step.verification && step.verification.level) || (state.verificationPolicy && state.verificationPolicy.defaultLevel) || 'step',
    compactedAt: new Date().toISOString(),
  };
}

// Deterministically compact a reviewed step into stepSummaries (idempotent).
export function compactStep(state, step) {
  if (!step) return null;
  const summary = buildStepSummary(state, step);
  const arr = Array.isArray(state.stepSummaries) ? state.stepSummaries : (state.stepSummaries = []);
  const idx = arr.findIndex((s) => s.stepId === step.stepId);
  if (idx >= 0) arr[idx] = summary; else arr.push(summary);
  if (Array.isArray(state.completedSteps) && !state.completedSteps.includes(step.stepId)) state.completedSteps.push(step.stepId);
  return summary;
}

// Record a revised step attempt counter (used for 2-REVISE escalation).
export function bumpReviseRetries(state) {
  state.reviseRetries = (state.reviseRetries || 0) + 1;
  return state.reviseRetries;
}
export function resetReviseRetries(state) {
  state.reviseRetries = 0;
  return 0;
}

// Acceptance registry helpers.
export function upsertAcceptance(state, acc) {
  let existing = state.acceptanceRegistry.find((a) => a.id === acc.id);
  if (existing) Object.assign(existing, acc, { updatedAt: new Date().toISOString() });
  else state.acceptanceRegistry.push({ ...acc, status: acc.status || 'missing', updatedAt: new Date().toISOString() });
}
export function setAcceptanceEvidence(state, acceptanceId, evidenceStatus) {
  const a = state.acceptanceRegistry.find((x) => x.id === acceptanceId);
  if (a) { a.status = evidenceStatus; a.updatedAt = new Date().toISOString(); }
}
