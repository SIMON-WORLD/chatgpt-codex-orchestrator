import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ReadOnlySmokeInstallError,
  ReadOnlySmokeInstaller,
  applyExactReadOnlySmokeFixture,
} from '../../src/activation/read-only-smoke-installer.js';

const TARGET = 'a'.repeat(40);
const PREVIOUS = 'b'.repeat(40);

test('exact fixture config adds only the exact path when no configured root contains it', () => {
  const raw = {
    workspaceRoot: 'C:\\existing-single',
    workspaceRoots: ['C:\\existing-a'],
    diagnostics: { codex: { enabled: true }, extra: 'preserve-me' },
    custom: { nested: 42 },
  };
  const result = applyExactReadOnlySmokeFixture(raw, 'C:\\approved\\smoke', {
    platform: 'win32',
    canonicalizeRoot: (value) => value,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.config.workspaceRoots, ['C:\\existing-a', 'C:\\approved\\smoke']);
  assert.equal(result.config.workspaceRoot, 'C:\\existing-single');
  assert.equal(result.config.diagnostics.localReadOnlyFixture, 'C:\\approved\\smoke');
  assert.deepEqual(result.config.diagnostics.codex, { enabled: true });
  assert.equal(result.config.diagnostics.extra, 'preserve-me');
  assert.deepEqual(result.config.custom, { nested: 42 });
});

test('exact fixture config does not widen roots when an existing authorized root already contains the fixture', () => {
  const raw = {
    workspaceRoots: ['C:\\approved'],
    diagnostics: { codex: { enabled: false } },
  };
  const result = applyExactReadOnlySmokeFixture(raw, 'C:\\approved\\smoke', {
    platform: 'win32',
    canonicalizeRoot: (value) => value,
  });

  assert.deepEqual(result.config.workspaceRoots, ['C:\\approved']);
  assert.equal(result.config.diagnostics.localReadOnlyFixture, 'C:\\approved\\smoke');
});

test('installer updates config and requires a non-reused recovery when config changed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-only-smoke-install-'));
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(fixture);
  const configPath = path.join(root, 'stable.json');
  fs.writeFileSync(configPath, JSON.stringify({
    workspaceRoots: [],
    diagnostics: { codex: { enabled: false } },
    unrelated: { keep: true },
  }, null, 2));

  const calls = [];
  const installer = new ReadOnlySmokeInstaller({
    fsImpl: fs,
    probeCurrent: async () => ({ sha: PREVIOUS, pid: 101 }),
    stopCurrent: async (args) => { calls.push({ stop: args }); return { stopped: true }; },
    recoverTarget: async (args) => {
      calls.push(args);
      return { status: 'PASS', sha: TARGET, runtime: { action: 'started', pid: 202 } };
    },
  });

  const result = await installer.install({
    fixturePath: fixture,
    configPath,
    targetSha: TARGET,
    repoPath: root,
  });

  assert.equal(result.status, 'PASS');
  assert.equal(result.fixtureConfigured, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].stop.pid, 101);
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.diagnostics.localReadOnlyFixture, fs.realpathSync(fixture));
  assert.deepEqual(saved.workspaceRoots, [fs.realpathSync(fixture)]);
  assert.deepEqual(saved.unrelated, { keep: true });
});

test('activation failure restores original config and recovers the previously proven revision', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-only-smoke-rollback-'));
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(fixture);
  const configPath = path.join(root, 'stable.json');
  const original = JSON.stringify({
    workspaceRoots: [],
    diagnostics: { codex: { enabled: false } },
    marker: 'original',
  }, null, 2) + '\n';
  fs.writeFileSync(configPath, original);

  const calls = [];
  const installer = new ReadOnlySmokeInstaller({
    fsImpl: fs,
    probeCurrent: async () => ({ sha: PREVIOUS, pid: 101 }),
    stopCurrent: async () => { calls.push({ stop: true }); return { stopped: true }; },
    recoverTarget: async (args) => {
      calls.push(args);
      if (args.targetSha === TARGET) throw new Error('target activation failed');
      return { status: 'PASS', sha: PREVIOUS, runtime: { action: 'started', pid: 303 } };
    },
  });

  await assert.rejects(
    () => installer.install({ fixturePath: fixture, configPath, targetSha: TARGET, repoPath: root }),
    (error) => {
      assert.ok(error instanceof ReadOnlySmokeInstallError);
      assert.equal(error.details.phase, 'activate_updated_profile');
      assert.equal(error.details.rollback.status, 'restored');
      assert.equal(error.details.rollback.sha, PREVIOUS);
      return true;
    },
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(calls.filter((x) => x.targetSha).map((x) => x.targetSha), [TARGET, PREVIOUS]);
});

test('rollback recovery failure is fail-closed and leaves original config restored', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-only-smoke-rollback-fail-'));
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(fixture);
  const configPath = path.join(root, 'stable.json');
  const original = '{"workspaceRoots":[],"diagnostics":{"codex":{"enabled":false}}}\n';
  fs.writeFileSync(configPath, original);

  const installer = new ReadOnlySmokeInstaller({
    fsImpl: fs,
    probeCurrent: async () => ({ sha: PREVIOUS, pid: 101 }),
    stopCurrent: async () => ({ stopped: true }),
    recoverTarget: async ({ targetSha }) => {
      if (targetSha === TARGET) throw new Error('target activation failed');
      throw new Error('rollback recovery failed');
    },
  });

  await assert.rejects(
    () => installer.install({ fixturePath: fixture, configPath, targetSha: TARGET, repoPath: root }),
    (error) => {
      assert.ok(error instanceof ReadOnlySmokeInstallError);
      assert.equal(error.details.rollback.status, 'failed');
      return true;
    },
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});

test('partial stop failure restores original config and recovers previous revision when the exact PID was already stopped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-only-smoke-partial-stop-'));
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(fixture);
  const configPath = path.join(root, 'stable.json');
  const original = '{"workspaceRoots":[],"diagnostics":{"codex":{"enabled":false}}}\n';
  fs.writeFileSync(configPath, original);

  const recovered = [];
  const installer = new ReadOnlySmokeInstaller({
    fsImpl: fs,
    probeCurrent: async () => ({ sha: PREVIOUS, pid: 505 }),
    stopCurrent: async () => {
      const error = new Error('listener release timed out');
      error.details = { currentStopped: true };
      throw error;
    },
    recoverTarget: async ({ targetSha }) => {
      recovered.push(targetSha);
      return { status: 'PASS', sha: targetSha, runtime: { action: 'started', pid: 506 } };
    },
  });

  await assert.rejects(
    () => installer.install({ fixturePath: fixture, configPath, targetSha: TARGET, repoPath: root }),
    (error) => {
      assert.ok(error instanceof ReadOnlySmokeInstallError);
      assert.equal(error.details.rollback.status, 'restored');
      assert.equal(error.details.rollback.sha, PREVIOUS);
      return true;
    },
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(recovered, [PREVIOUS]);
});

test('installer restarts even when the target revision already equals the serving revision so the profile reload is proven', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-only-smoke-same-revision-'));
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(fixture);
  const configPath = path.join(root, 'stable.json');
  fs.writeFileSync(configPath, JSON.stringify({
    workspaceRoots: [],
    diagnostics: { codex: { enabled: false } },
  }, null, 2));

  let stopped = 0;
  let recovered = 0;
  const installer = new ReadOnlySmokeInstaller({
    fsImpl: fs,
    probeCurrent: async () => ({ sha: TARGET, pid: 404 }),
    stopCurrent: async ({ pid, sha }) => {
      assert.equal(pid, 404);
      assert.equal(sha, TARGET);
      stopped += 1;
      return { stopped: true };
    },
    recoverTarget: async ({ targetSha }) => {
      assert.equal(targetSha, TARGET);
      recovered += 1;
      return { status: 'PASS', sha: TARGET, runtime: { action: 'started', pid: 405 } };
    },
  });

  const result = await installer.install({ fixturePath: fixture, configPath, targetSha: TARGET, repoPath: root });
  assert.equal(result.status, 'PASS');
  assert.equal(stopped, 1);
  assert.equal(recovered, 1);
});

test('installer rejects a non-directory fixture before config mutation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-only-smoke-file-'));
  const fixture = path.join(root, 'fixture.txt');
  fs.writeFileSync(fixture, 'not a directory');
  const configPath = path.join(root, 'stable.json');
  const original = '{"workspaceRoots":[]}\n';
  fs.writeFileSync(configPath, original);

  let probes = 0;
  const installer = new ReadOnlySmokeInstaller({
    fsImpl: fs,
    probeCurrent: async () => { probes += 1; return { sha: PREVIOUS, pid: 101 }; },
    stopCurrent: async () => ({ stopped: true }),
    recoverTarget: async () => ({ status: 'PASS' }),
  });

  await assert.rejects(
    () => installer.install({ fixturePath: fixture, configPath, targetSha: TARGET, repoPath: root }),
    /fixture path must be an existing directory/,
  );
  assert.equal(probes, 0);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});
