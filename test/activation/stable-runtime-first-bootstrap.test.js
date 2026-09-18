import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  firstBootstrap,
  firstBootstrapFailurePayload,
  deriveActivationRoot,
  configPathFromServingCommandLine,
  discoverServingConfigPath,
} from '../../host/stable-runtime-first-bootstrap.mjs';

const SHA = 'a'.repeat(40);

function createBinding(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const configPath = path.join(root, 'stable.json');
  fs.writeFileSync(configPath, JSON.stringify({
    worktree: { trustedRepos: [repo] },
    dataRoot: path.join(root, 'stable-data'),
    governanceNamespace: 'stable-v02',
    tunnel: { external: true, profile: 'stable-v02' },
  }));
  return { root, repo, configPath, checkout: path.join(deriveActivationRoot(repo), SHA) };
}

function materializeTargetActivator(checkout) {
  fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'src', 'activation'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'scripts', 'stable-runtime-activate.mjs'), '// target activator\n');
  fs.writeFileSync(path.join(checkout, 'src', 'activation', 'stable-runtime-activator.js'), '// target implementation\n');
  fs.mkdirSync(path.join(checkout, 'host'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'host', 'stable-runtime-recover.mjs'), '// target recovery\n');
  fs.writeFileSync(path.join(checkout, 'src', 'activation', 'read-only-smoke-installer.js'), '// target fixture installer\n');
}

function gitBootstrapRun({ checkout, onTargetActivator }) {
  return async (file, args, options = {}) => {
    if (file === 'git' && args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
    if (file === 'git' && args.includes('merge-base')) return { code: 0, stdout: '', stderr: '' };
    if (file === 'git' && args.includes('worktree')) {
      materializeTargetActivator(checkout);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (file === 'git' && args.includes('rev-parse')) return { code: 0, stdout: `${SHA}\n`, stderr: '' };
    if (file === 'git' && args.includes('status')) return { code: 0, stdout: '', stderr: '' };
    if (file === process.execPath && args[0] === 'scripts/stable-runtime-activate.mjs') {
      return await onTargetActivator({ file, args, options });
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };
}

test('serving command-line config binding parser accepts explicit --config and rejects unrelated process commands', () => {
  assert.equal(
    configPathFromServingCommandLine('node scripts/v0.2-start.mjs --config "C:\\Users\\me\\stable v02.json"'),
    'C:\\Users\\me\\stable v02.json',
  );
  assert.equal(
    configPathFromServingCommandLine('node scripts/v0.2-start.mjs --config=C:\\stable.json'),
    'C:\\stable.json',
  );
  assert.equal(configPathFromServingCommandLine('node other-script.mjs --config C:\\wrong.json'), null);
});

test('serving config discovery binds only the single exact listener and its process --config argument', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-config-discovery-'));
  const configPath = path.join(root, 'stable.json');
  fs.writeFileSync(configPath, '{}\n');

  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === 'netstat.exe') {
      return {
        code: 0,
        stdout: '  TCP    127.0.0.1:8745       0.0.0.0:0      LISTENING       4242\r\n',
        stderr: '',
      };
    }
    if (file === 'powershell.exe') {
      return {
        code: 0,
        stdout: `"C:\\Program Files\\nodejs\\node.exe" scripts/v0.2-start.mjs --config "${configPath}"`,
        stderr: '',
      };
    }
    throw new Error(`unexpected command: ${file}`);
  };

  const result = await discoverServingConfigPath({}, { run, fsImpl: fs, platform: 'win32' });
  assert.equal(result.configPath, path.resolve(configPath));
  assert.equal(result.pid, 4242);
  assert.deepEqual(calls.map((x) => x.file), ['netstat.exe', 'powershell.exe']);
  assert.equal(calls.some((x) => x.args.join(' ').includes('Get-ChildItem')), false);
});

test('first bootstrap fixture mode enters exact target recovery installer without requiring config-path input', async () => {
  const { repo, configPath, checkout } = createBinding('stable-first-bootstrap-fixture-');
  const fixture = path.join(path.dirname(repo), 'fixture');
  fs.mkdirSync(fixture);

  const run = async (file, args, options = {}) => {
    if (file === 'netstat.exe') {
      return { code: 0, stdout: '  TCP    127.0.0.1:8745       0.0.0.0:0      LISTENING       5151\r\n', stderr: '' };
    }
    if (file === 'powershell.exe') {
      return { code: 0, stdout: `node scripts/v0.2-start.mjs --config "${configPath}"`, stderr: '' };
    }
    if (file === 'git' && args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
    if (file === 'git' && args.includes('merge-base')) return { code: 0, stdout: '', stderr: '' };
    if (file === 'git' && args.includes('worktree')) {
      materializeTargetActivator(checkout);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (file === 'git' && args.includes('rev-parse')) return { code: 0, stdout: `${SHA}\n`, stderr: '' };
    if (file === 'git' && args.includes('status')) return { code: 0, stdout: '', stderr: '' };
    if (file === process.execPath && args[0] === 'host/stable-runtime-recover.mjs') {
      assert.equal(options.cwd, checkout);
      assert.deepEqual(args.slice(1), [
        '--sha', SHA,
        '--config', configPath,
        '--repo', repo,
        '--read-only-smoke-fixture', fixture,
      ]);
      return {
        code: 0,
        stdout: `STABLE_RUNTIME_RECOVERY {"status":"PASS","operation":"read_only_smoke_install","recovery":{"sha":"${SHA}","runtime":{"action":"started"}}}\n`,
        stderr: '',
      };
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };

  const result = await firstBootstrap(
    { targetSha: SHA, repoPath: repo, readOnlySmokeFixture: fixture },
    { run, fsImpl: fs, platform: 'win32' },
  );
  assert.equal(result.status, 'PASS');
  assert.equal(result.fixtureInstall, true);
  assert.equal(result.targetRecovery.recovery.sha, SHA);
});

test('first bootstrap starts from a stale canonical checkout with no activator source and enters the exact target activator', async () => {
  const { repo, configPath, checkout } = createBinding('stable-first-bootstrap-');

  assert.equal(fs.existsSync(path.join(repo, 'scripts', 'stable-runtime-activate.mjs')), false);
  assert.equal(fs.existsSync(path.join(repo, 'src', 'activation', 'stable-runtime-activator.js')), false);

  const events = [];
  const run = async (file, args, options = {}) => {
    events.push({ file, args: [...args], cwd: options.cwd || null });
    if (file === 'git' && args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
    if (file === 'git' && args.includes('merge-base')) return { code: 0, stdout: '', stderr: '' };
    if (file === 'git' && args.includes('worktree')) {
      materializeTargetActivator(checkout);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (file === 'git' && args.includes('rev-parse')) return { code: 0, stdout: `${SHA}\n`, stderr: '' };
    if (file === 'git' && args.includes('status')) return { code: 0, stdout: '', stderr: '' };
    if (file === process.execPath && args[0] === 'scripts/stable-runtime-activate.mjs') {
      assert.equal(options.cwd, checkout);
      assert.deepEqual(args.slice(1), ['--sha', SHA, '--config', configPath, '--repo', repo]);
      return { code: 0, stdout: `STABLE_RUNTIME_ACTIVATION {"status":"PASS","sha":"${SHA}"}\n`, stderr: '' };
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };

  const result = await firstBootstrap({ targetSha: SHA, configPath, repoPath: repo }, { run });
  assert.equal(result.status, 'PASS');
  assert.equal(result.sha, SHA);
  assert.equal(result.checkout, checkout);
  assert.equal(result.bootstrapArtifactIndependentOfCanonicalCheckout, true);
  assert.equal(result.targetActivation.status, 'PASS');
  assert.equal(fs.existsSync(path.join(repo, 'scripts', 'stable-runtime-activate.mjs')), false);
  assert.equal(fs.existsSync(path.join(repo, 'src', 'activation', 'stable-runtime-activator.js')), false);
  assert.ok(events.some((event) => event.file === 'git' && event.args.includes('worktree')));
  assert.ok(events.some((event) => event.file === process.execPath && event.cwd === checkout));
});

test('first bootstrap preserves structured target activator FAIL evidence on non-zero child exit', async () => {
  const { repo, configPath, checkout } = createBinding('stable-first-bootstrap-failure-');
  const rollback = { attempted: true, status: 'failed', sha: 'b'.repeat(40), cause: 'rollback runtime not ready' };
  const rollbackEvidence = { status: 'no_safe_rollback', reason: 'no_exact_clean_prepared_checkout_for_proven_serving_revision' };
  const childFailure = {
    status: 'FAIL',
    phase: 'readiness',
    message: 'target runtime did not become ready at the exact requested revision',
    targetSha: SHA,
    cutoverStarted: true,
    rollback,
    rollbackEvidence,
    apiKey: 'must-not-propagate',
  };
  const run = gitBootstrapRun({
    checkout,
    onTargetActivator: async ({ args, options }) => {
      assert.equal(options.cwd, checkout);
      assert.deepEqual(args.slice(1), ['--sha', SHA, '--config', configPath, '--repo', repo]);
      const error = new Error(`${process.execPath} exited with code 1`);
      error.result = {
        code: 1,
        stdout: 'target activator debug text that must not be propagated as raw output\n',
        stderr: `STABLE_RUNTIME_ACTIVATION ${JSON.stringify(childFailure)}\n`,
      };
      throw error;
    },
  });

  let thrown;
  try {
    await firstBootstrap({ targetSha: SHA, configPath, repoPath: repo }, { run });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown);

  const outer = firstBootstrapFailurePayload(thrown);
  assert.equal(outer.status, 'FAIL');
  assert.equal(outer.phase, 'readiness');
  assert.equal(outer.message, childFailure.message);
  assert.equal(outer.targetSha, SHA);
  assert.equal(outer.cutoverStarted, true);
  assert.deepEqual(outer.rollback, rollback);
  assert.deepEqual(outer.rollbackEvidence, rollbackEvidence);
  assert.equal(outer.bootstrapPhase, 'target_activator');
  assert.equal(outer.requestedSha, SHA);
  assert.equal(outer.targetExitCode, 1);
  assert.equal('apiKey' in outer, false);
  assert.equal('targetStderrSummary' in outer, false);
  assert.equal('targetStdoutSummary' in outer, false);
});

test('first bootstrap uses bounded redacted child output only when no valid structured failure exists', async () => {
  const { repo, configPath, checkout } = createBinding('stable-first-bootstrap-fallback-');
  const run = gitBootstrapRun({
    checkout,
    onTargetActivator: async () => {
      const error = new Error(`${process.execPath} exited with code 1`);
      error.result = {
        code: 1,
        stdout: `plain fallback output ${'x'.repeat(700)}\n`,
        stderr: `Authorization: Bearer top-secret-token\nplain stderr ${'y'.repeat(700)}\n`,
      };
      throw error;
    },
  });

  let thrown;
  try {
    await firstBootstrap({ targetSha: SHA, configPath, repoPath: repo }, { run });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown);

  const outer = firstBootstrapFailurePayload(thrown);
  assert.equal(outer.status, 'FAIL');
  assert.equal(outer.phase, 'target_activator');
  assert.equal(outer.targetExitCode, 1);
  assert.ok(outer.targetStderrSummary.length <= 512);
  assert.ok(outer.targetStdoutSummary.length <= 512);
  assert.equal(outer.targetStderrSummary.includes('top-secret-token'), false);
  assert.equal(outer.targetStderrSummary.includes('[REDACTED]'), true);
  assert.equal('rollback' in outer, false);
  assert.equal('rollbackEvidence' in outer, false);
});
