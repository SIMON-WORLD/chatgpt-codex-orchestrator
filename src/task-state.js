// chatgpt-codex-orchestrator: Durable Task State (Batch A, Gate A).
// Atomic JSON persistence with a schema version, stable taskId, a step ledger, and
// corruption handling that never silently resets to a new task.
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

export function loadState(stateDir, taskId) {
  const file = stateFilePath(stateDir, taskId);
  try { return tryRead(file); }
  catch (e) {
    // fall back to backup; if that also fails, throw (never silently reset).
    const bak = file + '.bak';
    try { return tryRead(bak); }
    catch (e2) { throw new TaskStateCorruptError(`task state corrupt (primary and backup) for ${taskId}`); }
  }
}

export function saveState(stateDir, state) {
  atomicWriteJson(stateFilePath(stateDir, state.taskId), state);
}

export function newTaskState({ taskId = makeTaskId(), repoDir, goal, conversationMode = 'new', adopted = false }) {
  const now = new Date().toISOString();
  return {
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
  };
}

// Merge a patch and bump updatedAt. Keeps schema version.
export function updateState(state, patch = {}) {
  const s = { ...state, ...patch, schemaVersion: STATE_SCHEMA_VERSION, updatedAt: new Date().toISOString() };
  return s;
}

// Step ledger helpers.
export function addStep(state, step) {
  state.steps.push({ receivedAt: new Date().toISOString(), ...step });
  return state.steps[state.steps.length - 1];
}
export function setStepStatus(state, stepId, status, extra = {}) {
  const st = state.steps.find((s) => s.stepId === stepId);
  if (!st) throw new Error(`step not found: ${stepId}`);
  Object.assign(st, extra, { status, updatedAt: new Date().toISOString() });
  if (status === 'result_recorded' || status === 'result_sent' || status === 'reviewed') {
    if (!state.completedSteps.includes(stepId)) {
      if (status === 'reviewed') state.completedSteps.push(stepId);
    }
  }
  return st;
}
export function findStep(state, stepId) { return state.steps.find((s) => s.stepId === stepId) || null; }

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