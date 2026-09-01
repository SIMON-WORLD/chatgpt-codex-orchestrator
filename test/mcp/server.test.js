import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello marker\n', 'utf8');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=sk-xxx', 'utf8');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'u', 'utf8');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'u', 'utf8');
  return { root, repo };
}

function textOf(res) {
  const t = res && res.content && res.content.find((c) => c.type === 'text');
  return t ? t.text : '';
}

test('MCP server binds loopback / healthz / readyz / initialize / tools / clean shutdown', async (t) => {
  const { root, repo } = makeWorkspace();
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const srv = await startMcpServer({ workspaceRegistry: registry, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  t.after(() => srv.close());

  assert.equal(srv.host, '127.0.0.1');
  const health = await fetch(`${srv.url.replace('/mcp', '')}/healthz`);
  assert.equal(health.status, 200);
  const ready = await fetch(`${srv.url.replace('/mcp', '')}/readyz`);
  assert.equal(ready.status, 200);

  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  t.after(() => client.close());

  const tools = await client.listTools();
  const names = tools.tools.map((tm) => tm.name);
  for (const n of ['workspace_open', 'read', 'search', 'git_status', 'git_diff']) assert.ok(names.includes(n), `missing ${n}`);

  const op = await client.callTool({ name: 'workspace_open', arguments: { path: repo } });
  const ws = JSON.parse(textOf(op));
  assert.ok(ws.workspaceId);
  assert.equal(ws.isGitRepo, true);

  const rd = await client.callTool({ name: 'read', arguments: { workspaceId: ws.workspaceId, path: 'a.txt' } });
  assert.ok(textOf(rd).includes('hello marker'));

  // sensitive file blocked through MCP
  const blocked = await client.callTool({ name: 'read', arguments: { workspaceId: ws.workspaceId, path: '.env' } });
  assert.equal(blocked.isError, true);

  const se = await client.callTool({ name: 'search', arguments: { workspaceId: ws.workspaceId, query: 'marker' } });
  assert.ok(textOf(se).includes('a.txt'));

  const gs = await client.callTool({ name: 'git_status', arguments: { workspaceId: ws.workspaceId } });
  assert.ok(JSON.parse(textOf(gs)).status.includes('untracked.txt'));

  const gd = await client.callTool({ name: 'git_diff', arguments: { workspaceId: ws.workspaceId, mode: 'worktree' } });
  assert.ok(typeof JSON.parse(textOf(gd)).diff === 'string');
});
