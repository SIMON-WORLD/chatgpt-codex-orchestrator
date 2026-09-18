import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AuthorizedWorkspaceRootInstallError,
  AuthorizedWorkspaceRootInstaller,
  applyExactAuthorizedWorkspaceRoot,
} from '../../src/activation/authorized-workspace-root-installer.js';

const TARGET = 'c'.repeat(40);
const PREVIOUS = 'd'.repeat(40);

function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, 'authorized-workspace');
  fs.mkdirSync(workspace);
  const configPath = path.join(root, 'stable.json');
  return { root, workspace, configPath };
}

function activationPass(sha) {
  return {
    status: 'PASS',
    alreadyActive: false,
    sha,
    repo: '/must-not-surface',
    configPath: '/must-not-surface/stable.json',
    profile: { workspaceRoots: ['/must-not-surface'] },
    evidence: {
      healthz: { status: 'ok', revision: sha },
      readyz: { status: 'ready', revision: sha, loopback: true, hasAllowedRoots: true },
      tunnel: { ok: true, status: 200 },
    },
    tunnelLifecycle: 'external-preserved',
  };
}

test('exact authorized root append preserves unrelated config and diagnostics', () => {
  const raw = {
    workspaceRoots: ['C:\\existing-a'],
    diagnostics: { localReadOnlyFixture: 'C:\\smoke', extra: true },
    worktree: { trustedRepos: ['C:\\repo'] },
    custom: { keep: 42 },
  };

  const out = applyExactAuthorizedWorkspaceRoot(raw, 'C:\\approved\\research', { platform: 'win32' });

  assert.equal(out.changed, true);
  assert.equal(out.rootAdded, true);
  assert.deepEqual(out.config.workspaceRoots, ['C:\\existing-a', 'C:\\approved\\research']);
  assert.deepEqual(out.config.diagnostics, raw.diagnostics);
  assert.deepEqual(out.config.worktree, raw.worktree);
  assert.deepEqual(out.config.custom, raw.custom);
});

test('legacy workspaceRoot remains effective when workspaceRoots is materialized', () => {
  const raw = {
    workspaceRoot: 'C:\\existing-single',
    diagnostics: { localReadOnlyFixture: 'C:\\smoke' },
  };

  const out = applyExactAuthorizedWorkspaceRoot(raw, 'C:\\approved\\research', { platform: 'win32' });

  assert.deepEqual(out.config.workspaceRoots, ['C:\\existing-single', 'C:\\approved\\research']);
  assert.equal(out.config.workspaceRoot, 'C:\\existing-single');
  assert.deepEqual(out.config.diagnostics, raw.diagnostics);
});

test('exact authorized root presence is idempotent and case-insensitive on Windows', () => {
  const raw = {
    workspaceRoots: ['C:\\Existing', 'C:\\Approved\\Research'],
    diagnostics: { localReadOnlyFixture: 'C:\\smoke' },
  };

  const out = applyExactAuthorizedWorkspaceRoot(raw, 'c:\\approved\\research', { platform: 'win32' });

  assert.equal(out.changed, false);
  assert.equal(out.rootAdded, false);
  assert.equal(out.exactPresent, true);
  assert.deepEqual(out.config, raw);
});

test('installer binds only exact directory metadata, does not enumerate contents, and returns sanitized PASS evidence', async () => {
  const { workspace, configPath } = makeRoot('authorized-root-install-');
  fs.writeFileSync(path.join(workspace, 'research-data.bin'), 'opaque fixture content', 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    workspaceRoots: [],
    diagnostics: { localReadOnlyFixture: 'preserve-this' },
  }, null, 2));

  let enumerated = 0;
  const fsImpl = new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === 'readdirSync' || prop === 'opendirSync') {
        return (...args) => {
          enumerated += 1;
          throw new Error(`unexpected enumeration: ${String(args[0])}`);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const installer = new AuthorizedWorkspaceRootInstaller({
    fsImpl,
    probeCurrent: async () => ({ sha: PREVIOUS, pid: 101 }),
    activateTarget: async () => activationPass(TARGET),
  });

  const result = await installer.install({
    workspaceRootPath: workspace,
    configPath,
    targetSha: TARGET,
  });

  assert.equal(enumerated, 0);
  assert.equal(result.status, 'PASS');
  assert.equal(result.rootAuthorized, true);
  assert.equal(result.rootAdded, true);
  assert.equal(result.activation.sha, TARGET);
  assert.equal(result.activation.readiness.healthStatus, 'ok');
  assert.equal(result.activation.readiness.readyStatus, 'ready');
  assert.equal(result.activation.readiness.tunnelOk, true);

  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(saved.workspaceRoots, [fs.realpathSync(workspace)]);
  assert.equal(saved.diagnostics.localReadOnlyFixture, 'preserve-this');

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(fs.realpathSync(workspace)), false);
  assert.equal(serialized.includes('research-data.bin'), false);
  assert.equal(serialized.includes('/must-not-surface'), false);
});

test('activation failure restores original config and reports no authorized path', async () => {
  const { workspace, configPath } = makeRoot('authorized-root-rollback-');
  const original = JSON.stringify({
    workspaceRoots: ['existing-root'],
    diagnostics: { localReadOnlyFixture: 'preserve-this' },
  }, null, 2) + '\n';
  fs.writeFileSync(configPath, original);

  const calls = [];
  const installer = new AuthorizedWorkspaceRootInstaller({
    fsImpl: fs,
    probeCurrent: async () => ({ sha: PREVIOUS, pid: 101 }),
    activateTarget: async ({ targetSha }) => {
      calls.push(targetSha);
      if (targetSha === TARGET) {
        const error = new Error('target activation failed');
        error.details = { phase: 'runtime_readiness' };
        throw error;
      }
      return activationPass(PREVIOUS);
    },
  });

  let thrown;
  try {
    await installer.install({
      workspaceRootPath: workspace,
      configPath,
      targetSha: TARGET,
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof AuthorizedWorkspaceRootInstallError);
  assert.equal(thrown.details.phase, 'activate_updated_profile');
  assert.equal(thrown.details.causePhase, 'runtime_readiness');
  assert.equal(thrown.details.rollback.status, 'restored');
  assert.deepEqual(calls, [TARGET, PREVIOUS]);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(JSON.stringify(thrown.details).includes(fs.realpathSync(workspace)), false);
});

test('installer rejects a non-directory before probing or changing config', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authorized-root-file-'));
  const workspace = path.join(root, 'not-a-directory.txt');
  fs.writeFileSync(workspace, 'x', 'utf8');
  const configPath = path.join(root, 'stable.json');
  const original = '{"workspaceRoots":[]}\n';
  fs.writeFileSync(configPath, original);

  let probes = 0;
  let activations = 0;
  const installer = new AuthorizedWorkspaceRootInstaller({
    fsImpl: fs,
    probeCurrent: async () => { probes += 1; return { sha: PREVIOUS }; },
    activateTarget: async () => { activations += 1; return activationPass(TARGET); },
  });

  await assert.rejects(
    () => installer.install({ workspaceRootPath: workspace, configPath, targetSha: TARGET }),
    /existing directory/i,
  );

  assert.equal(probes, 0);
  assert.equal(activations, 0);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});
