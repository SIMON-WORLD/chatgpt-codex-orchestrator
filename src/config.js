// chatgpt-codex-orchestrator: minimal Alpha config (Batch D3).
// No auth token / API key is stored here.
import { DEFAULT_DATA_ROOT, runtimePaths } from './runtime-paths.js';

export const DEFAULT_ALPHA_CONFIG = {
  dataRoot: DEFAULT_DATA_ROOT,
  defaultConversationMode: 'new',
  context: { maxBytes: 12000, maxFiles: 12 },
  timeouts: { replyTimeoutMs: 120000, composerTimeoutMs: 60000, pollIntervalMs: 900 },
  codex: { discovery: 'auto' },         // codex.js path auto-detected
  sandbox: { policy: 'workspace-write', bypass: false },
  log: { maxBytes: 2_000_000 },
};

export function loadAlphaConfig(overrides = {}) {
  const base = { ...DEFAULT_ALPHA_CONFIG };
  const ctx = { ...base.context, ...(overrides.context || {}) };
  const t = { ...base.timeouts, ...(overrides.timeouts || {}) };
  const sb = { ...base.sandbox, ...(overrides.sandbox || {}) };
  const lg = { ...base.log, ...(overrides.log || {}) };
  return {
    ...base,
    ...overrides,
    dataRoot: overrides.dataRoot || base.dataRoot,
    context: ctx,
    timeouts: t,
    sandbox: sb,
    log: lg,
    paths: runtimePaths(overrides.dataRoot || base.dataRoot),
  };
}