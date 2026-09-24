import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { startMcpServer } from '../../src/mcp/server.js';

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue177-ready-'));
  return new WorkspaceRegistry({ allowedRoots: [root] });
}

function health(state, generation = 0, failureCode = null) {
  return { state, version: '0.2.51', generation, failureCode };
}

test('normal serving /readyz waits for executor proof while /healthz remains liveness-only', async (t) => {
  let state = 'idle';
  let release;
  let probes = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const child = {
    health: () => health(state, state === 'ready' ? 1 : 0),
    probeReady: async () => {
      probes += 1;
      state = 'starting';
      await gate;
      state = 'ready';
      return health(state, 1);
    },
  };
  const server = await startMcpServer({ workspaceRegistry: registry(), desktopCommanderChild: child, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const base = server.url.replace('/mcp', '');
  const h = await fetch(`${base}/healthz`);
  assert.equal(h.status, 200);
  assert.equal((await h.json()).processLive, true);
  let settled = false;
  const pending = fetch(`${base}/readyz`).then((r) => { settled = true; return r; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(settled, false);
  release();
  const ready = await pending;
  assert.equal(ready.status, 200);
  const body = await ready.json();
  assert.equal(body.executorReady, true);
  assert.equal(body.localMcpListening, true);
  assert.equal(probes, 1);
});

test('executor init/tool/version proof failure fails /readyz closed while health stays live', async (t) => {
  for (const failureCode of ['CHILD_START_FAILED', 'MISSING_REQUIRED_TOOL']) {
    const child = {
      health: () => health('idle', 0, failureCode),
      probeReady: async () => { throw Object.assign(new Error(failureCode), { code: failureCode }); },
    };
    const server = await startMcpServer({ workspaceRegistry: registry(), desktopCommanderChild: child, host: '127.0.0.1', port: 0 });
    t.after(() => server.close());
    const base = server.url.replace('/mcp', '');
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).executorReady, false);
  }
});

test('backend death is immediately non-ready and only recovers after a new bounded proof', async (t) => {
  let state = 'ready';
  let generation = 1;
  const child = {
    health: () => health(state, generation, state === 'dead' ? 'CHILD_EXITED' : null),
    probeReady: async () => {
      state = 'starting';
      await new Promise((resolve) => setTimeout(resolve, 20));
      generation += 1;
      state = 'ready';
      return health(state, generation);
    },
  };
  const server = await startMcpServer({ workspaceRegistry: registry(), desktopCommanderChild: child, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const base = server.url.replace('/mcp', '');
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  state = 'dead';
  const dead = await fetch(`${base}/readyz`);
  assert.equal(dead.status, 503);
  assert.equal((await dead.json()).executorReady, false);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  while (state !== 'ready') await new Promise((resolve) => setTimeout(resolve, 5));
  const recovered = await fetch(`${base}/readyz`);
  assert.equal(recovered.status, 200);
  assert.ok((await recovered.json()).compositeDesktopCommander.generation >= 2);
});

test('activation-preflight readiness remains independent of the serving executor', async (t) => {
  const server = await startMcpServer({ workspaceRegistry: registry(), activationPreflight: true, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const body = await (await fetch(`${server.url.replace('/mcp', '')}/readyz`)).json();
  assert.equal(body.status, 'ready');
  assert.equal(body.activationPreflight, true);
  assert.equal(body.executorRequired, false);
  assert.equal(body.executorReady, null);
});
