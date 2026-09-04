import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBrainLocalRuntime, loadV02Config } from '../../src/transport/brain-local.js';

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
