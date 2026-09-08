import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';

function makeRegistry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-revision-'));
  return new WorkspaceRegistry({ allowedRoots: [root] });
}

async function withRevision(value, fn) {
  const prior = process.env.V02_BUILD_REVISION;
  if (value === null) delete process.env.V02_BUILD_REVISION;
  else process.env.V02_BUILD_REVISION = value;
  try { return await fn(); }
  finally {
    if (prior === undefined) delete process.env.V02_BUILD_REVISION;
    else process.env.V02_BUILD_REVISION = prior;
  }
}

test('healthz and readyz expose exact non-secret build revision proof', async () => {
  const sha = 'c'.repeat(40);
  await withRevision(sha, async () => {
    const srv = await startMcpServer({ workspaceRegistry: makeRegistry(), host: '127.0.0.1', port: 0 });
    try {
      const base = srv.url.replace('/mcp', '');
      const health = await (await fetch(`${base}/healthz`)).json();
      const ready = await (await fetch(`${base}/readyz`)).json();
      assert.deepEqual({ status: health.status, revision: health.revision }, { status: 'ok', revision: sha });
      assert.equal(ready.status, 'ready');
      assert.equal(ready.revision, sha);
    } finally { await srv.close(); }
  });
});

test('healthz and readyz fail closed to revision=null for non-exact labels', async () => {
  await withRevision('main', async () => {
    const srv = await startMcpServer({ workspaceRegistry: makeRegistry(), host: '127.0.0.1', port: 0 });
    try {
      const base = srv.url.replace('/mcp', '');
      assert.equal((await (await fetch(`${base}/healthz`)).json()).revision, null);
      assert.equal((await (await fetch(`${base}/readyz`)).json()).revision, null);
    } finally { await srv.close(); }
  });
});
