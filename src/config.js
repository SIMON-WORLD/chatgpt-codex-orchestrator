import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_DATA_ROOT, runtimePaths } from './runtime-paths.js';
// chatgpt-codex-orchestrator: minimal Alpha config (Batch D3).
// No auth token / API key is stored here.


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

// --- v0.2 production runtime config (M5) -------------------------------------
// No auth token / API key is stored here. The tunnel api_key is supplied via the
// environment (referenced as "env:VAR" in the tunnel profile), never inlined.
export const DEFAULT_V02_CONFIG = {
  host: '127.0.0.1',
  port: 8745,
  dataRoot: DEFAULT_DATA_ROOT,
  workspaceRoot: null,          // a single workspace root (allowedRoots derived)
  workspaceRoots: [],           // explicit allowlist
  codex: {
    bin: 'codex',               // codex executable (or node + codex.js via !spawnArgs)
    listen: 'stdio://',
    cwd: null,
    runtimeProfile: null,       // isolated CODEX_HOME profile dir (M5 phase C)
    model: null,                // optional model override; null => Codex default
    caBundle: null,             // trusted CA bundle path for Codex outbound TLS (CODEX_CA_CERTIFICATE)
    sslCertFile: null,          // SSL_CERT_FILE override for Codex outbound TLS
    spawnArgs: null,            // override app-server argv after the binary (e.g. [codexJs, app-server, --listen, stdio://])
    extraArgs: [],
  },
  verify: {},                   // server-owned verify checks
  tunnel: {
    clientExecutable: null,     // tunnel-client binary path
    profile: null,              // tunnel profile filename
    profileDir: null,           // tunnel profile directory
    localMcpUrl: null,          // local MCP URL the tunnel forwards (e.g. http://127.0.0.1:8745/mcp)
    spawnArgs: null,           // override tunnel-client argv after the executable (for tests)
    healthUrl: null,
    healthUrl: null,           // full tunnel health /readyz URL used to probe real readiness
  },
};

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, ...sources) {
  const out = JSON.parse(JSON.stringify(base));
  for (const src of sources) if (isPlainObject(src)) for (const k of Object.keys(src)) {
    if (isPlainObject(src[k]) && isPlainObject(out[k])) out[k] = deepMerge(out[k], src[k]);
    else out[k] = src[k];
  }
  return out;
}

function normalizeRoots(roots, single) {
  const list = [];
  for (const r of (Array.isArray(roots) ? roots : (roots ? [roots] : []))) if (r) list.push(path.resolve(String(r)));
  if (single && !list.includes(path.resolve(single))) list.push(path.resolve(String(single)));
  return [...new Set(list)];
}

// Load the v0.2 runtime config. Order: defaults < config file < overrides < env.
export function loadV02Config(overrides = {}, { configPath = null } = {}) {
  const file = {};
  if (configPath && fs.existsSync(configPath)) {
    try { Object.assign(file, JSON.parse(fs.readFileSync(configPath, 'utf8'))); } catch { throw new Error('invalid v0.2 config file: ' + configPath); }
  }
  const cfg = deepMerge(DEFAULT_V02_CONFIG, file, overrides);
  // env overrides (non-sensitive transport/config)
  if (process.env.V02_PORT) cfg.port = Number(process.env.V02_PORT);
  if (process.env.V02_HOST) cfg.host = process.env.V02_HOST;
  if (process.env.V02_WORKSPACE_ROOT) cfg.workspaceRoot = process.env.V02_WORKSPACE_ROOT;
  if (process.env.CODEX_BIN) cfg.codex.bin = process.env.CODEX_BIN;
  if (process.env.TUNNEL_CLIENT_EXECUTABLE) cfg.tunnel.clientExecutable = process.env.TUNNEL_CLIENT_EXECUTABLE;
  if (process.env.TUNNEL_PROFILE) cfg.tunnel.profile = process.env.TUNNEL_PROFILE;
  if (process.env.TUNNEL_PROFILE_DIR) cfg.tunnel.profileDir = process.env.TUNNEL_PROFILE_DIR;
  if (process.env.TUNNEL_LOCAL_MCP_URL) cfg.tunnel.localMcpUrl = process.env.TUNNEL_LOCAL_MCP_URL;
  if (process.env.TUNNEL_HEALTH_URL) cfg.tunnel.healthUrl = process.env.TUNNEL_HEALTH_URL;
  cfg.workspaceRoots = normalizeRoots(cfg.workspaceRoots, cfg.workspaceRoot);
  cfg.paths = runtimePaths(cfg.dataRoot);
  return cfg;
}
