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
      'read_multiple_files',
      'write_file',
      'edit_block',
      'write_pdf',
      'create_directory',
      'list_directory',
      'move_file',
      'get_file_info',
      'start_search',
      'get_more_search_results',
      'stop_search',
      'start_process',
      'read_process_output',
      'force_terminate',
    ]);
    for (const mutationTool of ['write_file', 'edit_block', 'write_pdf', 'create_directory', 'move_file']) {
      await assert.rejects(() => child.callTool(mutationTool, {}), /UPSTREAM_TOOL_NOT_ALLOWED/);
    }
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

test('real pinned child lazily creates a directory and moves a file while healthy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue137-real-fs-'));
  const directory = path.join(root, 'created', 'nested');
  const source = path.join(root, 'source.txt');
  const destination = path.join(directory, 'moved.txt');
  fs.writeFileSync(source, 'issue 137\n', 'utf8');
  const child = new DesktopCommanderChild();
  try {
    assert.deepEqual(child.health(), { state: 'idle', version: DESKTOP_COMMANDER_VERSION, generation: 0 });
    assert.match(await child.createDirectory({ path: directory }), /Successfully created directory/u);
    assert.match(await child.moveFile({ source, destination }), /Successfully moved/u);
    assert.equal(fs.existsSync(directory), true);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'issue 137\n');
    assert.deepEqual(child.health(), { state: 'ready', version: DESKTOP_COMMANDER_VERSION, generation: 1 });
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

test('child-backed read rejects special formats before fake or real child dispatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue117-special-format-'));
  for (const name of ['crafted.pdf', 'sheet.xlsx', 'image.png', 'doc.docx']) {
    // ASCII payloads ensure this is the explicit extension gate, not the
    // pre-existing NUL-byte binary heuristic.
    fs.writeFileSync(path.join(root, name), 'plain text payload\n', 'utf8');
  }
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const workspace = registry.open({ path: root });

  let fakeCalls = 0;
  const fakeChild = {
    callTool: async () => {
      fakeCalls += 1;
      throw new Error('special-format read must not dispatch');
    },
  };
  for (const name of ['crafted.pdf', 'sheet.xlsx', 'image.png', 'doc.docx']) {
    await assert.rejects(
      () => readFileWithDesktopCommander({ workspaceId: workspace.workspaceId, path: name }, registry, fakeChild),
      /special-format read blocked/,
    );
  }
  assert.equal(fakeCalls, 0);

  const realChild = new DesktopCommanderChild();
  try {
    await assert.rejects(
      () => readFileWithDesktopCommander({ workspaceId: workspace.workspaceId, path: 'crafted.pdf' }, registry, realChild),
      /special-format read blocked/,
    );
    assert.deepEqual(realChild.health(), { state: 'idle', version: DESKTOP_COMMANDER_VERSION, generation: 0 });
  } finally {
    await realChild.close();
  }
});

test('search validation and normalization happen around callTool', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue117-search-'));
  fs.writeFileSync(path.join(root, 'safe.txt'), 'marker here\n', 'utf8');
  fs.writeFileSync(path.join(root, '.env'), 'marker secret\n', 'utf8');
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const workspace = registry.open({ path: root });
  const calls = [];
  const fakeChild = {
    startSearch: async (args) => {
      calls.push({ name: 'start_search', args });
      return `Started content search session: search_test\nStatus: RUNNING\nTotal results: 1\n\nInitial results:\n📄 ${path.join(root, 'safe.txt')}:1 - marker here`;
    },
    getMoreSearchResults: async (args) => {
      calls.push({ name: 'get_more_search_results', args });
      return 'Search session: search_test\nStatus: COMPLETED\nTotal results found: 1 (1 matches)\n✅ Search completed.';
    },
    stopSearch: async (args) => {
      calls.push({ name: 'stop_search', args });
      return 'stopped';
    },
  };

  const result = await searchWithOptions({ workspaceId: workspace.workspaceId, query: 'marker' }, registry, { child: fakeChild });
  assert.deepEqual(result.matches, [{ path: 'safe.txt', line: 1, snippet: 'marker here' }]);
  assert.deepEqual(calls.map((call) => call.name), ['start_search', 'get_more_search_results', 'stop_search']);

  const startArgs = calls.find((call) => call.name === 'start_search').args;
  assert.equal(Object.hasOwn(startArgs, 'filePattern'), false);
  assert.equal(fs.statSync(startArgs.path).isDirectory(), true);

  fs.writeFileSync(path.join(root, 'office.xlsx'), 'marker office\n', 'utf8');
  const before = calls.length;
  await assert.rejects(() => searchWithOptions({ workspaceId: workspace.workspaceId, query: 'marker', path: '.env' }, registry, { child: fakeChild }), /sensitive/);
  await assert.rejects(() => searchWithOptions({ workspaceId: workspace.workspaceId, query: 'marker', path: 'office.xlsx' }, registry, { child: fakeChild }), /scope is not a directory/);
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
    startSearch: async () => {
      calls.push('start_search');
      return `Started content search session: bounded\nStatus: RUNNING\nTotal results: 2\n\n📄 ${first}:1 - marker one\n📄 ${second}:1 - marker two`;
    },
    stopSearch: async () => {
      calls.push('stop_search');
      return 'stopped';
    },
  };

  const result = await searchWithOptions({ workspaceId: workspace.workspaceId, query: 'marker', maxScannedFiles: 1 }, registry, { child: fakeChild });
  assert.deepEqual(result.matches, [{ path: 'first.txt', line: 1, snippet: 'marker one' }]);
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.limitReason, 'maxScannedFiles');
  assert.deepEqual(calls, ['start_search', 'stop_search']);
});

test('git adapter delegates only validated repository root and mode to the child', async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'issue120-git-'));
  const repo = path.join(outer, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const registry = new WorkspaceRegistry({ allowedRoots: [outer] });
  const workspace = registry.open({ path: repo });
  const calls = [];
  const fakeChild = {
    runGit: async (args) => {
      calls.push(args);
      return { output: '## branch\n', truncated: false };
    },
  };
  const result = await gitStatus({ workspaceId: workspace.workspaceId }, registry, { child: fakeChild });
  assert.equal(result.status, '## branch');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspaceRoot, fs.realpathSync.native(repo));
  assert.equal(calls[0].mode, 'status');
  await assert.rejects(() => gitDiff({ workspaceId: workspace.workspaceId, mode: 'HEAD~1' }, registry, { child: fakeChild }), /unsupported git diff mode/);
  assert.equal(calls.length, 1);
});

test('commodity read/search/git execution fails closed without the DesktopCommander child', async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'issue120-no-fallback-'));
  const repo = path.join(outer, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'safe.txt'), 'marker here\n', 'utf8');
  const registry = new WorkspaceRegistry({ allowedRoots: [outer] });
  const workspace = registry.open({ path: repo });

  await assert.rejects(() => readFileWithDesktopCommander({ workspaceId: workspace.workspaceId, path: 'safe.txt' }, registry), /child adapter is required/);
  await assert.rejects(() => searchWithOptions({ workspaceId: workspace.workspaceId, query: 'marker' }, registry), /child adapter is required/);
  await assert.rejects(() => gitStatus({ workspaceId: workspace.workspaceId }, registry), /child adapter is required/);
  await assert.rejects(() => gitDiff({ workspaceId: workspace.workspaceId, mode: 'worktree' }, registry), /child adapter is required/);
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
  assert.deepEqual(Object.keys(byName.read.inputSchema.properties).sort(), ['maxBytes', 'maxLines', 'offset', 'path', 'workspaceId']);
  assert.deepEqual(byName.read.inputSchema.required.sort(), ['path', 'workspaceId']);
  assert.deepEqual(Object.keys(byName.read_multiple.inputSchema.properties).sort(), ['maxBytes', 'maxLines', 'paths', 'workspaceId']);
  assert.deepEqual(Object.keys(byName.list_directory.inputSchema.properties).sort(), ['depth', 'maxResults', 'path', 'workspaceId']);
  assert.deepEqual(Object.keys(byName.file_info.inputSchema.properties).sort(), ['path', 'workspaceId']);
  assert.deepEqual(Object.keys(byName.filename_search.inputSchema.properties).sort(), ['maxResults', 'path', 'query', 'workspaceId']);
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
  assert.equal(DESKTOP_COMMANDER_REQUIRED_TOOLS.includes('write_file'), true);
  assert.equal(DESKTOP_COMMANDER_REQUIRED_TOOLS.includes('edit_block'), true);
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

test('Issue #124 public schema delta is limited to read-only workspace_open secondaryReadGrants', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue124-schema-'));
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const server = await startMcpServer({ workspaceRegistry: registry, desktopCommanderChild: {}, host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const client = new Client({ name: 'issue124-schema-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(server.url));
  t.after(() => client.close());
  const listed = await client.listTools();
  const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(Object.keys(byName.read.inputSchema.properties).sort(), ['maxBytes', 'maxLines', 'offset', 'path', 'workspaceId']);
  assert.deepEqual(Object.keys(byName.read_multiple.inputSchema.properties).sort(), ['maxBytes', 'maxLines', 'paths', 'workspaceId']);
  assert.deepEqual(Object.keys(byName.list_directory.inputSchema.properties).sort(), ['depth', 'maxResults', 'path', 'workspaceId']);
  assert.deepEqual(Object.keys(byName.file_info.inputSchema.properties).sort(), ['path', 'workspaceId']);
  assert.deepEqual(Object.keys(byName.filename_search.inputSchema.properties).sort(), ['maxResults', 'path', 'query', 'workspaceId']);
  assert.deepEqual(Object.keys(byName.search.inputSchema.properties).sort(), ['maxResults', 'path', 'query', 'workspaceId']);
  assert.ok(byName.workspace_open.inputSchema.properties.secondaryReadGrants);
  assert.equal(byName.workspace_open.annotations.readOnlyHint, true);
  for (const name of ['governance_plan', 'governance_transition', 'read', 'search', 'git_status', 'git_diff']) {
    assert.equal(Object.hasOwn(byName[name].inputSchema.properties, 'secondaryReadGrants'), false);
  }
  for (const forbidden of ['shell', 'execute_command', 'start_process', 'write_file', 'edit_block', 'config']) {
    assert.equal(Object.hasOwn(byName, forbidden), false);
  }
});

test('Issue #124 workspace_open binds grants to one read-only workspace handle without Governance mutation', async (t) => {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'issue124-workspace-binding-'));
  const primary = path.join(host, 'primary');
  const external = path.join(host, 'external');
  fs.mkdirSync(primary); fs.mkdirSync(external);
  const granted = path.join(external, 'granted.txt');
  fs.writeFileSync(granted, 'granted marker\n', 'utf8');
  const registry = new WorkspaceRegistry({ allowedRoots: [host] });
  let readCalls = 0;
  let searchCalls = 0;
  const fakeChild = {
    readFile: async () => { readCalls += 1; return 'granted marker\n'; },
    startSearch: async () => {
      searchCalls += 1;
      return `Started content search session: issue124-session\nStatus: COMPLETED\nTotal results: 1\n📄 ${granted}:1 - granted marker`;
    },
    getMoreSearchResults: async () => 'Search session: issue124-session\nStatus: COMPLETED\nTotal results found: 1\n✅ Search completed.',
    stopSearch: async () => 'stopped',
  };
  const server = await startMcpServer({
    workspaceRegistry: registry, desktopCommanderChild: fakeChild, host: '127.0.0.1', port: 0,
  });
  t.after(() => server.close());
  const client = new Client({ name: 'issue124-workspace-binding', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(server.url));
  t.after(() => client.close());

  const plainOpen = await client.callTool({
    name: 'workspace_open', arguments: { path: primary },
  });
  assert.notEqual(plainOpen.isError, true);
  const plain = JSON.parse(plainOpen.content[0].text);
  assert.equal(plain.secondaryReadGrantCount, 0);

  const grantedOpen = await client.callTool({
    name: 'workspace_open', arguments: { path: primary, secondaryReadGrants: [external] },
  });
  assert.notEqual(grantedOpen.isError, true);
  const bound = JSON.parse(grantedOpen.content[0].text);
  assert.equal(bound.secondaryReadGrantCount, 1);
  assert.notEqual(bound.workspaceId, plain.workspaceId);

  const allowed = await client.callTool({
    name: 'read', arguments: { workspaceId: bound.workspaceId, path: granted },
  });
  assert.notEqual(allowed.isError, true);
  assert.equal(readCalls, 1);

  const searched = await client.callTool({
    name: 'search', arguments: { workspaceId: bound.workspaceId, query: 'marker', path: external, maxResults: 10 },
  });
  assert.notEqual(searched.isError, true);
  assert.equal(searchCalls, 1);

  const blocked = await client.callTool({
    name: 'read', arguments: { workspaceId: plain.workspaceId, path: granted },
  });
  assert.equal(blocked.isError, true);
  assert.equal(readCalls, 1, 'grant-free handle read must fail before child dispatch');

  const blockedSearch = await client.callTool({
    name: 'search', arguments: { workspaceId: plain.workspaceId, query: 'marker', path: external, maxResults: 10 },
  });
  assert.equal(blockedSearch.isError, true);
  assert.equal(searchCalls, 1, 'grant-free handle search must fail before child dispatch');

  const listed = await client.listTools();
  const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
  assert.equal(Object.hasOwn(byName.governance_plan.inputSchema.properties, 'secondaryReadGrants'), false);
  assert.equal(Object.hasOwn(byName.governance_transition.inputSchema.properties, 'secondaryReadGrants'), false);
});
