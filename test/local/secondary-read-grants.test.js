import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { readFileWithDesktopCommander } from '../../src/local/read.js';
import { searchWithOptions } from '../../src/local/search.js';
import { DesktopCommanderChild } from '../../src/local/desktop-commander-child.js';

function fixture() {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'issue124-grants-'));
  const primary = path.join(host, 'primary');
  const external = path.join(host, 'external');
  const sibling = path.join(host, 'sibling');
  fs.mkdirSync(primary); fs.mkdirSync(external); fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(primary, 'primary.txt'), 'primary marker\n', 'utf8');
  fs.writeFileSync(path.join(external, 'allowed.txt'), 'external marker\n', 'utf8');
  fs.writeFileSync(path.join(external, 'second.txt'), 'external marker two\n', 'utf8');
  fs.writeFileSync(path.join(external, '.env'), 'TOKEN=secret\n', 'utf8');
  fs.writeFileSync(path.join(external, 'crafted.pdf'), 'plain marker payload\n', 'utf8');
  fs.writeFileSync(path.join(sibling, 'blocked.txt'), 'external marker blocked\n', 'utf8');
  const registry = new WorkspaceRegistry({ allowedRoots: [host] });
  const workspace = registry.open({ path: primary });
  return { host, primary, external, sibling, registry, workspace };
}function readChild(calls, content = 'child content\n') {
  return { readFile: async (args) => { calls.push(args); return content; } };
}

function searchChild(startText, calls = []) {
  return {
    startSearch: async (args) => { calls.push(['start', args]); return startText; },
    getMoreSearchResults: async (args) => {
      calls.push(['more', args]);
      return 'Search session: s1\nStatus: COMPLETED\nTotal results found: 1\n✅ Search completed.';
    },
    stopSearch: async (args) => { calls.push(['stop', args]); return 'stopped'; },
  };
}

test('primary workspace read/search behavior stays compatible with no grants', async () => {
  const { primary, registry, workspace } = fixture();
  const readCalls = [];
  const read = await readFileWithDesktopCommander(
    { workspaceId: workspace.workspaceId, path: 'primary.txt' }, registry, readChild(readCalls, 'primary marker\n'));
  assert.equal(read.path, 'primary.txt');
  assert.equal(read.content, 'primary marker\n');
  assert.equal(readCalls[0].path, fs.realpathSync.native(path.join(primary, 'primary.txt')));

  const target = path.join(primary, 'primary.txt');
  const child = searchChild(`Started content search session: s1\nStatus: RUNNING\nTotal results: 1\n📄 ${target}:1 - primary marker`);
  const search = await searchWithOptions({ workspaceId: workspace.workspaceId, query: 'marker' }, registry, { child });
  assert.deepEqual(search.matches, [{ path: 'primary.txt', line: 1, snippet: 'primary marker' }]);
});test('exact external file grant permits only that canonical file and preserves byte bounds', async () => {
  const { external, sibling, registry, workspace } = fixture();
  const grantFile = path.join(external, 'allowed.txt');
  const grants = registry.normalizeSecondaryReadGrants([grantFile]);
  assert.deepEqual(grants, [{ kind: 'file', path: fs.realpathSync.native(grantFile) }]);

  const calls = [];
  const read = await readFileWithDesktopCommander(
    { workspaceId: workspace.workspaceId, path: grantFile, maxBytes: 4, secondaryReadGrants: grants },
    registry, readChild(calls, 'external marker\n'));
  assert.equal(read.path, fs.realpathSync.native(grantFile));
  assert.equal(read.content, 'exte');
  assert.equal(read.truncated, true);
  assert.equal(calls.length, 1);

  await assert.rejects(
    () => readFileWithDesktopCommander({
      workspaceId: workspace.workspaceId, path: path.join(external, 'second.txt'), secondaryReadGrants: grants,
    }, registry, readChild(calls)),
    /not authorized by a secondary read grant/);
  await assert.rejects(
    () => readFileWithDesktopCommander({
      workspaceId: workspace.workspaceId, path: path.join(sibling, 'blocked.txt'), secondaryReadGrants: grants,
    }, registry, readChild(calls)),
    /not authorized by a secondary read grant/);
  assert.equal(calls.length, 1, 'ungranted reads fail before child dispatch');
});test('external directory grant permits read and exact-root search while revalidating child matches', async () => {
  const { external, sibling, registry, workspace } = fixture();
  const grants = registry.normalizeSecondaryReadGrants([external]);
  const calls = [];
  const allowed = path.join(external, 'allowed.txt');
  const blocked = path.join(sibling, 'blocked.txt');

  const read = await readFileWithDesktopCommander(
    { workspaceId: workspace.workspaceId, path: allowed, secondaryReadGrants: grants },
    registry, readChild(calls, 'external marker\n'));
  assert.equal(read.content, 'external marker\n');

  const searchCalls = [];
  const child = searchChild(
    `Started content search session: s1\nStatus: RUNNING\nTotal results: 2\n📄 ${allowed}:1 - external marker\n📄 ${blocked}:1 - external marker blocked`,
    searchCalls,
  );
  const result = await searchWithOptions({
    workspaceId: workspace.workspaceId, query: 'external marker', path: external,
    secondaryReadGrants: grants, maxResults: 10,
  }, registry, { child });
  assert.deepEqual(result.matches, [{ path: fs.realpathSync.native(allowed), line: 1, snippet: 'external marker' }]);
  assert.equal(searchCalls[0][1].path, fs.realpathSync.native(external));
});test('secondary root rejects sibling, parent widening, sub-root search, sensitive and special-format before dispatch', async () => {
  const { external, sibling, registry, workspace } = fixture();
  const grants = registry.normalizeSecondaryReadGrants([external]);
  let readCalls = 0;
  const child = { readFile: async () => { readCalls += 1; return 'unexpected'; } };

  for (const target of [
    path.join(external, '..', 'sibling', 'blocked.txt'),
    path.join(sibling, 'blocked.txt'),
    path.join(external, '.env'),
    path.join(external, 'crafted.pdf'),
  ]) {
    await assert.rejects(
      () => readFileWithDesktopCommander({
        workspaceId: workspace.workspaceId, path: target, secondaryReadGrants: grants,
      }, registry, child),
      /secondary read grant|sensitive path blocked|special-format read blocked/,
    );
  }
  assert.equal(readCalls, 0);

  fs.mkdirSync(path.join(external, 'sub'));
  const searchCalls = [];
  await assert.rejects(
    () => searchWithOptions({
      workspaceId: workspace.workspaceId, query: 'marker', path: path.join(external, 'sub'),
      secondaryReadGrants: grants,
    }, registry, { child: searchChild('', searchCalls) }),
    /exact secondary directory grant/);
  assert.equal(searchCalls.length, 0);
});test('secondary root rejects symlink or junction escape before child dispatch', async (t) => {
  const { external, sibling, registry, workspace } = fixture();
  const grants = registry.normalizeSecondaryReadGrants([external]);
  const link = path.join(external, 'escape-link');
  try {
    fs.symlinkSync(sibling, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('symlink/junction creation not permitted in this environment');
    return;
  }
  let calls = 0;
  await assert.rejects(
    () => readFileWithDesktopCommander({
      workspaceId: workspace.workspaceId, path: path.join(link, 'blocked.txt'), secondaryReadGrants: grants,
    }, registry, { readFile: async () => { calls += 1; return 'unexpected'; } }),
    /not authorized by a secondary read grant/);
  assert.equal(calls, 0);
});

test('external search retains scan/result budgets', async () => {
  const { external, registry, workspace } = fixture();
  const grants = registry.normalizeSecondaryReadGrants([external]);
  const first = path.join(external, 'allowed.txt');
  const second = path.join(external, 'second.txt');
  const child = searchChild(
    `Started content search session: s1\nStatus: RUNNING\nTotal results: 2\n📄 ${first}:1 - external marker\n📄 ${second}:1 - external marker two`,
  );
  const result = await searchWithOptions({
    workspaceId: workspace.workspaceId, query: 'marker', path: external,
    secondaryReadGrants: grants, maxScannedFiles: 1, maxResults: 10,
  }, registry, { child });
  assert.equal(result.matches.length, 1);
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.limitReason, 'maxScannedFiles');
});

test('secondary grants stay inside the host trust ceiling and never widen resolveWritable', () => {
  const { external, registry, workspace } = fixture();
  registry.normalizeSecondaryReadGrants([external]);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'issue124-outside-ceiling-'));
  fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside\n', 'utf8');
  assert.throws(
    () => registry.normalizeSecondaryReadGrants([path.join(outside, 'outside.txt')]),
    /not within configured allowed roots/,
  );
  assert.throws(
    () => registry.resolveWritable(workspace.workspaceId, path.join(external, 'allowed.txt')),
    /absolute path not allowed/,
  );
});

test('real pinned DesktopCommander child executes external granted read/search', async () => {
  const { external, registry, workspace } = fixture();
  const grants = registry.normalizeSecondaryReadGrants([external]);
  const target = path.join(external, 'allowed.txt');
  const child = new DesktopCommanderChild();
  try {
    const read = await readFileWithDesktopCommander({
      workspaceId: workspace.workspaceId, path: target, secondaryReadGrants: grants,
    }, registry, child);
    assert.match(read.content, /external marker/);
    const search = await searchWithOptions({
      workspaceId: workspace.workspaceId, query: 'marker', path: external,
      secondaryReadGrants: grants, maxResults: 10, maxScannedFiles: 10, maxScannedBytes: 4096,
    }, registry, { child });
    assert.equal(search.matches.some((m) => m.path === fs.realpathSync.native(target)), true);
  } finally {
    await child.close();
  }
});