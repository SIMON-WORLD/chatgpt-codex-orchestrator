import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StableRuntimeActivator, npmCiCommand } from '../../src/activation/stable-runtime-activator.js';

const SHA = 'a'.repeat(40);

test('target preparation explicitly launches the sanity child in non-authoritative activation-preflight mode on V02_PORT=0', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-preflight-binding-'));
  const repo = path.join(root, 'repo');
  const activationRoot = path.join(root, 'activations');
  const checkout = path.join(activationRoot, SHA);
  const configPath = path.join(root, 'stable-v02.json');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(checkout, { recursive: true });
  fs.writeFileSync(configPath, '{}\n', 'utf8');

  const commands = [];
  const npmCi = npmCiCommand('linux', process.env);
  const activator = new StableRuntimeActivator({
    platform: 'linux',
    run: async (file, args, options = {}) => {
      commands.push({ file, args: [...args], options });
      if (file === 'git' && args.includes('rev-parse')) return { code: 0, stdout: `${SHA}\n`, stderr: '' };
      if (file === 'git' && args.includes('status')) return { code: 0, stdout: '', stderr: '' };
      if (file === npmCi.file && args.join(' ') === npmCi.args.join(' ')) return { code: 0, stdout: '', stderr: '' };
      if (file === process.execPath) return { code: 0, stdout: 'V02_RUNTIME {"mode":"activation-preflight","readyForLocalMcp":true}\n', stderr: '' };
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    },
  });

  const prepared = await activator._prepare({ repo, sha: SHA, configPath, activationRoot });
  assert.equal(prepared.preflight.readyForLocalMcp, true);

  const child = commands.find((command) => command.file === process.execPath);
  assert.ok(child, 'preflight child command must be executed');
  assert.deepEqual(child.args, [
    'scripts/v0.2-start.mjs',
    '--config', configPath,
    '--activation-preflight',
    '--oneshot',
  ]);
  assert.equal(child.options.env.V02_PORT, '0');
  assert.equal(child.options.env.V02_BUILD_REVISION, SHA);
});
