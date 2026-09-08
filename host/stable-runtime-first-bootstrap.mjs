#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXACT_SHA_RE = /^[0-9a-f]{40}$/i;
const ACTIVATION_EVIDENCE_PREFIX = 'STABLE_RUNTIME_ACTIVATION ';
const MAX_STRUCTURED_STRING_CHARS = 2048;
const MAX_STRUCTURED_ARRAY_ITEMS = 20;
const MAX_STRUCTURED_OBJECT_KEYS = 50;
const MAX_FALLBACK_CHARS = 512;
const MAX_FALLBACK_LINES = 4;
const SENSITIVE_DIAGNOSTIC_KEY_RE = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token|^env$|^environment$|^stdout$|^stderr$)/i;
const REQUIRED_TARGET_FILES = [
  'scripts/stable-runtime-activate.mjs',
  'src/activation/stable-runtime-activator.js',
];

export class StableRuntimeFirstBootstrapError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StableRuntimeFirstBootstrapError';
    this.details = details;
  }
}

function comparePath(value, platform = process.platform) {
  const normalized = path.resolve(String(value));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function exactSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  if (!EXACT_SHA_RE.test(sha)) {
    throw new StableRuntimeFirstBootstrapError('target SHA must be an exact 40-hex commit SHA', { phase: 'target_binding' });
  }
  return sha;
}

export function deriveActivationRoot(repoPath) {
  const repo = path.resolve(repoPath);
  return path.join(path.dirname(repo), `${path.basename(repo)}-runtime-activations`);
}

export async function runCommand(file, args, { cwd = undefined, env = process.env } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      const result = { code: code ?? -1, stdout, stderr };
      if (code === 0) return resolve(result);
      const error = new Error(`${file} exited with code ${code}`);
      error.result = result;
      reject(error);
    });
  });
}

function loadBootstrapBinding(fsImpl, configPath, repoPath, platform) {
  const absoluteConfigPath = path.resolve(String(configPath || ''));
  if (!configPath || !fsImpl.existsSync(absoluteConfigPath)) {
    throw new StableRuntimeFirstBootstrapError('existing Stable Runtime config file is required', { phase: 'profile_binding', configPath: absoluteConfigPath });
  }
  let raw;
  try { raw = JSON.parse(fsImpl.readFileSync(absoluteConfigPath, 'utf8')); }
  catch {
    throw new StableRuntimeFirstBootstrapError('existing Stable Runtime config file is not valid JSON', { phase: 'profile_binding', configPath: absoluteConfigPath });
  }

  const trustedRepos = Array.isArray(raw?.worktree?.trustedRepos)
    ? raw.worktree.trustedRepos.filter(Boolean).map((entry) => String(entry))
    : [];
  if (!trustedRepos.length) {
    throw new StableRuntimeFirstBootstrapError('Stable Runtime config must declare a trusted canonical repository', { phase: 'profile_binding' });
  }
  if (trustedRepos.some((entry) => !path.isAbsolute(entry))) {
    throw new StableRuntimeFirstBootstrapError('first bootstrap requires absolute trusted repository paths in the existing Stable Runtime config', { phase: 'profile_binding' });
  }

  const selected = repoPath || (trustedRepos.length === 1 ? trustedRepos[0] : null);
  if (!selected) {
    throw new StableRuntimeFirstBootstrapError('multiple trusted repositories are configured; bind one exact trusted repo', { phase: 'profile_binding' });
  }
  let repo;
  try { repo = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(selected) : fsImpl.realpathSync(selected); }
  catch {
    throw new StableRuntimeFirstBootstrapError('trusted canonical repository does not exist', { phase: 'profile_binding', repo: path.resolve(selected) });
  }
  const trustedReal = trustedRepos.map((entry) => {
    try { return fsImpl.realpathSync.native ? fsImpl.realpathSync.native(entry) : fsImpl.realpathSync(entry); }
    catch { return path.resolve(entry); }
  });
  if (!trustedReal.some((entry) => comparePath(entry, platform) === comparePath(repo, platform))) {
    throw new StableRuntimeFirstBootstrapError('selected repository is not bound by the existing Stable Runtime trusted-repo profile', { phase: 'profile_binding', repo });
  }
  return { absoluteConfigPath, repo };
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|authorization|cookie|credential|password|secret|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1=[REDACTED]');
}

function boundedStructuredValue(value, depth = 0) {
  if (depth > 6) return '[TRUNCATED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const redacted = redactSensitiveText(value);
    return redacted.length <= MAX_STRUCTURED_STRING_CHARS
      ? redacted
      : `${redacted.slice(0, MAX_STRUCTURED_STRING_CHARS - 3)}...`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_STRUCTURED_ARRAY_ITEMS).map((entry) => boundedStructuredValue(entry, depth + 1));
  }
  if (!value || typeof value !== 'object') return undefined;

  const out = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_STRUCTURED_OBJECT_KEYS)) {
    if (SENSITIVE_DIAGNOSTIC_KEY_RE.test(key)) continue;
    const bounded = boundedStructuredValue(entry, depth + 1);
    if (bounded !== undefined) out[key] = bounded;
  }
  return out;
}

export function parseActivationFailureEvidence(stderr, stdout) {
  for (const output of [stderr, stdout]) {
    for (const line of String(output || '').split(/\r?\n/)) {
      if (!line.startsWith(ACTIVATION_EVIDENCE_PREFIX)) continue;
      try {
        const payload = JSON.parse(line.slice(ACTIVATION_EVIDENCE_PREFIX.length));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.status !== 'FAIL') continue;
        return boundedStructuredValue(payload);
      } catch {}
    }
  }
  return null;
}

function boundedOutputSnippet(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-MAX_FALLBACK_LINES);
  if (!lines.length) return null;
  const redacted = redactSensitiveText(lines.join(' | '));
  return redacted.length <= MAX_FALLBACK_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_FALLBACK_CHARS - 3)}...`;
}

function parseActivationResult(output) {
  const line = String(output || '').split(/\r?\n/).find((entry) => entry.startsWith(ACTIVATION_EVIDENCE_PREFIX));
  if (!line) throw new StableRuntimeFirstBootstrapError('target activator did not emit structured activation evidence', { phase: 'target_activator' });
  try { return JSON.parse(line.slice(ACTIVATION_EVIDENCE_PREFIX.length)); }
  catch { throw new StableRuntimeFirstBootstrapError('target activator emitted invalid structured activation evidence', { phase: 'target_activator' }); }
}

export function firstBootstrapFailurePayload(error) {
  return {
    status: 'FAIL',
    message: error?.message || String(error),
    ...(error instanceof StableRuntimeFirstBootstrapError ? error.details : {}),
  };
}

export async function firstBootstrap(
  { targetSha, configPath, repoPath = null },
  { fsImpl = fs, run = runCommand, platform = process.platform } = {},
) {
  const sha = exactSha(targetSha);
  const { absoluteConfigPath, repo } = loadBootstrapBinding(fsImpl, configPath, repoPath, platform);

  try {
    await run('git', ['-C', repo, 'fetch', '--quiet', 'origin', 'main']);
    const resolved = (await run('git', ['-C', repo, 'rev-parse', `${sha}^{commit}`])).stdout.trim().toLowerCase();
    if (resolved !== sha) throw new Error('resolved SHA mismatch');
    await run('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, 'origin/main']);
  } catch (error) {
    throw new StableRuntimeFirstBootstrapError('target SHA is missing, mismatched, or not reachable from origin/main', {
      phase: 'target_binding', sha, cause: error?.message || String(error),
    });
  }

  const activationRoot = deriveActivationRoot(repo);
  const checkout = path.join(activationRoot, sha);
  fsImpl.mkdirSync(activationRoot, { recursive: true });
  if (!fsImpl.existsSync(checkout)) {
    await run('git', ['-C', repo, 'worktree', 'add', '--detach', checkout, sha]);
  }

  let preparedHead;
  let dirty;
  try {
    preparedHead = (await run('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim().toLowerCase();
    dirty = (await run('git', ['-C', checkout, 'status', '--porcelain'])).stdout.trim();
  } catch (error) {
    throw new StableRuntimeFirstBootstrapError('unable to validate isolated target activation checkout', {
      phase: 'prepare_target_checkout', checkout, cause: error?.message || String(error),
    });
  }
  if (preparedHead !== sha || dirty) {
    throw new StableRuntimeFirstBootstrapError('isolated target activation checkout is not exact and clean', {
      phase: 'prepare_target_checkout', checkout, expectedSha: sha, actualSha: preparedHead, dirty: !!dirty,
    });
  }

  const missing = REQUIRED_TARGET_FILES.filter((relative) => !fsImpl.existsSync(path.join(checkout, relative)));
  if (missing.length) {
    throw new StableRuntimeFirstBootstrapError('exact target checkout does not contain the full Stable Runtime activator', {
      phase: 'prepare_target_checkout', checkout, missing,
    });
  }

  let targetRun;
  try {
    targetRun = await run(
      process.execPath,
      ['scripts/stable-runtime-activate.mjs', '--sha', sha, '--config', absoluteConfigPath, '--repo', repo],
      { cwd: checkout, env: process.env },
    );
  } catch (error) {
    const childResult = error?.result && typeof error.result === 'object' ? error.result : null;
    const childFailure = parseActivationFailureEvidence(childResult?.stderr, childResult?.stdout);
    if (childFailure) {
      const details = {
        bootstrapPhase: 'target_activator',
        requestedSha: sha,
        checkout,
        targetExitCode: childResult?.code ?? null,
        ...childFailure,
      };
      if (!details.phase) details.phase = 'target_activator';
      throw new StableRuntimeFirstBootstrapError(childFailure.message || 'target checkout activator failed', details);
    }

    const stderrSummary = boundedOutputSnippet(childResult?.stderr);
    const stdoutSummary = boundedOutputSnippet(childResult?.stdout);
    throw new StableRuntimeFirstBootstrapError('target checkout activator failed', {
      phase: 'target_activator',
      sha,
      checkout,
      cause: error?.message || String(error),
      targetExitCode: childResult?.code ?? null,
      ...(stderrSummary ? { targetStderrSummary: stderrSummary } : {}),
      ...(stdoutSummary ? { targetStdoutSummary: stdoutSummary } : {}),
    });
  }

  const targetActivation = parseActivationResult(targetRun.stdout);
  if (targetActivation?.status !== 'PASS' || targetActivation?.sha !== sha) {
    throw new StableRuntimeFirstBootstrapError('target activator did not prove PASS for the exact requested SHA', {
      phase: 'target_activator', sha, checkout, targetActivation,
    });
  }

  return {
    status: 'PASS', sha, repo, configPath: absoluteConfigPath, checkout,
    bootstrapArtifactIndependentOfCanonicalCheckout: true,
    targetActivation,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sha') out.targetSha = argv[++i];
    else if (arg === '--config') out.configPath = argv[++i];
    else if (arg === '--repo') out.repoPath = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    'Stable Runtime first bootstrap (single-file host artifact)',
    '',
    'This file is intentionally self-contained and may live outside a stale canonical checkout.',
    'It accepts one Parent-approved exact SHA plus the existing Stable Runtime config, materializes an isolated exact target checkout, then enters the target checkout activator.',
    '',
    'Arguments: --sha <exact-40-hex-commit> --config <existing-stable-v0.2-config.json> [--repo <trusted-canonical-repo>]',
    'Equivalent host-launcher environment: STABLE_RUNTIME_TARGET_SHA, STABLE_RUNTIME_CONFIG, optional STABLE_RUNTIME_REPO.',
  ].join('\n');
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  args.targetSha ||= process.env.STABLE_RUNTIME_TARGET_SHA;
  args.configPath ||= process.env.STABLE_RUNTIME_CONFIG;
  args.repoPath ||= process.env.STABLE_RUNTIME_REPO || null;
  if (!args.targetSha || !args.configPath) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const result = await firstBootstrap(args);
    process.stdout.write(`STABLE_RUNTIME_FIRST_BOOTSTRAP ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`STABLE_RUNTIME_FIRST_BOOTSTRAP ${JSON.stringify(firstBootstrapFailurePayload(error))}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) await main();
