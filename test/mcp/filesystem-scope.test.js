import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';

function textOf(result) {
  return result?.content?.find((entry) => entry.type === 'text')?.text || '';
}

test('MCP exposes no scope mutation and requires workspaceId after an explicit OS-user open', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-filesystem-scope-'));
  fs.writeFileSync(path.join(root, 'safe.txt'), 'os user scope marker\n', 'utf8');
  const registry = new WorkspaceRegistry({ filesystemScope: 'os_user_scope' });
  const server = await startMcpServer({ workspaceRegistry: registry, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const client = new Client({ name: 'filesystem-scope-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(server.url));
  t.after(() => client.close());

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.equal(names.some((name) => /scope/i.test(name)), false);
  const workspaceTool = tools.tools.find((tool) => tool.name === 'workspace_open');
  assert.ok(workspaceTool);
  assert.equal(workspaceTool.inputSchema.properties.scope, undefined);
  assert.equal(workspaceTool.inputSchema.properties.filesystemScope, undefined);

  const opened = await client.callTool({ name: 'workspace_open', arguments: { path: root } });
  const workspace = JSON.parse(textOf(opened));
  assert.ok(workspace.workspaceId);
  assert.equal(workspace.filesystemScope, 'os_user_scope');
  const read = await client.callTool({ name: 'read', arguments: { workspaceId: workspace.workspaceId, path: 'safe.txt' } });
  assert.match(textOf(read), /os user scope marker/u);

  const missingWorkspace = await client.callTool({ name: 'read', arguments: { path: 'safe.txt' } });
  assert.equal(missingWorkspace.isError, true);
  const attemptedElevation = await client.callTool({
    name: 'workspace_open',
    arguments: { path: root, filesystemScope: 'os_user_scope' },
  });
  assert.equal(attemptedElevation.isError, true);
});
