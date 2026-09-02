// scripts/mcp-local-direct-mutation-smoke.mjs
// Real local Direct Local mutation smoke (M3), in a TEMPORARY git repo.
//   start MCP server -> workspace_open(temp repo) -> read(sha256) -> edit preview
//   -> confirm unchanged -> edit apply -> confirm changed -> git_diff -> re-apply
//   is idempotent -> one injected safe verify check -> clean shutdown.
// No production repo mutation. Exit 0 = PASS, 1 = FAIL.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../src/mcp/server.js';
import { WorkspaceRegistry } from '../src/local/workspace.js';
import { MutationOwner } from '../src/state/mutation-owner.js';
import { OperationState } from '../src/state/operation-state.js';

function textOf(res) { const t = res && res.content && res.content.find((c) => c.type === 'text'); return t ? t.text : ''; }

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-smoke-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello world\n', 'utf8');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const shared = new MutationOwner();
  const ops = new OperationState({ dataRoot: root });
  const verifyChecks = { syntax: { command: process.execPath, args: ['-e', 'process.exit(0)'], effect: 'read_only', timeoutMs: 5000 } };
  const srv = await startMcpServer({ workspaceRegistry: registry, mutationOwner: shared, operationState: ops, verifyChecks, host: '127.0.0.1', port: 0, allowedRoots: [root] });
  const client = new Client({ name: 'm3-smoke', version: '0.2.0-dev' });
  try {
    await client.connect(new StreamableHTTPClientTransport(srv.url));
    const ws = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: repo } })));
    const rd = JSON.parse(textOf(await client.callTool({ name: 'read', arguments: { workspaceId: ws.workspaceId, path: 'a.txt' } })));
    if (!rd.sha256) throw new Error('read did not expose sha256');
    const p = JSON.parse(textOf(await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'preview', change: { path: 'a.txt', baseHash: rd.sha256, replacements: [{ oldText: 'world', newText: 'there' }] } } })));
    if (!p.changeSetId) throw new Error('preview returned no changeSetId');
    if (fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') !== 'hello world\n') throw new Error('preview mutated file');
    await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'apply', changeSetId: p.changeSetId } });
    if (fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') !== 'hello there\n') throw new Error('apply did not change file');
    const gd = JSON.parse(textOf(await client.callTool({ name: 'git_diff', arguments: { workspaceId: ws.workspaceId, mode: 'worktree' } })));
    if (typeof gd.diff !== 'string' || !gd.diff) throw new Error('git_diff did not show intended change');
    const replay = JSON.parse(textOf(await client.callTool({ name: 'edit', arguments: { workspaceId: ws.workspaceId, mode: 'apply', changeSetId: p.changeSetId } })));
    if (replay.idempotentReplay !== true) throw new Error('re-apply was not idempotent');
    const v = JSON.parse(textOf(await client.callTool({ name: 'verify', arguments: { workspaceId: ws.workspaceId, check: 'syntax' } })));
    if (v.passed !== true) throw new Error('verify did not pass');
    await client.close();
    await srv.close();
    process.stdout.write('LOCAL_DIRECT_MUTATION_SMOKE=PASS\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write('LOCAL_DIRECT_MUTATION_SMOKE=FAIL: ' + (e && e.message || e) + '\n');
    process.exit(1);
  } finally {
    try { await client.close(); } catch {}
    try { await srv.close(); } catch {}
  }
}
main();
