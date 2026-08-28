// chatgpt-codex-orchestrator: Structured Brain Protocol (Batch A, Gate C).
// Extended for Alpha.2 delta packets: adds PLAN / REPLAN control tokens, compact
// TASK / RESULT by default, and a real append-only evidenceLedger. Legacy text
// protocol is still accepted as a compatibility fallback; structured protocol is
// the runtime default.
import crypto from 'node:crypto';
import { parseControl as legacyParseControl, extractDirective } from './directives.js';

export const CONTROLS = ['TASK', 'REVISE', 'ASK_USER', 'DONE', 'PLAN', 'REPLAN'];
export const RESULT_STATUSES = ['success', 'failure', 'unknown'];
export const EVIDENCE_KINDS = ['command', 'test', 'file', 'diff', 'verify'];
export const VERIFICATION_LEVELS = ['step', 'milestone', 'final'];

export class ProtocolError extends Error {
  constructor(msg) { super(msg); this.name = 'ProtocolError'; }
}

function stripFences(s) { return String(s || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim(); }

// Parse a ChatGPT reply into a control object. Tries (in order): raw JSON,
// JSON embedded in text, then legacy text protocol.
export function normalizeBrainOutput(input) {
  let text = typeof input === 'string' ? input : (input && typeof input === 'object' ? input : String(input ?? ''));
  if (typeof text === 'object') return text;

  // 1) whole text is JSON
  try { const o = JSON.parse(stripFences(text)); if (o && typeof o === 'object') return o; } catch (e) {}
  // 2) JSON block inside text
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) { try { const o = JSON.parse(m[0]); if (o && typeof o === 'object') return o; } catch (e) {} }

  // 3) legacy text protocol
  const control = legacyParseControl(text);
  if (control) {
    return { control, instruction: extractDirective(text, control), acceptance: [] };
  }
  throw new ProtocolError('no recognizable control token in brain output');
}

// Validate a control object; returns {ok, errors}. TASK/REVISE need an instruction.
// PLAN needs a taskContract or plan. REPLAN needs a reason or a patch.
// acceptance defaults to [] if missing (auto-repair). stepId may be assigned by the
// orchestrator if absent.
export function validateControl(ctrl) {
  const errors = [];
  if (!ctrl || typeof ctrl !== 'object') { return { ok: false, errors: ['not an object'] }; }
  const control = ctrl.control || ctrl.type;
  if (!CONTROLS.includes(control)) errors.push(`invalid control: ${control}`);
  if ((control === 'TASK' || control === 'REVISE') && !(ctrl.instruction || ctrl.text || ctrl.directive)) {
    errors.push('TASK/REVISE requires an instruction');
  }
  if (control === 'ASK_USER' && !(ctrl.question || ctrl.text)) {
    errors.push('ASK_USER requires a question');
  }
  if (control === 'PLAN' && !(ctrl.taskContract || ctrl.plan)) {
    errors.push('PLAN requires a taskContract or plan');
  }
  if (control === 'REPLAN' && !(ctrl.reason || ctrl.planPatch || ctrl.taskContractPatch)) {
    errors.push('REPLAN requires a reason or a patch');
  }
  return { ok: errors.length === 0, errors };
}

// Auto-repair once: fill defaults for acceptance[], instruction from text/directive,
// question from text, PLAN/REPLAN soft defaults. Returns {control, repaired}.
export function repairControl(ctrl) {
  let repaired = false;
  const out = { ...ctrl };
  if (!out.control && out.type) { out.control = out.type; repaired = true; }
  if (!Array.isArray(out.acceptance)) { out.acceptance = []; repaired = true; }
  if ((out.control === 'TASK' || out.control === 'REVISE') && !out.instruction) {
    out.instruction = out.text || out.directive || '';
    repaired = true;
  }
  if (out.control === 'ASK_USER' && !out.question) { out.question = out.text || ''; repaired = true; }
  if (out.control === 'PLAN') {
    if (typeof out.taskContract !== 'object' || out.taskContract === null) { out.taskContract = out.taskContract || null; repaired = true; }
    if (typeof out.plan !== 'object' || out.plan === null) { out.plan = out.plan || null; repaired = true; }
  }
  if (out.control === 'REPLAN') {
    if (!out.reason) { out.reason = out.text || ''; repaired = true; }
  }
  out.acceptance = (out.acceptance || []).map((a) => {
    if (typeof a === 'string') return { id: a, required: true, text: a };
    return { id: a.id || a.text, required: a.required !== false, text: a.text || a.id || '' };
  });
  return { control: out, repaired };
}

// Full parse: normalize -> validate -> (if invalid) repair once -> validate again.
// Returns {control, errors}. Throws ProtocolError only if still invalid.
export function parseBrainOutput(input) {
  let ctrl;
  try { ctrl = normalizeBrainOutput(input); }
  catch (e) { throw new ProtocolError(e.message); }
  let v = validateControl(ctrl);
  if (!v.ok) {
    const r = repairControl(ctrl);
    v = validateControl(r.control);
    if (!v.ok) throw new ProtocolError('brain output invalid after repair: ' + v.errors.join('; '));
  }
  const repaired = (repairControl(ctrl)).control;
  return { control: repaired };
}

// --- Result normalization (compact by default, legacy superset accepted) --------

// Build a compact Codex RESULT object. Canonical fields: type, stepId, status,
// summary (optional), changed, evidence, blockers. Legacy `filesChanged` and
// `tests` inputs are accepted (mapped into `changed` / kept for a fuller form).
export function buildResult({ stepId, status = 'success', summary = '', changed = [], filesChanged = [], tests = [], evidence = [], blockers = [] } = {}) {
  const ch = (Array.isArray(changed) && changed.length) ? changed : filesChanged;
  // Default Alpha.2 RESULT is the compact shape only: type, stepId, status, summary,
  // changed, evidence, blockers. Legacy 'tests' / 'filesChanged' inputs are accepted
  // as input but are NOT emitted by the default compact builder.
  return { type: 'result', stepId, status, summary, changed: ch, evidence, blockers };
}

// Accept a raw result object (compact or legacy) and normalize it.
export function normalizeResult(res) {
  if (!res || typeof res !== 'object') return { type: 'result', stepId: null, status: 'unknown', summary: '', changed: [], evidence: [], blockers: [] };
  const changed = Array.isArray(res.changed) ? res.changed : (Array.isArray(res.filesChanged) ? res.filesChanged : []);
  const evidence = (res.evidence || []).map((e) => normalizeEvidence(e));
  return {
    type: res.type || 'result',
    stepId: res.stepId || null,
    status: res.status || 'unknown',
    summary: res.summary || '',
    changed,
    evidence,
    blockers: Array.isArray(res.blockers) ? res.blockers : [],
    tests: Array.isArray(res.tests) ? res.tests : undefined,
    filesChanged: Array.isArray(res.filesChanged) ? res.filesChanged : undefined,
  };
}

// Serialize a result object for the ChatGPT conversation (human-ish but structured).
export function resultToText(res) {
  const r = normalizeResult(res);
  const lines = [];
  lines.push(`type: result`);
  lines.push(`stepId: ${r.stepId}`);
  lines.push(`status: ${r.status}`);
  lines.push(`summary: ${r.summary}`);
  if (r.changed?.length) lines.push(`changed: ${r.changed.join(', ')}`);
  if (r.tests?.length) lines.push(`tests: ${r.tests.map((t) => `${t.name}:${t.passed ? 'PASS' : 'FAIL'}`).join(', ')}`);
  if (r.evidence?.length) lines.push(`evidence: ${r.evidence.map((e) => `${e.acceptanceId}=${e.status}`).join(', ')}`);
  if (r.blockers?.length) lines.push(`blockers: ${r.blockers.join(', ')}`);
  return lines.join('\n');
}

// --- Packet builders -----------------------------------------------------------

// Compact TASK: only the delta fields + the relevant verification (level + commands)
// when they differ from the default / are required. Commands are resolved per
// step/boundary, never the whole policy repeated every turn.
export function buildCompactTask({ stepId, instruction, acceptance = [], verificationLevel = null, defaultLevel = 'step', verificationCommands = [], verification = null }) {
  const p = { control: 'TASK', stepId, instruction, acceptance };
  const v = verification || {};
  const lvl = (verificationLevel && verificationLevel !== defaultLevel) ? verificationLevel : null;
  const cmds = (verificationCommands && verificationCommands.length) ? verificationCommands : ((v.commands && v.commands.length) ? v.commands : []);
  if (lvl || cmds.length) {
    p.verification = {};
    if (lvl) p.verification.level = lvl;
    if (cmds.length) p.verification.commands = cmds;
  }
  return p;
}

// Full contract packet: re-attaches taskContract + relevant plan milestone +
// constraints + verification commands. Used for escalation and high-risk steps.
export function buildFullTaskPacket({ stepId, instruction, acceptance = [], taskContract = null, plan = null, verificationPolicy = null, verificationCommands = [], milestoneId = null, verification = null }) {
  let milestone = null;
  if (plan && Array.isArray(plan.milestones)) {
    if (milestoneId) milestone = plan.milestones.find((m) => m.milestoneId === milestoneId) || null;
    if (!milestone) milestone = plan.milestones[0] || null;
  }
  const out = {
    control: 'TASK',
    stepId,
    instruction,
    acceptance,
    taskContract,
    plan: plan && milestone ? { planId: plan.planId, milestones: [milestone] } : null,
    verificationPolicy,
    verificationCommands,
    constraints: (taskContract && Array.isArray(taskContract.constraints)) ? taskContract.constraints : [],
  };
  if (verification && (verification.level || (Array.isArray(verification.commands) && verification.commands.length))) out.verification = verification;
  return out;
}

// Compact RESULT builder (alias of buildResult for readability).
export function buildCompactResult(opts) { return buildResult(opts); }

// Serialize a packet object and return its byte length (UTF-8).
export function serializePacket(obj) {
  return JSON.stringify(obj);
}
export function packetSize(obj) {
  return Buffer.byteLength(serializePacket(obj), 'utf8');
}

export function isCompactTask(ctrl) {
  // A compact TASK has no taskContract / plan / verificationCommands re-attached.
  return ctrl && ctrl.control === 'TASK' && !ctrl.taskContract && !ctrl.verificationCommands;
}

// --- Acceptance / evidence gate ------------------------------------------------

// The orchestrator's acceptance gate. A task may only be marked completed when every
// REQUIRED acceptance has evidence = pass.
export function checkAcceptanceGate(registry = []) {
  const required = registry.filter((a) => a.required);
  const failures = required.filter((a) => a.status !== 'pass');
  return { allPass: failures.length === 0, failures, total: required.length };
}

// Register acceptance items from a control into the acceptance registry.
export function registerAcceptances(state, control) {
  const accs = control.acceptance || [];
  for (const a of accs) {
    if (!state.acceptanceRegistry.some((x) => x.id === a.id)) {
      state.acceptanceRegistry.push({ id: a.id, required: a.required, text: a.text, status: 'missing' });
    }
  }
}

// Make a fresh evidence-ledger id.
function ledgerId(stepId, acceptanceId) {
  const slug = `${stepId || 'step'}:${acceptanceId || 'ev'}`.replace(/[^a-zA-Z0-9:]/g, '_');
  return `ev-${slug}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

// Append real structured evidence to the durable evidenceLedger, then apply the
// evidence to the acceptanceRegistry (compatibility projection for the DONE gate).
export function appendLedgerEvidence(state, result) {
  if (!Array.isArray(state.evidenceLedger)) state.evidenceLedger = [];
  const norm = normalizeResult(result);
  const evs = norm.evidence || [];
  for (const e of evs) {
    const entry = {
      id: ledgerId(norm.stepId, e.acceptanceId),
      stepId: norm.stepId || null,
      acceptanceId: e.acceptanceId,
      status: e.status,
      kind: e.kind || 'verify',
      summary: e.summary || e.acceptanceId || '',
      at: new Date().toISOString(),
    };
    const dup = state.evidenceLedger.some((x) => x.stepId === entry.stepId && x.acceptanceId === entry.acceptanceId && x.status === entry.status && x.kind === entry.kind);
    if (!dup) state.evidenceLedger.push(entry);
  }
}

// Apply evidence from a result to the acceptance registry.
export function applyEvidence(state, result) {
  const norm = normalizeResult(result);
  // Durable ledger append first.
  appendLedgerEvidence(state, norm);
  const ev = norm.evidence || [];
  for (const e of ev) {
    const a = state.acceptanceRegistry.find((x) => x.id === e.acceptanceId);
    if (a) a.status = e.status;
    else state.acceptanceRegistry.push({ id: e.acceptanceId, required: true, text: e.acceptanceId, status: e.status });
  }
}

// --- Evidence hardening (Batch B3) -------------------------------------------

// Normalize an evidence item: { acceptanceId, status, kind, summary }.
const ALIAS = { passed: 'pass', pass: 'pass', success: 'pass', ok: 'pass', failed: 'fail', fail: 'fail', unknown: 'unknown' };
export function normalizeEvidence(ev) {
  if (typeof ev === 'string') return { acceptanceId: ev, status: 'unknown', kind: 'verify', summary: ev };
  const status = (ev.status || '').toLowerCase();
  const st = ALIAS[status] || (['pass','fail','unknown'].includes(status) ? status : 'unknown');
  return {
    acceptanceId: ev.acceptanceId || ev.id || '',
    status: st,
    kind: ev.kind || 'verify',
    summary: ev.summary || ev.text || '',
  };
}

export function validateEvidence(ev) {
  const e = normalizeEvidence(ev);
  const errors = [];
  if (!e.acceptanceId) errors.push('evidence missing acceptanceId');
  if (!['pass', 'fail', 'unknown'].includes(e.status)) errors.push('evidence status must be pass|fail|unknown');
  return { ok: errors.length === 0, errors, evidence: e };
}

// Parse an "EVIDENCE:" block from a codex result string.
export function parseEvidenceBlock(text) {
  const out = [];
  const re = /EVIDENCE\s*:\s*(.+)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const seg = m[1].trim();
    try { const o = JSON.parse(seg); if (Array.isArray(o)) { for (const item of o) out.push(normalizeEvidence(item)); } else out.push(normalizeEvidence(o)); continue; } catch (e) {}
    const parts = seg.split(/\s+/);
    const id = parts[0]; const status = (parts[1] || '').toLowerCase();
    out.push({ acceptanceId: id, status: ['pass','fail','unknown'].includes(status) ? status : 'unknown', kind: parts[2] || 'verify', summary: parts.slice(3).join(' ') || id });
  }
  return out;
}
