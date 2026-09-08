import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadV02Config } from '../../src/config.js';
import { StableRuntimeActivator, npmCiCommand } from '../../src/activation/stable-runtime-activator.js';
import { createBrainLocalRuntime } from '../../src/transport/brain-local.js';
import { GovernanceWriterError, GovernanceWriterGuard } from '../../src/governance/writer-guard.js';

const SHA = 'a'.repeat(40);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-nonauthoritative-preflight-'));
  const dataRoot = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  const poolRoot = path.join(root, 'worktrees');
  const codexProfile = path.join(root, 'codex-profile');
  const tunnelProfileDir = path.join(root, 'tunnel-profile');
  for (const dir of [dataRoot, workspace, poolRoot, codexProfile, tunnelProfileDir]) fs.mkdirSync(dir, { recursive: true });

  const configPath = path.join(root, 'stable-v02.json');
  const rawConfig = {
    host: '127.0.0.1',
    port: 8745,
    dataRoot,
    governanceNamespace: 'stable-v02',
    workspaceRoots: [workspace],
    worktree: { poolRoot, trustedRepos: [workspace] },
    codex: {
      bin: 'codex', listen: 'stdio://', cwd: null, runtimeProfile: codexProfile,
      caBundle: null, sslCertFile: null, spawnArgs: null, extraArgs: [],
    },
    tunnel: {
      external: true,
      clientExecutable: null,
      profile: 'stable-v02',
      profileFile: null,
      profileDir: tunnelProfileDir,
      localMcpUrl: 'http://127.0.0.1:8745/mcp',
      healthUrl: 'http://127.0.0.1:1/readyz',
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, 'utf8');
  const config = loadV02Config(rawConfig);
  return { root, dataRoot, workspace, poolRoot, configPath, config };
}

function writerSlotPath(owner) {
  return path.join(owner.dir, 'writer.json');
}

test('activation preflight uses the real profile without stealing the held canonical writer and starts on V02_PORT=0 ephemeral MCP', async () => {
  const { dataRoot, workspace, poolRoot, config } = fixture();
  const owner = new GovernanceWriterGuard({ dataRoot, namespace: 'stable-v02' });
  owner.acquire();
  const slot = writerSlotPath(owner);
  const before = fs.readFileSync(slot, 'utf8');

  assert.throws(() => createBrainLocalRuntime({ ...config, port: 0 }), (error) => {
    assert.ok(error instanceof GovernanceWriterError);
    assert.equal(error.code, 'writer_conflict');
    return true;
  }, 'ordinary second runtime must remain fenced by the existing canonical writer');

  const previousPort = process.env.V02_PORT;
  process.env.V02_PORT = '0';
  let preflightConfig;
  try {
    preflightConfig = loadV02Config(config);
  } finally {
    if (previousPort === undefined) delete process.env.V02_PORT;
    else process.env.V02_PORT = previousPort;
  }
  assert.equal(preflightConfig.port, 0, 'V02_PORT=0 must resolve to the ephemeral preflight port');

  const runtime = createBrainLocalRuntime(preflightConfig, { mode: 'activation-preflight' });
  try {
    assert.equal(runtime.config.dataRoot, dataRoot);
    assert.equal(runtime.config.governanceNamespace, 'stable-v02');
    assert.deepEqual(runtime.config.workspaceRoots, [workspace]);
    assert.equal(runtime.config.worktree.poolRoot, poolRoot);
    assert.equal(runtime.config.codex.runtimeProfile, config.codex.runtimeProfile);
    assert.equal(runtime.config.tunnel.external, true);
    assert.equal(runtime.governanceService.guard.held, false, 'preflight must never acquire the canonical writer');

    await runtime.start();
    assert.equal(runtime.appServerExecutor, null, 'preflight must not construct an executable Codex surface');
    assert.equal(runtime.worktreeService, null, 'preflight must not construct a worktree mutation surface');
    assert.ok(runtime.mcp.port > 0);
    assert.notEqual(runtime.mcp.port, 8745);

    const ready = await fetch(`http://127.0.0.1:${runtime.mcp.port}/readyz`);
    assert.equal(ready.status, 200);
    const readyBody = await ready.json();
    assert.equal(readyBody.activationPreflight, true);

    const mcp = await fetch(`http://127.0.0.1:${runtime.mcp.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(mcp.status, 403);
    assert.deepEqual(await mcp.json(), { error: 'activation_preflight_mcp_disabled' });
  } finally {
    await runtime.close();
  }

  assert.equal(fs.readFileSync(slot, 'utf8'), before, 'preflight start/close must not modify or delete the existing writer slot');
  assert.equal(owner.assertOwned().ok, true, 'original writer remains canonical after preflight close');
  owner.release();
});

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
