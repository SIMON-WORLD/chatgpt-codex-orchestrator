import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firstBootstrap, deriveActivationRoot } from '../../host/stable-runtime-first-bootstrap.mjs';

const SHA = 'a'.repeat(40);

test('first bootstrap starts from a stale canonical checkout with no activator source and enters the exact target activator', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-first-bootstrap-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const configPath = path.join(root, 'stable.json');
  fs.writeFileSync(configPath, JSON.stringify({
    worktree: { trustedRepos: [repo] },
    dataRoot: path.join(root, 'stable-data'),
    governanceNamespace: 'stable-v02',
    tunnel: { external: true, profile: 'stable-v02' },
  }));

  assert.equal(fs.existsSync(path.join(repo, 'scripts', 'stable-runtime-activate.mjs')), false);
  assert.equal(fs.existsSync(path.join(repo, 'src', 'activation', 'stable-runtime-activator.js')), false);

  const checkout = path.join(deriveActivationRoot(repo), SHA);
  const events = [];
  const run = async (file, args, options = {}) => {
    events.push({ file, args: [...args], cwd: options.cwd || null });
    if (file === 'git' && args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
    if (file === 'git' && args.includes('merge-base')) return { code: 0, stdout: '', stderr: '' };
    if (file === 'git' && args.includes('worktree')) {
      fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(checkout, 'src', 'activation'), { recursive: true });
      fs.writeFileSync(path.join(checkout, 'scripts', 'stable-runtime-activate.mjs'), '// target activator\n');
      fs.writeFileSync(path.join(checkout, 'src', 'activation', 'stable-runtime-activator.js'), '// target implementation\n');
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
