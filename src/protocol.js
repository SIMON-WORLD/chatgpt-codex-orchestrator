// chatgpt-codex-orchestrator: Structured Brain Protocol (Batch A, Gate C).
// Built around control tokens TASK / REVISE / ASK_USER / DONE, each carrying
// structured fields. New runtime defaults to structured; legacy text is accepted
// as a compatibility fallback. Includes schema validation with ONE auto-repair and
// an acceptance/evidence gate that a DONE must pass.
import { parseControl as legacyParseControl, extractDirective } from './directives.js';

export const CONTROLS = ['TASK', 'REVISE', 'ASK_USER', 'DONE'];
export const RESULT_STATUSES = ['success', 'failure', 'unknown'];

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
// acceptance defaults to [] if missing (auto-repair). stepId may be assigned by the
// orchestrator if absent (not treated as a hard error here).
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
  return { ok: errors.length === 0, errors };
}

// Auto-repair once: fill defaults for acceptance[], instruction from text/directive,
// question from text. Returns the normalized control and whether a repair happened.
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
  out.acceptance = out.acceptance.map((a) => {
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
  return { control: (repairControl(ctrl)).control };
}

// Build a structured Codex RESULT object.
export function buildResult({ stepId, summary, filesChanged = [], tests = [], evidence = [], blockers = [], status = 'success' }) {
  return { type: 'result', stepId, status, summary, filesChanged, tests, evidence, blockers };
}

// Serialize a result object for the ChatGPT conversation (human-ish but structured).
export function resultToText(res) {
  const lines = [];
  lines.push(`type: result`);
  lines.push(`stepId: ${res.stepId}`);
  lines.push(`status: ${res.status}`);
  lines.push(`summary: ${res.summary}`);
  if (res.filesChanged?.length) lines.push(`filesChanged: ${res.filesChanged.join(', ')}`);
  if (res.tests?.length) lines.push(`tests: ${res.tests.map((t) => `${t.name}:${t.passed ? 'PASS' : 'FAIL'}`).join(', ')}`);
  if (res.evidence?.length) lines.push(`evidence: ${res.evidence.map((e) => `${e.acceptanceId}=${e.status}`).join(', ')}`);
  if (res.blockers?.length) lines.push(`blockers: ${res.blockers.join(', ')}`);
  return lines.join('\n');
}

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

// Apply evidence from a result to the acceptance registry.
export function applyEvidence(state, result) {
  const ev = result.evidence || [];
  for (const e of ev) {
    const a = state.acceptanceRegistry.find((x) => x.id === e.acceptanceId);
    if (a) a.status = e.status;
    else state.acceptanceRegistry.push({ id: e.acceptanceId, required: true, text: e.acceptanceId, status: e.status });
  }
}

// --- Evidence hardening (Batch B3) -------------------------------------------
export const EVIDENCE_KINDS = ['command', 'test', 'file', 'diff', 'verify'];

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

// Parse an "EVIDENCE:" block from a codex result string. Format (one per line):
//   EVIDENCE: {acceptanceId,status,kind,summary}   (JSON object)
//   EVIDENCE: <acceptanceId> <pass|fail|unknown> <kind> <summary>
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