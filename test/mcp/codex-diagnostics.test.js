import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { CodexDiagnosticsService } from '../../src/local/codex-diagnostics.js';
import { MutationOwner } from '../../src/state/mutation-owner.js';

function textOf(res) {
  const item = res && res.content && res.content.find((c) => c.type === 'text');
  return item ? item.text : '';
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-diag-mcp-'));
  const workspace = path.join(root, 'workspace');
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'wire_api="chat"\ntoken="sk-private"\n', 'utf8');
  return { root, workspace, codexHome };
}

async function connect(server) {
  const client = new Client({ name: 'codex-diagnostics-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(server.url));
  return client;
}

test('codex_diagnostics is absent unless an opt-in service is explicitly registered', async (t) => {
  const { root } = fixture();
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const server = await startMcpServer({ workspaceRegistry: registry, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const client = await connect(server);
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === 'codex_diagnostics'), false);
});

test('opt-in tool exposes fixed structured output and never acquires mutation ownership', async (t) => {
  const { root, codexHome } = fixture();
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const owner = new MutationOwner();
  const service = new CodexDiagnosticsService({ codexHome });
  const server = await startMcpServer({
    workspaceRegistry: registry,
    mutationOwner: owner,
    codexDiagnosticsService: service,
    host: '127.0.0.1',
    port: 0,
  });
  t.after(() => server.close());
  const client = await connect(server);
  t.after(() => client.close());

  const tools = await client.listTools();
  const diagnostic = tools.tools.find((tool) => tool.name === 'codex_diagnostics');
  assert.ok(diagnostic);
  assert.equal(owner.owner, 'none');

  const result = await client.callTool({ name: 'codex_diagnostics', arguments: { kind: 'config_safety' } });
  const parsed = JSON.parse(textOf(result));
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.signals.wireApiChat, true);
  assert.equal(textOf(result).includes('sk-private'), false);
  assert.equal(owner.owner, 'none');
  assert.equal(owner.unitId, null);
});

test('tool input schema rejects arbitrary path/query/raw-output fields fail closed', async (t) => {
  const { root, codexHome } = fixture();
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const server = await startMcpServer({
    workspaceRegistry: registry,
    codexDiagnosticsService: new CodexDiagnosticsService({ codexHome }),
    host: '127.0.0.1',
    port: 0,
  });
  t.after(() => server.close());
  const client = await connect(server);
  t.after(() => client.close());

  for (const extra of [
    { path: '/etc/passwd' },
    { workspaceId: 'ws-secret' },
    { command: 'cat' },
    { query: 'secret' },
    { sql: 'select * from logs' },
    { regex: '.*' },
    { raw: true },
    { mutation: true },
  ]) {
    let rejected = false;
    try {
      const result = await client.callTool({ name: 'codex_diagnostics', arguments: { kind: 'config_safety', ...extra } });
      rejected = result && result.isError === true;
      assert.equal(textOf(result).includes(String(Object.values(extra)[0])), false);
    } catch {
      rejected = true;
    }
    assert.equal(rejected, true, `schema accepted forbidden field ${Object.keys(extra)[0]}`);
  }
});
