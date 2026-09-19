import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { readFileWithDesktopCommander } from '../../src/local/read.js';
import { searchWithOptions } from '../../src/local/search.js';
import { gitStatus, gitDiff } from '../../src/local/git.js';
import { startMcpServer } from '../../src/mcp/server.js';
import {
  COMPOSITE_EDIT_BOUNDARY_BLOCKED,
  DESKTOP_COMMANDER_REQUIRED_TOOLS,
  DESKTOP_COMMANDER_UPSTREAM_COMMIT,
  DESKTOP_COMMANDER_LICENSE,
  DESKTOP_COMMANDER_VERSION,
  DesktopCommanderChild,
  fixedGitCommand,
} from '../../src/local/desktop-commander-child.js';

async function waitFor(predicate, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('timed out waiting for child state');
}

test('DesktopCommander dependency is exact-pinned with recorded provenance', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  const lockEntry = packageLock.packages['node_modules/@wonderwhy-er/desktop-commander'];
  assert.equal(packageJson.dependencies['@wonderwhy-er/desktop-commander'], DESKTOP_COMMANDER_VERSION);
  assert.equal(packageLock.packages[''].dependencies['@wonderwhy-er/desktop-commander'], DESKTOP_COMMANDER_VERSION);
  assert.equal(lockEntry.version, DESKTOP_COMMANDER_VERSION);
  assert.equal(lockEntry.resolved, 'https://registry.npmjs.org/@wonderwhy-er/desktop-commander/-/desktop-commander-0.2.51.tgz');
  assert.equal(lockEntry.integrity, 'sha512-BF/ZV06c7mh+tzfJEkQpjcOg6UaQtzp2vRadIpA9hI+WpPDwkQ2ekdY0fbN7I4xOrCQX6NajyEPouEDXFJc1kA==');
  assert.equal(DESKTOP_COMMANDER_UPSTREAM_COMMIT, '092ce0b841e86455f12e41f4dc36399a7522ecb5');
  assert.equal(DESKTOP_COMMANDER_LICENSE, 'MIT');
});

test('real DesktopCommander child handshakes, validates required tools, and exposes sanitized health', async () => {
  const child = new DesktopCommanderChild();
  try {
    await child.ensureReady();
    const listed = await child.listTools();
    const listedNames = listed.tools.map((tool) => tool.name);
    for (const required of DESKTOP_COMMANDER_REQUIRED_TOOLS) assert.equal(listedNames.includes(required), true, `missing ${required}`);
    const health = child.health();
    assert.equal(health.state, 'ready');
    assert.equal(health.version, DESKTOP_COMMANDER_VERSION);
    assert.equal(health.generation, 1);
    assert.deepEqual(Object.keys(health).sort(), ['generation', 'state', 'version']);
    assert.equal('pid' in health, false);
    assert.equal('entryPoint' in health, false);
    assert.deepEqual(DESKTOP_COMMANDER_REQUIRED_TOOLS, [
      'read_file',
      'start_search',
      'get_more_search_results',
      'stop_search',
      'start_process',
      'read_process_output',
      'force_terminate',
    ]);
    await assert.rejects(() => child.callTool('write_file', {}), /UPSTREAM_TOOL_NOT_ALLOWED/);
    await assert.rejects(() => child.callTool('start_process', { command: 'whoami' }), /UPSTREAM_TOOL_NOT_ALLOWED/);
  } finally {
    await child.close();
  }
});

test('real child recovers lazily after an actual child kill', async () => {
  const child = new DesktopCommanderChild();
  try {
    await child.ensureReady();
    assert.equal(child.terminateForTest(), true);
    await waitFor(() => child.health().state !== 'ready');
    assert.equal(child.health().state, 'dead');
    await child.ensureReady();
    assert.equal(child.health().state, 'ready');
    assert.equal(child.health().generation, 2);
  } finally {
    await child.close();
  }
});

test('read validation rejects sensitive and outside-root paths before child dispatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue117-boundary-'));
  fs.writeFileSync(path.join(root, 'safe.txt'), 'safe', 'utf8');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=x', 'utf8');
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const workspace = registry.open({ path: root });
  let calls = 0;
  const fakeChild = { readFile: async () => { calls += 1; return 'unexpected'; } };

  await assert.rejects(() => readFileWithDesktopCommander({ workspaceId: workspace.workspaceId, path: '.env' }, registry, fakeChild), /sensitive/);
  await assert.rejects(() => readFileWithDesktopCommander({ workspaceId: workspace.workspaceId, path: '../outside.txt' }, registry, fakeChild), /escapes workspace/);
  assert.equal(calls, 0);
});

test('search validation and normalization happen around callTool', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue117-search-'));
  fs.writeFileSync(path.join(root, 'safe.txt'), 'marker here\n', 'utf8');
  fs.writeFileSync(path.join(root, '.env'), 'marker secret\n', 'utf8');
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const workspace = registry.open({ path: root });
  const calls = [];
  const fakeChild = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'start_search') return { content: [{ type: 'text', text: `Started content search session: search_test\nStatus: RUNNING\nTotal results: 1\n\nInitial results:\n📄 ${path.join(root, 'safe.txt')}:1 - marker here` }] };
      if (name === 'get_more_search_results') return { content: [{ type: 'text', text: 'Search session: search_test\nStatus: COMPLETED\nTotal results found: 1 (1 matches)\n✅ Search completed.' }] };
      if (name === 'stop_search') return { content: [{ type: 'text', text: 'stopped' }] };
      throw new Error(`unexpected child call ${name}`);
    },
  };

  const result = await searchWithOptions({ workspaceId: workspace.workspaceId, query: 'marker' }, registry, { child: fakeChild });
  assert.deepEqual(result.matches, [{ path: 'safe.txt', line: 1, snippet: 'marker here' }]);
  assert.deepEqual(calls.map((call) => call.name), ['start_search', 'get_more_search_results', 'stop_search']);
  const before = calls.length;
  await assert.rejects(() => searchWithOptions({ workspaceId: workspace.workspaceId, query: 'marker', path: '.env' }, registry, { child: fakeChild }), /sensitive/);
  assert.equal(calls.length, before);
});

test('child search reapplies scan bounds before accepting more upstream matches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue117-search-bounds-'));
  const first = path.join(root, 'first.txt');
  const second = path.join(root, 'second.txt');
  fs.writeFileSync(first, 'marker one\n', 'utf8');
  fs.writeFileSync(second, 'marker two\n', 'utf8');
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const workspace = registry.open({ path: root });
  const calls = [];
  const fakeChild = {
    callTool: async (name) => {
      calls.push(name);
      if (name === 'start_search') return { content: [{ type: 'text', text: `Started content search session: bounded\nStatus: RUNNING\nTotal results: 2\n\n📄 ${first}:1 - marker one\n📄 ${second}:1 - marker two` }] };
      if (name === 'stop_search') return { content: [{ type: 'text', text: 'stopped' }] };
      throw new Error(`unexpected child call ${name}`);
    },
  };

  const result = await searchWithOptions({ workspaceId: workspace.workspaceId, query: 'marker', maxScannedFiles: 1 }, registry, { child: fakeChild });
  assert.deepEqual(result.matches, [{ path: 'first.txt', line: 1, snippet: 'marker one' }]);
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.limitReason, 'maxScannedFiles');
  assert.deepEqual(calls, ['start_search', 'stop_search']);
});

test('git adapter uses only fixed start_process/read_process_output templates', async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'issue117-git-'));
  const repo = path.join(outer, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n', 'utf8');
  const registry = new WorkspaceRegistry({ allowedRoots: [outer] });
  const workspace = registry.open({ path: repo });
  const calls = [];
  const fakeChild = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'start_process') return { content: [{ type: 'text', text: 'Process started with PID 42' }] };
      if (name === 'read_process_output') return { content: [{ type: 'text', text: '## branch\n' }] };
      throw new Error(`unexpected child call ${name}`);
    },
  };
  const result = await gitStatus({ workspaceId: workspace.workspaceId }, registry, { child: fakeChild });
  assert.equal(result.status, '## branch');
  assert.deepEqual(calls.map((call) => call.name), ['start_process', 'read_process_output']);
  assert.match(calls[0].args.command, /git -C .* status --short --branch$/);
  assert.equal(calls[0].args.command.includes('&&'), false);
});

test('MCP schemas remain bounded and no upstream shell tool is public', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue117-schema-'));
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const fakeChild = { callTool: async () => { throw new Error('child must not be called'); } };
  const server = await startMcpServer({ workspaceRegistry: registry, desktopCommanderChild: fakeChild, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const client = new Client({ name: 'issue117-schema-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(server.url));
  t.after(() => client.close());

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const forbidden of ['shell', 'execute_command', 'read_file', 'start_process', 'write_file', 'edit_block']) {
    assert.equal(names.includes(forbidden), false, `unexpected public tool: ${forbidden}`);
  }
  const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(byName.read.inputSchema.properties).sort(), ['maxBytes', 'path', 'workspaceId']);
  assert.deepEqual(byName.read.inputSchema.required.sort(), ['path', 'workspaceId']);
  assert.deepEqual(Object.keys(byName.search.inputSchema.properties).sort(), ['maxResults', 'path', 'query', 'workspaceId']);
  assert.deepEqual(byName.search.inputSchema.required.sort(), ['query', 'workspaceId']);
  assert.deepEqual(Object.keys(byName.git_status.inputSchema.properties), ['workspaceId']);
  assert.deepEqual(Object.keys(byName.git_diff.inputSchema.properties).sort(), ['mode', 'workspaceId']);
  assert.deepEqual(byName.git_diff.inputSchema.required, ['workspaceId']);
});

test('git adapter exposes fixed templates only and Phase 4 remains blocked', () => {
  const root = path.resolve(os.tmpdir(), 'issue117 repo');
  const status = fixedGitCommand(root, 'status');
  const staged = fixedGitCommand(root, 'staged');
  assert.match(status, /^git -C /);
  assert.match(status, /status --short --branch$/);
  assert.match(staged, /diff --cached --no-ext-diff$/);
  assert.throws(() => fixedGitCommand(root, 'status && whoami'), (error) => error?.code === 'GIT_COMMAND_FAILED');
  assert.equal(COMPOSITE_EDIT_BOUNDARY_BLOCKED, 'COMPOSITE_EDIT_BOUNDARY_BLOCKED');
  assert.equal(DESKTOP_COMMANDER_REQUIRED_TOOLS.includes('write_file'), false);
  assert.equal(DESKTOP_COMMANDER_REQUIRED_TOOLS.includes('edit_block'), false);
});


test('real pinned child executes authorized read and content search', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue117-real-io-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'note.txt'), 'alpha marker omega\nsecond line\n', 'utf8');
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const workspace = registry.open({ path: root });
  const child = new DesktopCommanderChild();
  try {
    const read = await readFileWithDesktopCommander({ workspaceId: workspace.workspaceId, path: 'src/note.txt', maxBytes: 1024 }, registry, child);
    assert.equal(read.content.includes('alpha marker omega'), true);
    assert.equal(read.path, 'src/note.txt');
    assert.equal(read.truncated, false);
    assert.ok(read.sha256);

    const searched = await searchWithOptions({ workspaceId: workspace.workspaceId, query: 'marker', path: 'src', maxResults: 10, maxScannedFiles: 10, maxScannedBytes: 1024 }, registry, { child });
    assert.equal(searched.matches.some((m) => m.path === 'src/note.txt' && m.line === 1 && m.snippet.includes('marker')), true);
    assert.equal(searched.truncated, false);
  } finally {
    await child.close();
  }
});

test('real pinned child executes git_status and staged/worktree git_diff via process output', async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'issue117-real-git-'));
  const repo = path.join(outer, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n', 'utf8');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'staged\n', 'utf8');
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });

  const registry = new WorkspaceRegistry({ allowedRoots: [outer] });
  const workspace = registry.open({ path: repo });
  const child = new DesktopCommanderChild();
  try {
    const status = await gitStatus({ workspaceId: workspace.workspaceId }, registry, { child });
    assert.equal(status.status.includes('a.txt'), true);
    assert.equal(status.status.includes('b.txt'), true);
    assert.equal(status.truncated, false);

    const worktree = await gitDiff({ workspaceId: workspace.workspaceId, mode: 'worktree' }, registry, { child });
    assert.equal(worktree.mode, 'worktree');
    assert.equal(worktree.diff.includes('two'), true);
    assert.equal(worktree.truncated, false);

    const staged = await gitDiff({ workspaceId: workspace.workspaceId, mode: 'staged' }, registry, { child });
    assert.equal(staged.mode, 'staged');
    assert.equal(staged.diff.includes('b.txt'), true);
    assert.equal(staged.diff.includes('staged'), true);
    assert.equal(staged.truncated, false);
  } finally {
    await child.close();
  }
});

test('real child preserves the 200 KiB git diff output bound', async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'issue117-real-git-bound-'));
  const repo = path.join(outer, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'small\\n', 'utf8');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), ('x'.repeat(80) + '\\n').repeat(4000), 'utf8');

  const registry = new WorkspaceRegistry({ allowedRoots: [outer] });
  const workspace = registry.open({ path: repo });
  const child = new DesktopCommanderChild();
  try {
    const result = await gitDiff({ workspaceId: workspace.workspaceId, mode: 'worktree' }, registry, { child });
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.diff, 'utf8') <= 200 * 1024);
    assert.ok(result.diff.length > 0);
  } finally {
    await child.close();
  }
});
