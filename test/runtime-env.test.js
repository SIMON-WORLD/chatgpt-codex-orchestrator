// chatgpt-codex-orchestrator: runtime environment adapter tests.
// Verifies the abstraction resolves env/cwd/home/codexHome in both a normal Node
// environment and a trusted-REPL-like environment that exposes NO global `process`.
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import {
  isTrustedRepl, processRef, nodeReplRef,
  getEnv, getCwd, getHomeDir, getCodexHome, getRuntimeEnv,
} from '../src/runtime-env.js';

// A trusted-REPL-like scope: has nodeRepl.rpc but NO global `process`.
function trustedScope(overrides = {}) {
  const scope = {
    nodeRepl: {
      rpc() { return null; },
      env: {},
      cwd: 'C:\\repl\\cwd',
      homeDir: null,
      ...(overrides.nodeRepl || {}),
    },
  };
  if (overrides.noNodeRepl) delete scope.nodeRepl;
  return scope;
}

test('normal Node environment adapter uses real process/os values', () => {
  const rt = getRuntimeEnv();
  assert.strictEqual(rt.isTrustedRepl, false);
  assert.strictEqual(rt.env, process.env, 'env is the real process env');
  assert.strictEqual(rt.cwd, process.cwd(), 'cwd is the real cwd');
  const expectedHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
  assert.strictEqual(rt.homeDir, expectedHome, 'homeDir matches process/os home');
  assert.strictEqual(rt.codexHome, process.env.CODEX_HOME || path.join(expectedHome, '.codex'));
  assert.strictEqual(processRef(), process, 'processRef returns the real process');
  assert.strictEqual(nodeReplRef(), null, 'no nodeRepl in normal node');
});

test('trusted REPL adapter without a global process resolves from nodeRepl', () => {
  const scope = trustedScope({
    nodeRepl: { env: { CODEX_HOME: 'C:\\repl\\codex-home' }, cwd: 'C:\\repl\\cwd', homeDir: 'C:\\repl\\home' },
  });
  assert.strictEqual(processRef(scope), null, 'scope has no process global');
  assert.strictEqual(isTrustedRepl(scope), true);
  const rt = getRuntimeEnv(scope);
  assert.strictEqual(rt.isTrustedRepl, true);
  assert.strictEqual(rt.env.CODEX_HOME, 'C:\\repl\\codex-home');
  assert.strictEqual(rt.cwd, 'C:\\repl\\cwd');
  assert.strictEqual(rt.homeDir, 'C:\\repl\\home');
  assert.strictEqual(rt.codexHome, 'C:\\repl\\codex-home', 'CODEX_HOME override wins');
  assert.strictEqual(getCwd(scope), 'C:\\repl\\cwd');
  assert.strictEqual(getHomeDir(scope), 'C:\\repl\\home');
});

test('trusted REPL falls back to os.homedir()/~/.codex when nodeRepl.homeDir is empty', () => {
  const scope = trustedScope({ nodeRepl: { env: {}, cwd: 'C:\\repl\\cwd', homeDir: null } });
  const rt = getRuntimeEnv(scope);
  assert.strictEqual(rt.homeDir, os.homedir(), 'falls back to os.homedir()');
  assert.strictEqual(rt.codexHome, path.join(os.homedir(), '.codex'), 'codxHome defaults to ~/.codex');
  assert.strictEqual(rt.cwd, 'C:\\repl\\cwd');
});

test('isTrustedRepl requires nodeRepl.rpc; absent/non-rpc nodeRepl is not trusted', () => {
  assert.strictEqual(isTrustedRepl({ nodeRepl: { rpc() {} } }), true);
  assert.strictEqual(isTrustedRepl({ nodeRepl: {} }), false);
  assert.strictEqual(isTrustedRepl({}), false);
  assert.strictEqual(isTrustedRepl(), false, 'default scope in normal node is not trusted');
});

test('adapter does not require a process global nor fabricate values', () => {
  const scope = trustedScope({ nodeRepl: { env: {}, cwd: 'C:\\repl\\cwd', homeDir: null } });
  // A redundant but explicit guard: nothing throws with no process in scope.
  const env = getEnv(scope);
  assert.deepStrictEqual(env, {});
  assert.strictEqual(typeof getCwd(scope), 'string');
  assert.strictEqual(typeof getHomeDir(scope), 'string');
  assert.strictEqual(typeof getCodexHome(scope), 'string');
  assert.ok(getCodexHome(scope).length > 0);
});
