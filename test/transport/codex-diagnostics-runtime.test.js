import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createBrainLocalRuntime, loadV02Config } from '../../src/transport/brain-local.js';

function makeConfig(diagnostics) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-diag-runtime-'));
  const workspace = path.join(dataRoot, 'workspace');
  fs.mkdirSync(workspace);
  return loadV02Config({
    port: 0,
    dataRoot,
    workspaceRoot: workspace,
    diagnostics,
    tunnel: { clientExecutable: null, healthUrl: null },
  });
}

async function toolNames(runtime) {
  const client = new Client({ name: 'codex-diagnostics-runtime-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(runtime.mcp.url));
  try { return (await client.listTools()).tools.map((tool) => tool.name); }
  finally { await client.close(); }
}

test('v0.2 config keeps Codex diagnostics default-off and exposes no path/root setting', () => {
  const cfg = makeConfig(undefined);
  assert.deepEqual(cfg.diagnostics, { codex: { enabled: false } });
  assert.deepEqual(Object.keys(cfg.diagnostics.codex), ['enabled']);

  const enabled = makeConfig({ codex: { enabled: true, path: '/forbidden' } });
  assert.deepEqual(enabled.diagnostics, { codex: { enabled: true } }, 'unknown diagnostic config fields must not become runtime authority');
});

test('BrainLocalRuntime registers codex_diagnostics only after explicit opt-in', async () => {
  const disabled = createBrainLocalRuntime(makeConfig(undefined));
  try {
    await disabled.start();
    assert.equal((await toolNames(disabled)).includes('codex_diagnostics'), false);
    assert.equal(disabled.codexDiagnosticsService, null);
  } finally { await disabled.close(); }

  const enabled = createBrainLocalRuntime(makeConfig({ codex: { enabled: true } }));
  try {
    await enabled.start();
    assert.equal((await toolNames(enabled)).includes('codex_diagnostics'), true);
    assert.ok(enabled.codexDiagnosticsService);
    assert.equal(enabled.mutationOwner.owner, 'none');
  } finally { await enabled.close(); }
});
