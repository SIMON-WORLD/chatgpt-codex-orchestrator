// scripts/mcp-local-smoke.mjs
// Real LOCAL MCP smoke for M2 (no Secure Tunnel / no live Codex).
//   start MCP server on 127.0.0.1
//   -> official MCP client
//   -> initialize
//   -> tools/list
//   -> workspace_open(test repo)
//   -> read known file
//   -> search known marker
//   -> git_status
//   -> git_diff
//   -> clean shutdown
// Does NOT modify repository contents.
//
// Run explicitly (NOT part of `npm test`):
//   node scripts/mcp-local-smoke.mjs
// Exit 0 = PASS, 1 = FAIL.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer } from '../src/mcp/server.js';
import { WorkspaceRegistry } from '../src/local/workspace.js';

function textOf(res) { const t = res && res.content && res.content.find((c) => c.type === 'text'); return t ? t.text : ''; }

async function main() {
  // Isolated temp workspace (not the orchestrator repo).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'hello.txt'), 'SMOKE_MARKER present\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'u\n', 'utf8');
  execFileSync('git', ['add', 'hello.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const srv = await startMcpServer({ workspaceRegistry: registry, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  const client = new Client({ name: 'mcp-local-smoke', version: '0.2.0' });

  try {
    await client.connect(new StreamableHTTPClientTransport(srv.url));
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);

    const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repo } })));
    if (!ws.workspaceId || !ws.isGitRepo) throw new Error('workspace_open failed');

    const rd = JSON.parse(textOf(await client.callTool({ name: 'read', arguments: { workspaceId: ws.workspaceId, path: 'hello.txt' } })));
    if (!rd.content.includes('SMOKE_MARKER')) throw new Error('read did not return marker');

    const se = JSON.parse(textOf(await client.callTool({ name: 'search', arguments: { workspaceId: ws.workspaceId, query: 'SMOKE_MARKER' } })));
    if (!se.matches || se.matches.length < 1) throw new Error('search returned no matches');

    const gs = JSON.parse(textOf(await client.callTool({ name: 'git_status', arguments: { workspaceId: ws.workspaceId } })));
    if (!gs.status.includes('untracked.txt')) throw new Error('git_status missing untracked file');

    const gd = JSON.parse(textOf(await client.callTool({ name: 'git_diff', arguments: { workspaceId: ws.workspaceId, mode: 'worktree' } })));
    if (typeof gd.diff !== 'string') throw new Error('git_diff invalid');

    process.stdout.write(`tools=${names.join(',')}\n`);
    process.stdout.write('LOCAL_MCP_SMOKE=PASS\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`LOCAL_MCP_SMOKE=FAIL: ${e && e.message || e}\n`);
    process.exit(1);
  } finally {
    try { await client.close(); } catch {}
    await srv.close();
  }
}

main();
