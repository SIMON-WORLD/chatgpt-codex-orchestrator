import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
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

test('workspace_open MCP schema exposes configured fixture alias and preserves exactly-one fail-closed semantics', async (t) => {
  const { root, repo } = makeWorkspace();
  const registry = new WorkspaceRegistry({
    allowedRoots: [root],
    fixtures: { read_only_smoke: repo },
  });
  const srv = await startMcpServer({ workspaceRegistry: registry, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  t.after(() => srv.close());

  const client = new Client({ name: 'fixture-schema-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  t.after(() => client.close());

  const tools = await client.listTools();
  const workspaceOpen = tools.tools.find((tool) => tool.name === 'workspace_open');
  assert.ok(workspaceOpen, 'workspace_open must be exposed');
  assert.ok(workspaceOpen.inputSchema?.properties?.path, 'workspace_open schema must expose path');
  assert.ok(workspaceOpen.inputSchema?.properties?.fixture, 'workspace_open schema must expose fixture');
  assert.equal((workspaceOpen.inputSchema?.required || []).includes('path'), false, 'path must not be unconditionally required when fixture is supported');
  assert.equal((workspaceOpen.inputSchema?.required || []).includes('fixture'), false, 'fixture must remain optional when explicit path is used');

  const byFixture = await client.callTool({ name: 'workspace_open', arguments: { fixture: 'read_only_smoke' } });
  const ws = JSON.parse(textOf(byFixture));
  assert.ok(ws.workspaceId);
  assert.equal(ws.fixture, 'read_only_smoke');
  assert.equal(ws.root, fs.realpathSync.native(repo));

  const neither = await client.callTool({ name: 'workspace_open', arguments: {} });
  assert.equal(neither.isError, true);
  assert.match(textOf(neither), /exactly one of path or fixture/i);

  const both = await client.callTool({
    name: 'workspace_open',
    arguments: { path: repo, fixture: 'read_only_smoke' },
  });
  assert.equal(both.isError, true);
  assert.match(textOf(both), /exactly one of path or fixture/i);
});

test('rejects malicious Host and non-local Origin, allows localhost', async (t) => {
  const { root, repo } = makeWorkspace();
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const srv = await startMcpServer({ workspaceRegistry: registry, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  t.after(() => srv.close());
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 't', version: '1' } } });

  const post = (headers) => new Promise((resolve, reject) => {
    const req = http.request(srv.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => { let d=''; res.on('data',(c)=>d+=c); res.on('end',()=>resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject); req.write(body); req.end();
  });

  const maliciousHost = await post({ host: 'evil.com' });
  assert.equal(maliciousHost.status, 403);
  const nonLocalOrigin = await post({ origin: 'https://evil.com' });
  assert.equal(nonLocalOrigin.status, 403);
  const local = await post({ origin: 'http://127.0.0.1' });
  assert.notEqual(local.status, 403); // localhost origin allowed (then processed/initialized)
});
