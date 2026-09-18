import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBrainLocalRuntime, loadV02Config } from '../../src/transport/brain-local.js';
import { readOnlySmokeFixtureContract } from '../../src/local/read-only-smoke.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_TUNNEL = path.join(__dirname, '..', '..', 'test-fixtures', 'tunnel', 'fake-tunnel-client.mjs');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, timeout = 4000) { const s = Date.now(); while (Date.now() - s < timeout) { if (await fn()) return true; await sleep(50); } return false; }

// The v0.2 runtime reads ambient TUNNEL_* / V02_* / CODEX_BIN env via loadV02Config
// (env precedence is ABOVE explicit overrides). A live production runtime can leave
// these set, which would otherwise break the hermetic tunnel tests. Clear them for the
// duration of config construction, then restore.
const LEAKY_ENV = ['V02_PORT','V02_HOST','V02_WORKSPACE_ROOT','CODEX_BIN',
  'TUNNEL_CLIENT_EXECUTABLE','TUNNEL_PROFILE','TUNNEL_PROFILE_DIR','TUNNEL_LOCAL_MCP_URL','TUNNEL_HEALTH_URL'];
function withCleanEnv(fn) {
  const saved = {};
  for (const k of LEAKY_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  try { return fn(); } finally { for (const k of LEAKY_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function makeRuntime(opts = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-'));
  const workspace = path.join(dataRoot, 'repo');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'hello', 'utf8');
  const config = withCleanEnv(() => loadV02Config({ port: 0, workspaceRoot: workspace, dataRoot, ...opts }));
  return createBrainLocalRuntime(config);
}

test('without tunnel: readyForLocalMcp=true, readyForTunnel=false, readyForChatGPT=false', async () => {
  const runtime = makeRuntime();
  await runtime.start();
  await sleep(200);
  const st = await runtime.status();
  assert.equal(st.readyForLocalMcp, true);
  assert.equal(st.readyForTunnel, false);
  assert.equal(st.readyForChatGPT, false);
  assert.equal(st.localMcp.url, 'http://127.0.0.1:' + runtime.mcp.port + '/mcp');
  await runtime.close();
});

test('with real tunnel readiness: readyForLocalMcp=true, readyForTunnel=true, readyForChatGPT=true', async () => {
  const healthAddr = '127.0.0.1:8099';
  const prior = process.env.FAKE_TUNNEL_HEALTH_ADDR;
  process.env.FAKE_TUNNEL_HEALTH_ADDR = healthAddr;
  const runtime = makeRuntime({
    tunnel: { clientExecutable: process.execPath, spawnArgs: [FAKE_TUNNEL], healthUrl: 'http://' + healthAddr + '/readyz' },
  });
  try {
    await runtime.start();
    const ready = await waitFor(async () => (await runtime.status()).readyForTunnel);
    assert.equal(ready, true);
    const st = await runtime.status();
    assert.equal(st.readyForLocalMcp, true);
    assert.equal(st.readyForTunnel, true);
    assert.equal(st.readyForChatGPT, true);
    assert.equal(st.tunnel.present, true);
    // Now stop the tunnel (kill the fake) -> readiness drops.
    if (runtime.tunnelProcess) runtime.tunnelProcess.kill('SIGTERM');
    await sleep(200);
    const st2 = await runtime.status();
    assert.equal(st2.readyForTunnel, false);
    assert.equal(st2.readyForChatGPT, false);
  } finally {
    await runtime.close();
    if (prior === undefined) delete process.env.FAKE_TUNNEL_HEALTH_ADDR; else process.env.FAKE_TUNNEL_HEALTH_ADDR = prior;
  }
});

test('externally managed tunnel lifecycle: runtime never spawns/kills the tunnel-client; readiness uses the external health URL', async () => {
  const http = await import('node:http');
  const external = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); });
  await new Promise((resolve) => external.listen(0, '127.0.0.1', resolve));
  const port = external.address().port;
  const healthUrl = 'http://127.0.0.1:' + port + '/readyz';
  const runtime = makeRuntime({
    tunnel: { clientExecutable: process.execPath, spawnArgs: [FAKE_TUNNEL], external: true, healthUrl },
  });
  try {
    await runtime.start();
    assert.equal(runtime.tunnelProcess, null, 'external tunnel mode must not spawn tunnel-client');
    const st = await runtime.status();
    assert.equal(st.tunnel.external, true);
    assert.equal(st.readyForTunnel, true);
    assert.equal(st.readyForChatGPT, true);
    // close() must NOT kill an externally owned tunnel (the health server keeps serving).
    await runtime.close();
    const probe = await fetch(healthUrl);
    assert.equal(probe.ok, true);
  } finally {
    try { await runtime.close(); } catch {}
    await new Promise((resolve) => external.close(resolve));
  }
});

test('configured local read-only fixture is wired into WorkspaceRegistry without widening workspaceRoots', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-fixture-'));
  const allowedRoot = path.join(dataRoot, 'allowed');
  const fixture = path.join(allowedRoot, 'read-only-smoke');
  fs.mkdirSync(path.join(fixture, '.git'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'smoke.txt'), 'fixture marker\n', 'utf8');

  const config = withCleanEnv(() => loadV02Config({
    port: 0,
    workspaceRoot: allowedRoot,
    dataRoot,
    diagnostics: { localReadOnlyFixture: fixture },
  }));
  assert.equal(config.diagnostics.localReadOnlyFixture, path.resolve(fixture));
  assert.deepEqual(config.workspaceRoots, [path.resolve(allowedRoot)]);

  const runtime = createBrainLocalRuntime(config);
  try {
    await runtime.start();
    const opened = runtime.registry.open({ fixture: 'read_only_smoke' });
    assert.equal(opened.fixture, 'read_only_smoke');
    assert.equal(opened.root, fs.realpathSync.native(fixture));
    assert.deepEqual(opened.fixtureContract, readOnlySmokeFixtureContract());
  } finally {
    await runtime.close();
  }
});
