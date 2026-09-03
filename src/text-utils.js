// chatgpt-codex-orchestrator: shared text/URL utilities (v0.2 M6).
// Small non-browser helpers extracted out of the legacy IAB composer transport so the
// canonical v0.2 runtime import closure does not depend on the browser transport.
export function isPlaceholder(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return /^(正在思考|thinking|thinking\.{3}|\.{3}|…|\.\.\.|生成中|typing)/i.test(t);
}
export function extractConversationId(url) {
  const m = /\/c\/([0-9a-zA-Z-]+)/.exec(String(url || ''));
  return m ? m[1] : null;
}
