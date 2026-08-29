// chatgpt-codex-orchestrator: trusted-REPL runtime environment adapter.
// brain-command launcher/bootstrap MUST NOT assume the global `process` object exists.
// Normal Node: derive env/cwd/home from the real process + node:os.
// Trusted Codex node REPL: `process` may be absent. The safe environment surface is
// globalThis.nodeRepl (cwd, env, homeDir, rpc = in-app-browser service). This module
// derives the same abstract values from either source, never fabricates behavior, and
// never monkey-patches globalThis.process.
import os from 'node:os';
import path from 'node:path';

const G = typeof globalThis !== 'undefined' ? globalThis : {};

export function nodeReplRef(scope = G) {
  return (scope && scope.nodeRepl) || null;
}

export function processRef(scope = G) {
  return (scope && typeof scope.process !== 'undefined') ? scope.process : null;
}

// Trusted Codex REPL = globalThis.nodeRepl exposes a working `.rpc` (browser service).
export function isTrustedRepl(scope = G) {
  const nr = nodeReplRef(scope);
  return !!(nr && typeof nr.rpc === 'function');
}

export function getEnv(scope = G) {
  const p = processRef(scope);
  if (p && p.env && typeof p.env === 'object') return p.env;
  const nr = nodeReplRef(scope);
  return (nr && nr.env && typeof nr.env === 'object') ? nr.env : {};
}

export function getCwd(scope = G) {
  const p = processRef(scope);
  if (p && typeof p.cwd === 'function') {
    try { const c = p.cwd(); if (typeof c === 'string' && c) return c; } catch { /* ignore */ }
  }
  const nr = nodeReplRef(scope);
  if (nr) {
    if (typeof nr.cwd === 'function') { try { const c = nr.cwd(); if (typeof c === 'string' && c) return c; } catch { /* ignore */ } }
    if (typeof nr.cwd === 'string' && nr.cwd) return nr.cwd;
  }
  return os.homedir();
}

export function getHomeDir(scope = G) {
  const e = getEnv(scope);
  if (e.HOME) return e.HOME;
  if (e.USERPROFILE) return e.USERPROFILE;
  const nr = nodeReplRef(scope);
  if (nr) {
    if (typeof nr.homeDir === 'function') { try { const h = nr.homeDir(); if (typeof h === 'string' && h) return h; } catch { /* ignore */ } }
    if (typeof nr.homeDir === 'string' && nr.homeDir) return nr.homeDir;
  }
  return os.homedir();
}

// $CODEX_HOME defaults to ~/.codex.
export function getCodexHome(scope = G) {
  const e = getEnv(scope);
  return e.CODEX_HOME || path.join(getHomeDir(scope), '.codex');
}

// Compact, stable snapshot consumed by the launcher/bootstrap. `scope` may be injected
// in tests to simulate a trusted-REPL-like environment without a process global; normal
// callers omit it and read the real process / node:os values.
export function getRuntimeEnv(scope = G) {
  const trusted = isTrustedRepl(scope);
  return {
    isTrustedRepl: trusted,
    trustedRepl: trusted,
    env: getEnv(scope),
    cwd: getCwd(scope),
    homeDir: getHomeDir(scope),
    codexHome: getCodexHome(scope),
    nodeRepl: nodeReplRef(scope),
  };
}
