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

function makeRuntime(opts = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-'));
  const workspace = path.join(dataRoot, 'repo');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'hello', 'utf8');
  const config = loadV02Config({ port: 0, workspaceRoot: workspace, dataRoot, ...opts });
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
