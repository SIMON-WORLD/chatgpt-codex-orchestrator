import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { WorktreeService } from '../../src/local/worktree.js';

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git failed: ' + (r.stderr || r.stdout));
  return r.stdout.trim();
}
function textOf(res) { const t = res && res.content && res.content.find((c) => c.type === 'text'); return t ? t.text : ''; }

function fixture(prefix = 'wtmcp-') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = fs.realpathSync.native(tmp);
  const repo = path.join(root, 'main-repo');
  const pool = path.join(root, 'wt-pool');
  fs.mkdirSync(pool, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  return { root, repo, pool, head };
}

async function setup(repo, pool) {
  const registry = new WorkspaceRegistry({ allowedRoots: [repo, pool] });
  const worktreeService = new WorktreeService({ poolRoot: pool, trustedRepos: [repo] });
  const srv = await startMcpServer({ workspaceRegistry: registry, worktreeService, host: '127.0.0.1', port: 0, allowedRoots: [repo, pool] });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(srv.url));
  return { registry, srv, client };
}

test('worktree_create MCP tool creates in the pool and workspace_open binds it without restart', async (t) => {
  const { repo, pool, head } = fixture();
  const { registry, srv, client } = await setup(repo, pool);
  t.after(() => client.close());
  t.after(() => srv.close());

  const names = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes('worktree_create'), 'worktree_create should be registered when configured');

  const created = JSON.parse(textOf(await client.callTool({ name: 'worktree_create', arguments: { repo, targetPath: path.join(pool, 'issue-29-wt'), branch: 'feat/issue-29-wt', startPoint: head } })));
  assert.ok(created.path);
  assert.equal(path.resolve(created.path), path.resolve(pool, 'issue-29-wt'));
  assert.ok(fs.existsSync(created.path));

  const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: created.path } })));
  assert.ok(ws.workspaceId);
  assert.equal(path.resolve(ws.root), path.resolve(created.path));
  const st = JSON.parse(textOf(await client.callTool({ name: 'git_status', arguments: { workspaceId: ws.workspaceId } })));
  assert.match(st.status, /feat\/issue-29-wt/);
});

test('worktree_create rejects escape/existing/untrusted/unsafe cases through MCP', async (t) => {
  const { root, repo, pool, head } = fixture();
  const { registry, srv, client } = await setup(repo, pool);
  t.after(() => client.close());
  t.after(() => srv.close());

  const escape = await client.callTool({ name: 'worktree_create', arguments: { repo, targetPath: path.join(root, 'escape'), branch: 'feat/x', startPoint: head } });
  assert.equal(escape.isError, true);
  assert.match(textOf(escape), /pool_escape|escapes/);

  const existingDir = path.join(pool, 'taken');
  fs.mkdirSync(existingDir);
  const existing = await client.callTool({ name: 'worktree_create', arguments: { repo, targetPath: existingDir, branch: 'feat/x', startPoint: head } });
  assert.equal(existing.isError, true);
  assert.match(textOf(existing), /target already exists|target_exists/);

  const unsafe = await client.callTool({ name: 'worktree_create', arguments: { repo, targetPath: path.join(pool, 'unsafe'), branch: '-oops', startPoint: head } });
  assert.equal(unsafe.isError, true);

  const other = path.join(root, 'other-repo');
  fs.mkdirSync(other);
  git(other, ['init', '-q']);
  git(other, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init']);
  const untrusted = await client.callTool({ name: 'worktree_create', arguments: { repo: other, targetPath: path.join(pool, 'u'), branch: 'feat/x', startPoint: head } });
  assert.equal(untrusted.isError, true);
  assert.match(textOf(untrusted), /not explicitly trusted|untrusted/);
});
