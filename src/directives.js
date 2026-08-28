// chatgpt-codex-orchestrator: directive parsing for the ChatGPT <-> Codex loop.

// Detect the planner's control token in a ChatGPT reply. Order matters:
// ASK_USER / DONE / REVISE (line-start) take priority over a TASK line.
export function parseControl(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (/^ASK_USER\b/i.test(t)) return 'ASK_USER';
    if (/^DONE\b/i.test(t)) return 'DONE';
    if (/^REVISE\b/i.test(t)) return 'REVISE';
  }
  if (/^\s*TASK\b/im.test(String(text || ''))) return 'TASK';
  return null;
}

// Extract the actionable part of a directive (text following the control token).
export function extractDirective(text, control) {
  const s = String(text || '');
  const t = String(control || '');
  if (!t) return s.trim();
  const re = new RegExp('^\\s*' + t + '\\b[\\s:>-]*', 'im');
  const m = re.exec(s);
  if (!m) return s.trim();
  const rest = s.slice(m.index + m[0].length).trim();
  return rest || s.trim();
}