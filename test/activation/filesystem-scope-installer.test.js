import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyFilesystemScopePolicy,
  FilesystemScopeInstallError,
  FilesystemScopeInstaller,
} from '../../src/activation/filesystem-scope-installer.js';

const TARGET = 'a'.repeat(40);
const PREVIOUS = 'b'.repeat(40);

function fixture(prefix = 'filesystem-scope-install-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const oldRoot = path.join(root, 'old');
  const newRoot = path.join(root, 'new');
  fs.mkdirSync(oldRoot);
  fs.mkdirSync(newRoot);
  const configPath = path.join(root, 'stable.json');
  return { root, oldRoot, newRoot, configPath };
}

function pass(sha) {
  return {
    status: 'PASS',
    alreadyActive: false,
    sha,
    evidence: {
      healthz: { status: 'ok', revision: sha },
      readyz: { status: 'ready', revision: sha, loopback: true, hasAllowedRoots: true },
      tunnel: { ok: true, status: 200 },
    },
    tunnelLifecycle: 'external-preserved',
  };
}

test('scope policy update preserves unrelated config and clears a narrowed legacy workspaceRoot', () => {
  const f = fixture();
  const raw = {
    workspaceRoot: f.oldRoot,
    workspaceRoots: [f.oldRoot],
    diagnostics: { localReadOnlyFixture: 'preserve-me', extra: true },
    custom: { keep: 42 },
  };
  const out = applyFilesystemScopePolicy(raw, {
    policy: 'selected_roots',
    selectedRoots: [f.newRoot],
  });
  assert.equal(out.changed, true);
  assert.deepEqual(out.config.workspaceRoots, [f.newRoot]);
  assert.equal(out.config.workspaceRoot, null);
  assert.deepEqual(out.config.diagnostics, raw.diagnostics);
  assert.deepEqual(out.config.custom, raw.custom);
});

test('same policy and same root are idempotent and never enumerate contents', async () => {
  const f = fixture('filesystem-scope-idempotent-');
  fs.writeFileSync(f.configPath, JSON.stringify({
    filesystemScope: 'selected_roots',
    workspaceRoots: [f.oldRoot],
    custom: { keep: true },
  }, null, 2) + '\n');
  let activated = 0;
  let enumerated = 0;
  const fsImpl = new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === 'readdirSync' || prop === 'opendirSync') {
        return () => { enumerated += 1; throw new Error('unexpected enumeration'); };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const installer = new FilesystemScopeInstaller({
    fsImpl,
    probeCurrent: async () => ({ sha: PREVIOUS }),
    activateTarget: async () => { activated += 1; return pass(TARGET); },
  });
  const result = await installer.install({
    policy: 'selected_roots',
    selectedRoots: [f.oldRoot],
    configPath: f.configPath,
    targetSha: TARGET,
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.idempotent, true);
  assert.equal(result.configChanged, false);
  assert.equal(activated, 0);
  assert.equal(enumerated, 0);
});

test('Windows short and canonical realpath forms are idempotent', () => {
  const shortRoot = 'C:\\Users\\Dev\\APP~1';
  const canonicalRoot = 'C:\\Users\\Dev\\App';
  const canonicalByInput = new Map([
    [shortRoot.toLowerCase(), canonicalRoot],
    [canonicalRoot.toLowerCase(), canonicalRoot],
  ]);
  const raw = {
    filesystemScope: 'selected_roots',
    workspaceRoots: [shortRoot],
  };
  const result = applyFilesystemScopePolicy(raw, {
    policy: 'selected_roots',
    selectedRoots: [canonicalRoot],
    platform: 'win32',
    canonicalizeRoot: (value) => canonicalByInput.get(String(value).toLowerCase()) || value,
  });
  assert.equal(result.changed, false);
  assert.equal(result.idempotent, true);
  assert.deepEqual(result.config.workspaceRoots, [shortRoot]);
});

test('os_user_scope is explicit, preserves existing roots, and does not inject a drive root', async () => {
  const f = fixture('filesystem-scope-os-user-');
  const original = JSON.stringify({
    workspaceRoots: [f.oldRoot],
    custom: { keep: true },
  }, null, 2) + '\n';
  fs.writeFileSync(f.configPath, original);
  const installer = new FilesystemScopeInstaller({
    probeCurrent: async () => ({ sha: PREVIOUS }),
    activateTarget: async () => pass(TARGET),
  });
  const result = await installer.install({
    policy: 'os_user_scope',
    configPath: f.configPath,
    targetSha: TARGET,
  });
  const saved = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
  assert.equal(result.filesystemScope, 'os_user_scope');
  assert.equal(saved.filesystemScope, 'os_user_scope');
  assert.deepEqual(saved.workspaceRoots, [f.oldRoot]);
  assert.deepEqual(saved.custom, { keep: true });
  assert.equal(result.selectedRootCount, 0);
  assert.equal(JSON.stringify(result).includes(f.oldRoot), false);
});

test('activation failure restores exact config and previously proven revision', async () => {
  const f = fixture('filesystem-scope-rollback-');
  const original = JSON.stringify({
    workspaceRoot: f.oldRoot,
    workspaceRoots: [f.oldRoot],
    custom: { preserve: 'yes' },
  }, null, 2) + '\n';
  fs.writeFileSync(f.configPath, original);
  const calls = [];
  const installer = new FilesystemScopeInstaller({
    probeCurrent: async () => ({ sha: PREVIOUS }),
    activateTarget: async ({ targetSha }) => {
      calls.push(targetSha);
      if (targetSha === TARGET) {
        const error = new Error('target readiness failed');
        error.details = { phase: 'runtime_readiness' };
        throw error;
      }
      return pass(PREVIOUS);
    },
  });
  await assert.rejects(
    () => installer.install({ policy: 'os_user_scope', configPath: f.configPath, targetSha: TARGET }),
    (error) => {
      assert.ok(error instanceof FilesystemScopeInstallError);
      assert.equal(error.details.causePhase, 'runtime_readiness');
      assert.equal(error.details.rollback.status, 'restored');
      return true;
    },
  );
  assert.deepEqual(calls, [TARGET, PREVIOUS]);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
});

test('os_user_scope rejects selected-root arguments rather than silently widening or narrowing', () => {
  const raw = { workspaceRoots: ['C:\\existing'] };
  assert.throws(
    () => applyFilesystemScopePolicy(raw, { policy: 'os_user_scope', selectedRoots: ['C:\\new'] }),
    FilesystemScopeInstallError,
  );
});
