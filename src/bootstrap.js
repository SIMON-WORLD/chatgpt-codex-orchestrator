// chatgpt-codex-orchestrator: Fast Bootstrap / Discovery (Alpha.2, RFC §2-§7).
// The canonical launcher Skill is `brain-command`. Normal startup reads the
// user-scoped machine config directly and resolves the repo deterministically; it
// does NOT perform broad filesystem discovery, search for old bridge Skills, or
// rediscover the orchestrator installation. Full doctor is kept for setup/failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeWritable } from './data-root.js';
import { doctorStatic, DEFAULT_CODEX_JS } from './doctor.js';

export class BrainCommandConfigError extends Error {
  constructor(msg) { super(msg); this.name = 'BrainCommandConfigError'; }
}

// $CODEX_HOME defaults to ~/.codex when not configured.
export function codexHome(env = (typeof process !== 'undefined' ? process.env : {}), homeDir = os.homedir()) {
  return env.CODEX_HOME || path.join(homeDir, '.codex');
}

export function brainCommandConfigPath(ch = codexHome()) {
  return path.join(ch, 'brain-command', 'config.json');
}

export const DEFAULT_BRAIN_COMMAND_CONFIG = {
  orchestratorRoot: '',
  dataRoot: '',
  workspaceRoot: '',
  defaultBrain: 'chatgpt',
  defaultExecutor: 'codex',
  defaultConversationMode: 'new',
};

export function defaultBrainCommandConfig(overrides = {}) {
  return { ...DEFAULT_BRAIN_COMMAND_CONFIG, ...overrides };
}

export function validateBrainCommandConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ok: false, errors: ['config not an object'] };
  const errors = [];
  for (const k of ['orchestratorRoot', 'dataRoot', 'workspaceRoot']) {
    if (typeof cfg[k] !== 'string' || !cfg[k].trim()) errors.push(`missing ${k}`);
  }
  if (!['chatgpt'].includes(cfg.defaultBrain)) errors.push(`unsupported defaultBrain: ${cfg.defaultBrain}`);
  if (!['codex'].includes(cfg.defaultExecutor)) errors.push(`unsupported defaultExecutor: ${cfg.defaultExecutor}`);
  if (!['new', 'current'].includes(cfg.defaultConversationMode)) errors.push(`unsupported defaultConversationMode: ${cfg.defaultConversationMode}`);
  return { ok: errors.length === 0, errors };
}

// Read + validate the user-scoped bootstrap config. Absent/invalid config FAILS
// FAST into setup / full-doctor guidance — no broad discovery.
export function loadBrainCommandConfig({ codexHome: ch = codexHome() } = {}) {
  const file = brainCommandConfigPath(ch);
  if (!fs.existsSync(file)) {
    throw new BrainCommandConfigError(`brain-command config not found: ${file}. Run brain-command setup (full doctor) first.`);
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new BrainCommandConfigError(`brain-command config invalid JSON at ${file}: ${e.message}`); }
  const v = validateBrainCommandConfig(raw);
  if (!v.ok) throw new BrainCommandConfigError(`brain-command config invalid: ${v.errors.join('; ')}`);
  return raw;
}

// Setup/installation path: create or update the user-scoped config once.
export function writeBrainCommandConfig(config, { codexHome: ch = codexHome() } = {}) {
  const dir = path.join(ch, 'brain-command');
  fs.mkdirSync(dir, { recursive: true });
  const file = brainCommandConfigPath(ch);
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
  return file;
}

export function isInsideRepo(dir) {
  const abs = path.resolve(dir || '.');
  if (!fs.existsSync(abs)) return false;
  return fs.existsSync(path.join(abs, '.git')) || fs.existsSync(path.join(abs, '.git'));
}

// --- brain-command installation / discovery (RFC §2, §5) -----------------------
export function inferRepoRoot(metaUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..');
}

// --- brain-command user skill install location (canonical) ---------------------
// Codex's current canonical user-installed Skill root is $HOME/.agents/skills.
// $CODEX_HOME/skills is the deprecated compatibility location. The brain-command
// machine config stays at $CODEX_HOME/brain-command/config.json.

// Resolve the user home without hard-coding a platform-specific absolute path.
export function userHome(env = (typeof process !== 'undefined' ? process.env : {}), homeDir = os.homedir()) {
  return env.HOME || env.USERPROFILE || homeDir;
}

// Source skill path inside the orchestrator repository (the distributable copy).
export function sourceBrainCommandSkillPath({ skillSourceDir = null } = {}) {
  return path.join(skillSourceDir || path.join(inferRepoRoot(), 'skills', 'brain-command'), 'SKILL.md');
}

// Canonical installed user skill path: $HOME/.agents/skills/brain-command/SKILL.md.
export function installedBrainCommandSkillPath({ home = userHome() } = {}) {
  return path.join(home, '.agents', 'skills', 'brain-command', 'SKILL.md');
}

// Legacy / deprecated compatibility location: $CODEX_HOME/skills/brain-command/SKILL.md.
export function legacyBrainCommandSkillPath({ codexHome: ch = codexHome() } = {}) {
  return path.join(ch, 'skills', 'brain-command', 'SKILL.md');
}

export function brainCommandInstalled({ home = userHome(), codexHome = codexHome() } = {}) {
  return fs.existsSync(installedBrainCommandSkillPath({ home })) || fs.existsSync(legacyBrainCommandSkillPath({ codexHome }));
}

// Install/update the launcher Skill into the canonical user Skill root. Does NOT
// perform broad filesystem discovery. Returns the installed user skill path.
export function installBrainCommandSkill({ home = userHome(), skillSourceDir = null } = {}) {
  const srcFile = sourceBrainCommandSkillPath({ skillSourceDir });
  if (!fs.existsSync(srcFile)) throw new BrainCommandConfigError('brain-command skill source not found: ' + srcFile);
  const destDir = path.join(home, '.agents', 'skills', 'brain-command');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'SKILL.md');
  fs.copyFileSync(srcFile, dest);
  return dest;
}

// One-time setup: install the launcher Skill into the canonical user Skill root and
// create/update the user-scoped bootstrap config at $CODEX_HOME/brain-command/config.json,
// preserving machine-local paths. Normal task execution does NOT call this; it only
// reads the config via loadBrainCommandConfig.
export function setupBrainCommand({ codexHome: ch = codexHome(), home = userHome(), config = null, orchestratorRoot = null, skillSourceDir = null, dataRoot = null, workspaceRoot = null, defaultBrain = 'chatgpt', defaultExecutor = 'codex', defaultConversationMode = 'new' } = {}) {
  const skillPath = installBrainCommandSkill({ home, skillSourceDir });
  let existing = null;
  const cfgFile = brainCommandConfigPath(ch);
  if (fs.existsSync(cfgFile)) { try { existing = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) {} }
  const inferredRoot = orchestratorRoot || (existing && existing.orchestratorRoot) || inferRepoRoot();
  const merged = {
    ...defaultBrainCommandConfig(existing),
    ...(config || {}),
    orchestratorRoot: (config && config.orchestratorRoot) || (existing && existing.orchestratorRoot) || inferredRoot,
    dataRoot: (config && config.dataRoot) || (existing && existing.dataRoot) || dataRoot || '',
    workspaceRoot: (config && config.workspaceRoot) || (existing && existing.workspaceRoot) || workspaceRoot || '',
    defaultBrain: (config && config.defaultBrain) || (existing && existing.defaultBrain) || defaultBrain,
    defaultExecutor: (config && config.defaultExecutor) || (existing && existing.defaultExecutor) || defaultExecutor,
    defaultConversationMode: (config && config.defaultConversationMode) || (existing && existing.defaultConversationMode) || defaultConversationMode,
  };
  const configPath = writeBrainCommandConfig(merged, { codexHome: ch });
  return { skillPath, configPath, config: merged };
}

// --- brain-command read-only status check (Alpha.2) ----------------------------
// A deterministic, read-only self-check used by the `status:brain-command` CLI and
// by library callers. It NEVER writes, NEVER echoes the raw config, and NEVER
// exposes any secret/token field -- only the six known safe config fields plus
// per-check diagnostics. Config missing/invalid yields a clear FAIL and a non-zero
// exit code; a healthy install yields PASS and exit code 0.
export function brainCommandStatus({ codexHome: ch = codexHome(), home = userHome() } = {}) {
  const status = {
    ok: false,
    skill: { status: 'FAIL', discoverable: false, canonicalPath: null, legacyPath: null, reason: '' },
    config: { status: 'FAIL', exists: false, parseable: false, file: null, error: null, reason: '' },
    fields: null,
    checks: [],
    exitCode: 1,
  };

  // 1) user-level launcher Skill discoverable (canonical, with legacy fallback).
  const canonical = installedBrainCommandSkillPath({ home });
  const legacy = legacyBrainCommandSkillPath({ codexHome: ch });
  const canonicalOk = fs.existsSync(canonical);
  const legacyOk = fs.existsSync(legacy);
  status.skill = {
    status: canonicalOk ? 'PASS' : (legacyOk ? 'WARN' : 'FAIL'),
    discoverable: canonicalOk || legacyOk,
    canonicalPath: canonical,
    legacyPath: legacy,
    reason: canonicalOk ? 'canonical skill present' : (legacyOk ? 'legacy skill present (deprecated); run setup to migrate' : 'no brain-command skill found'),
  };
  status.checks.push({ check: 'brain-command-skill', status: status.skill.status, reason: status.skill.reason });

  // 2) user-scoped config exists + parseable + valid.
  const cfgFile = brainCommandConfigPath(ch);
  status.config.file = cfgFile;
  status.config.exists = fs.existsSync(cfgFile);
  if (!status.config.exists) {
    status.config.reason = `config not found: ${cfgFile}. Run brain-command setup (npm run setup:brain-command) first.`;
    status.checks.push({ check: 'brain-command-config', status: 'FAIL', reason: status.config.reason });
  } else {
    try {
      const cfg = loadBrainCommandConfig({ codexHome: ch });
      status.config.status = 'PASS';
      status.config.parseable = true;
      status.config.reason = 'config present and parseable';
      // Only the six safe fields are surfaced. The raw config object is never
      // returned or printed, so any extra/secret field is intentionally excluded.
      status.fields = {
        orchestratorRoot: cfg.orchestratorRoot,
        dataRoot: cfg.dataRoot,
        workspaceRoot: cfg.workspaceRoot,
        defaultBrain: cfg.defaultBrain,
        defaultExecutor: cfg.defaultExecutor,
        defaultConversationMode: cfg.defaultConversationMode,
      };
      status.checks.push({ check: 'brain-command-config', status: 'PASS', reason: cfgFile });
    } catch (e) {
      status.config.parseable = false;
      status.config.error = e && e.message;
      status.config.reason = e && e.message;
      status.checks.push({ check: 'brain-command-config', status: 'FAIL', reason: status.config.reason });
    }
  }

  status.ok = status.skill.discoverable && status.config.status === 'PASS';
  status.exitCode = status.ok ? 0 : 1;
  return status;
}

export function formatBrainCommandStatus(status) {
  const lines = [];
  lines.push('brain-command status');
  lines.push('--------------------');
  for (const c of (status && status.checks) || []) {
    lines.push(String(c.status).padEnd(5) + ' ' + c.check + ' :: ' + c.reason);
  }
  if (status && status.config && status.config.status === 'PASS' && status.fields) {
    lines.push('');
    lines.push('configuration:');
    lines.push('  orchestratorRoot: ' + status.fields.orchestratorRoot);
    lines.push('  dataRoot:         ' + status.fields.dataRoot);
    lines.push('  workspaceRoot:    ' + status.fields.workspaceRoot);
    lines.push('  defaultBrain:     ' + status.fields.defaultBrain);
    lines.push('  defaultExecutor:  ' + status.fields.defaultExecutor);
    lines.push('  defaultConversationMode: ' + status.fields.defaultConversationMode);
  }
  lines.push('');
  lines.push(status && status.ok
    ? 'OK: brain-command is installed and configured.'
    : 'NOT OK: see diagnostics above; run `npm run setup:brain-command` (or full doctor) to fix.');
  return lines.join('\n');
}

// --- Broad-discovery telemetry (RFC §17 / §I) ----------------------------------
// The fast path must contain no broad filesystem search. If any explicit fallback /
// setup discovery path is used, it marks broadDiscoveryOccurred = true.
export function markBroadDiscovery(metrics = {}) {
  return { ...metrics, broadDiscoveryOccurred: true };
}

// Explicit fallback/setup discovery ONLY. Bounded BFS over candidate roots; this is
// not part of the normal fast path and always marks that broad discovery occurred.
export function discoverBroadRepoDir({ roots = [], config = null, maxDepth = 3 } = {}) {
  const metrics = { broadDiscoveryOccurred: true };
  const queue = (roots || []).map((r) => ({ dir: r, depth: 0 }));
  const seen = new Set();
  let repoDir = null;
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (!dir || seen.has(dir) || depth > maxDepth) continue;
    seen.add(dir);
    if (isInsideRepo(dir)) { repoDir = dir; break; }
    if (depth < maxDepth) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of entries) {
        if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.git')) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
  }
  if (!repoDir && config && config.workspaceRoot) repoDir = config.workspaceRoot;
  return { repoDir, source: repoDir ? 'broad' : 'broad-unresolved', ...metrics };
}

function isInsideWorkspace(cwd, wroot) {
  const c = path.resolve(cwd);
  const w = path.resolve(wroot);
  return c === w || c.startsWith(w + path.sep);
}

// Deterministic repository resolution (RFC §6). Order: invoked inside target repo
// (cwd), explicit local path, explicit GitHub repo via configured workspace policy,
// config.workspaceRoot. Broad recursive search is never part of normal startup.
export function resolveRepoDir({ cwd = null, explicitRepoPath = null, explicitGitHubRepo = null, config = null, workspaceRoot = null } = {}) {
  const metrics = { broadDiscoveryOccurred: false };
  const wroot = workspaceRoot || (config && config.workspaceRoot) || null;
  // 1. invoked inside the target repo -> prefer cwd
  if (cwd && wroot && isInsideWorkspace(cwd, wroot)) return { repoDir: path.resolve(cwd), source: 'cwd', ...metrics };
  // 2. explicit local repo path
  if (explicitRepoPath) return { repoDir: path.resolve(explicitRepoPath), source: 'explicit', ...metrics };
  // 3. explicit GitHub repo -> resolve through configured workspace/clone policy
  if (explicitGitHubRepo && wroot) return { repoDir: wroot, source: 'github-config', ...metrics };
  // 4. config workspaceRoot
  if (wroot) return { repoDir: wroot, source: 'config', ...metrics };
  // 5. cwd if it is a repo (fallback; still deterministic, not a discovery scan)
  if (cwd && isInsideRepo(cwd)) return { repoDir: path.resolve(cwd), source: 'cwd', ...metrics };
  return { repoDir: null, source: 'unresolved', ...metrics };
}

// Resolve the orchestrator installation root deterministically.
export function resolveOrchestratorRoot({ cwd = null, explicitRoot = null, config = null } = {}) {
  if (config && config.orchestratorRoot) return { orchestratorRoot: config.orchestratorRoot, source: 'config', ...{ broadDiscoveryOccurred: false } };
  if (explicitRoot) return { orchestratorRoot: path.resolve(explicitRoot), source: 'explicit', ...{ broadDiscoveryOccurred: false } };
  // self-identify: if cwd contains this orchestrator's source, use it.
  if (cwd && fs.existsSync(path.join(path.resolve(cwd), 'src', 'protocol.js'))) {
    return { orchestratorRoot: path.resolve(cwd), source: 'cwd-self', ...{ broadDiscoveryOccurred: false } };
  }
  return { orchestratorRoot: null, source: 'unresolved', broadDiscoveryOccurred: false };
}

// Fast preflight (RFC §7): runs on every task; must not require full doctor.
export function fastPreflight({ config = null, probes = {} } = {}) {
  const cfg = config || {};
  const checks = [];
  const add = (name, ok, reason) => checks.push({ check: name, status: ok ? 'PASS' : 'FAIL', reason });

  // orchestrator installation/config resolvable
  if (cfg.orchestratorRoot) {
    const ok = probes.orchestratorRoot != null ? !!probes.orchestratorRoot : fs.existsSync(cfg.orchestratorRoot);
    add('orchestrator-install', ok, cfg.orchestratorRoot);
  } else add('orchestrator-install', false, 'no orchestratorRoot');

  // repo resolvable + exists
  const r = resolveRepoDir({ cwd: probes.cwd, explicitRepoPath: probes.explicitRepoPath, config: cfg, workspaceRoot: cfg.workspaceRoot });
  add('repo-resolvable', !!r.repoDir, r.repoDir || r.source);
  if (r.repoDir) {
    const ok = probes.repoExists != null ? !!probes.repoExists : fs.existsSync(r.repoDir);
    add('repo-exists', ok, r.repoDir);
  }

  // codex executable available
  {
    const codexJs = cfg.codexJs || DEFAULT_CODEX_JS;
    const ok = probes.codexAvailable != null ? !!probes.codexAvailable : !!codexJs && fs.existsSync(codexJs);
    add('codex-executable', ok, codexJs || 'no codexJs configured');
  }

  // durable data root available
  if (cfg.dataRoot) {
    const ok = probes.dataRootWritable != null ? !!probes.dataRootWritable : probeWritable(cfg.dataRoot);
    add('data-root-writable', ok, cfg.dataRoot);
  } else add('data-root-writable', false, 'no dataRoot');

  // IAB / Brain transport callable
  {
    const ok = probes.iabCallable != null ? !!probes.iabCallable : false;
    add('iab-callable', ok, ok ? 'iab transport callable' : 'iab transport not probed (runtime)');
  }

  return { pass: checks.every((c) => c.status === 'PASS'), checks };
}

// Full doctor (RFC §7): only for setup / env change / preflight failure / explicit use.
export async function fullDoctor({ config = null, codexJs = null, repoDir = null, stateDir = null } = {}) {
  const cfg = config || {};
  const out = [...doctorStatic({ codexJs: codexJs || cfg.codexJs, stateDir: stateDir || cfg.dataRoot, repoDir: repoDir || cfg.workspaceRoot })];
  const dl = await import('./doctor.js');
  const targetRepo = repoDir || cfg.workspaceRoot;
  if (targetRepo) {
    try { out.push(dl.doctorGit({ repoDir: targetRepo })); } catch (e) {}
  }
  try { out.push(await dl.doctorIpc()); } catch (e) {}
  out.push(...dl.doctorCompat());
  return out;
}

// Natural-language trigger detection for the brain-command launcher skill.
export function isBrainCommandTrigger(text) {
  return /(指挥模式|让\s*ChatGPT\s*指挥|use\s+ChatGPT\s+as\s+the\s+brain|chatgpt\s+command\s+mode|brain\s*:\s*chatgpt|brain\s*=\s*chatgpt)/i.test(String(text || ''));
}

// --- Dogfood instrumentation (RFC §17 / §I) -------------------------------------
// Lightweight metrics: bootstrap elapsed time to first valid Brain PLAN/TASK,
// bootstrap tool/action count, broad-discovery occurrence, packet sizes, and
// full-suite verification count. This is NOT a cost ledger.
export function newBootstrapMetrics() {
  return {
    startedAt: Date.now(),
    firstValidPlanTaskAt: null,
    bootstrapToolCount: 0,
    broadDiscoveryOccurred: false,
    stepPacketBytes: null,
    resultPacketBytes: null,
    fullSuiteVerificationCount: 0,
  };
}

export function recordBootstrapMetric(metrics, patch = {}) {
  return { ...metrics, ...patch };
}

export function bootstrapElapsedMs(metrics) {
  if (!metrics || typeof metrics.startedAt !== 'number') return null;
  return (metrics.firstValidPlanTaskAt || Date.now()) - metrics.startedAt;
}
