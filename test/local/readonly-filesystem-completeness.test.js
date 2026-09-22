import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { readFileWithDesktopCommander } from '../../src/local/read.js';
import {
  fileInfoWithDesktopCommander,
  filenameSearchWithDesktopCommander,
  listDirectoryWithDesktopCommander,
  readMultipleFilesWithDesktopCommander,
} from '../../src/local/filesystem.js';
import { DesktopCommanderChild } from '../../src/local/desktop-commander-child.js';

function setup() {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'issue132-rofs-'));
  const primary = path.join(host, 'primary');
  const secondary = path.join(host, 'secondary');
  const sibling = path.join(host, 'sibling');
  fs.mkdirSync(primary); fs.mkdirSync(secondary); fs.mkdirSync(sibling);
  fs.mkdirSync(path.join(primary, 'dir'));
  fs.writeFileSync(path.join(primary, 'page.txt'), 'zero\none\ntwo\nthree\nfour\n', 'utf8');
  fs.writeFileSync(path.join(primary, 'dir', 'alpha.txt'), 'alpha\n', 'utf8');
  fs.writeFileSync(path.join(primary, 'dir', 'beta.log'), 'beta\n', 'utf8');
  fs.writeFileSync(path.join(secondary, 'granted.txt'), 's0\ns1\ns2\ns3\n', 'utf8');
  fs.writeFileSync(path.join(secondary, 'other.txt'), 'other\n', 'utf8');
  fs.writeFileSync(path.join(secondary, 'crafted.pdf'), 'plain special payload\n', 'utf8');
  fs.writeFileSync(path.join(sibling, 'blocked.txt'), 'blocked\n', 'utf8');
  const registry = new WorkspaceRegistry({ allowedRoots: [host] });
  const plain = registry.open({ path: primary });
  const granted = registry.open({ path: primary, secondaryReadGrants: [secondary] });
  return { host, primary, secondary, sibling, registry, plain, granted };
}

test('range reads preserve ordinary compatibility and support primary/secondary continuation', async () => {
  const { primary, secondary, registry, plain, granted } = setup();
  const calls = [];
  const child = {
    readFile: async (args) => {
      calls.push(args);
      const lines = fs.readFileSync(args.path, 'utf8').split(/\r?\n/);
      const body = lines.slice(args.offset, args.offset + args.maxLines).join('\n');
      return `[Reading ${Math.min(args.maxLines, lines.length - args.offset)} lines]\n\n${body}`;
    },
  };
  const ordinary = await readFileWithDesktopCommander({ workspaceId: plain.workspaceId, path: 'page.txt', maxBytes: 1024 }, registry, child);
  assert.equal(ordinary.offset, 0);
  assert.match(ordinary.content, /^zero/);
  const primaryRange = await readFileWithDesktopCommander({ workspaceId: plain.workspaceId, path: 'page.txt', offset: 2, maxLines: 2, maxBytes: 1024 }, registry, child);
  assert.equal(primaryRange.offset, 2);
  assert.equal(primaryRange.content, 'two\nthree');
  assert.equal(primaryRange.sha256, null);
  const secondaryRange = await readFileWithDesktopCommander({ workspaceId: granted.workspaceId, path: path.join(secondary, 'granted.txt'), offset: 1, maxLines: 2, maxBytes: 1024, secondaryReadGrants: registry.getSecondaryReadGrants(granted.workspaceId) }, registry, child);
  assert.equal(secondaryRange.content, 's1\ns2');
  assert.equal(calls[1].path, fs.realpathSync.native(path.join(primary, 'page.txt')));
  assert.equal(calls[2].path, fs.realpathSync.native(path.join(secondary, 'granted.txt')));
});

test('multi-file validates every target before one child dispatch and fails closed on mixed authority/special format', async () => {
  const { primary, secondary, sibling, registry, granted } = setup();
  const calls = [];
  const child = {
    readMultipleFiles: async ({ paths }) => {
      calls.push(paths);
      return paths.map((p) => `--- ${p} contents: ---\n[Reading 1 lines]\n\n${fs.readFileSync(p, 'utf8')}`).join('\n');
    },
  };
  const ok = await readMultipleFilesWithDesktopCommander({
    workspaceId: granted.workspaceId,
    paths: ['page.txt', path.join(secondary, 'granted.txt')],
    maxBytes: 1024,
    secondaryReadGrants: registry.getSecondaryReadGrants(granted.workspaceId),
  }, registry, child);
  assert.equal(ok.files.length, 2);
  assert.match(ok.files[0].content, /zero/);
  assert.match(ok.files[1].content, /s0/);
  assert.equal(calls.length, 1);

  await assert.rejects(() => readMultipleFilesWithDesktopCommander({
    workspaceId: granted.workspaceId,
    paths: ['page.txt', path.join(sibling, 'blocked.txt')],
    secondaryReadGrants: registry.getSecondaryReadGrants(granted.workspaceId),
  }, registry, child), /secondary read grant/);
  await assert.rejects(() => readMultipleFilesWithDesktopCommander({
    workspaceId: granted.workspaceId,
    paths: ['page.txt', path.join(secondary, 'crafted.pdf')],
    secondaryReadGrants: registry.getSecondaryReadGrants(granted.workspaceId),
  }, registry, child), /special-format read blocked/);
  assert.equal(calls.length, 1, 'mixed request must fail before dispatch and leak no partial child content');
  assert.equal(fs.existsSync(path.join(primary, 'page.txt')), true);
});

function listingChild() {
  return {
    listDirectory: async ({ path: root }) => {
      const lines = fs.readdirSync(root, { withFileTypes: true }).map((entry) => `[${entry.isDirectory() ? 'DIR' : 'FILE'}] ${entry.name}`);
      return { output: lines.join('\n'), truncated: false };
    },
  };
}

test('directory listing permits primary and exact secondary root, and blocks widening/traversal', async () => {
  const { secondary, sibling, registry, plain, granted } = setup();
  const child = listingChild();
  const primary = await listDirectoryWithDesktopCommander({ workspaceId: plain.workspaceId, path: 'dir', depth: 1 }, registry, child);
  assert.deepEqual(primary.entries.map((e) => e.path).sort(), ['dir/alpha.txt', 'dir/beta.log']);
  const external = await listDirectoryWithDesktopCommander({ workspaceId: granted.workspaceId, path: secondary, depth: 1, secondaryReadGrants: registry.getSecondaryReadGrants(granted.workspaceId) }, registry, child);
  assert.equal(external.entries.some((e) => e.path === fs.realpathSync.native(path.join(secondary, 'granted.txt'))), true);
  await assert.rejects(() => listDirectoryWithDesktopCommander({ workspaceId: plain.workspaceId, path: secondary }, registry, child), /exact secondary directory grant/);
  await assert.rejects(() => listDirectoryWithDesktopCommander({ workspaceId: granted.workspaceId, path: sibling, secondaryReadGrants: registry.getSecondaryReadGrants(granted.workspaceId) }, registry, child), /exact secondary directory grant/);
  await assert.rejects(() => listDirectoryWithDesktopCommander({ workspaceId: granted.workspaceId, path: path.join(secondary, '..', 'sibling'), secondaryReadGrants: registry.getSecondaryReadGrants(granted.workspaceId) }, registry, child), /exact secondary directory grant/);
});

test('directory listing rejects symlink/junction escape after child result revalidation', async (t) => {
  const { primary, sibling, registry, plain } = setup();
  const link = path.join(primary, 'dir', 'escape');
  try { fs.symlinkSync(sibling, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { t.skip('symlink/junction creation unavailable'); return; }
  await assert.rejects(
    () => listDirectoryWithDesktopCommander({ workspaceId: plain.workspaceId, path: 'dir' }, registry, listingChild()),
    /escaped authorized scope/,
  );
});

test('metadata returns safe exact-file fields and blocks unauthorized/special-format targets', async () => {
  const { secondary, sibling, registry, granted } = setup();
  let calls = 0;
  const child = {
    getFileInfo: async () => {
      calls += 1;
      return 'size: 24\ncreated: "2026-01-01T00:00:00.000Z"\nfileType: text\nlineCount: 5\nlastLine: 4\npermissions: 666';
    },
  };
  const info = await fileInfoWithDesktopCommander({ workspaceId: granted.workspaceId, path: 'page.txt' }, registry, child);
  assert.equal(info.type, 'file');
  assert.equal(info.fileType, 'text');
  assert.equal(info.lineCount, 5);
  assert.equal('permissions' in info, false);
  await assert.rejects(() => fileInfoWithDesktopCommander({ workspaceId: granted.workspaceId, path: path.join(sibling, 'blocked.txt'), secondaryReadGrants: registry.getSecondaryReadGrants(granted.workspaceId) }, registry, child), /secondary read grant/);
  await assert.rejects(() => fileInfoWithDesktopCommander({ workspaceId: granted.workspaceId, path: path.join(secondary, 'crafted.pdf'), secondaryReadGrants: registry.getSecondaryReadGrants(granted.workspaceId) }, registry, child), /special-format read blocked/);
  assert.equal(calls, 1);
});

function fileSearchChild(results) {
  return {
    startSearch: async () => 'Started file search session: f1\nStatus: RUNNING\nTotal results: 0',
    getMoreSearchResults: async () => `Search session: f1\nStatus: COMPLETED\nTotal results found: ${results.length}\nResults:\n${results.map((p) => `📁 ${p}`).join('\n')}\n✅ Search completed.`,
    stopSearch: async () => 'stopped',
  };
}

test('filename search succeeds in primary/exact grant and fails closed on sibling/traversal/result escape', async () => {
  const { primary, secondary, sibling, registry, plain, granted } = setup();
  const primaryHit = path.join(primary, 'dir', 'alpha.txt');
  const externalHit = path.join(secondary, 'granted.txt');
  const p = await filenameSearchWithDesktopCommander({ workspaceId: plain.workspaceId, query: 'alpha', path: 'dir' }, registry, fileSearchChild([primaryHit]));
  assert.deepEqual(p.matches, ['dir/alpha.txt']);
  const e = await filenameSearchWithDesktopCommander({ workspaceId: granted.workspaceId, query: 'granted', path: secondary, secondaryReadGrants: registry.getSecondaryReadGrants(granted.workspaceId) }, registry, fileSearchChild([externalHit]));
  assert.deepEqual(e.matches, [fs.realpathSync.native(externalHit)]);
  await assert.rejects(() => filenameSearchWithDesktopCommander({ workspaceId: plain.workspaceId, query: 'x', path: secondary }, registry, fileSearchChild([])), /exact secondary directory grant/);
  await assert.rejects(() => filenameSearchWithDesktopCommander({ workspaceId: granted.workspaceId, query: 'x', path: path.join(secondary, '..', 'sibling'), secondaryReadGrants: registry.getSecondaryReadGrants(granted.workspaceId) }, registry, fileSearchChild([])), /exact secondary directory grant/);
  await assert.rejects(() => filenameSearchWithDesktopCommander({ workspaceId: granted.workspaceId, query: 'x', path: secondary, secondaryReadGrants: registry.getSecondaryReadGrants(granted.workspaceId) }, registry, fileSearchChild([path.join(sibling, 'blocked.txt')])), /escaped authorized scope/);
});

test('filename search polls empty in-progress pages before returning later results', async () => {
  const { primary, registry, plain } = setup();
  const primaryHit = path.join(primary, 'dir', 'alpha.txt');
  const events = [];
  let getMoreCalls = 0;
  const child = {
    startSearch: async () => {
      events.push('start');
      return 'Started file search session: f1\nStatus: RUNNING\nTotal results: 0';
    },
    getMoreSearchResults: async ({ sessionId, offset }) => {
      events.push(`getMore:${sessionId}:${offset}`);
      getMoreCalls += 1;
      if (getMoreCalls === 1) return 'Search session: f1\nStatus: IN PROGRESS\nTotal results: 0';
      return `Search session: f1\nStatus: COMPLETED\nTotal results found: 1\nResults:\n📁 ${primaryHit}\n✅ Search completed.`;
    },
    stopSearch: async ({ sessionId }) => {
      events.push(`stop:${sessionId}`);
      return 'stopped';
    },
  };
  const startedAt = Date.now();
  const result = await filenameSearchWithDesktopCommander({ workspaceId: plain.workspaceId, query: 'alpha', path: 'dir' }, registry, child);
  const elapsed = Date.now() - startedAt;
  assert.deepEqual(result.matches, ['dir/alpha.txt']);
  assert.equal(getMoreCalls, 2);
  assert.deepEqual(events, ['start', 'getMore:f1:0', 'getMore:f1:0', 'stop:f1']);
  assert.ok(elapsed >= 45 && elapsed < 2000, `expected bounded polling delay, got ${elapsed}ms`);
});

test('real pinned 0.2.51 child executes new read-only filesystem primitives', async () => {
  const { secondary, registry, granted } = setup();
  const child = new DesktopCommanderChild();
  try {
    const ranged = await readFileWithDesktopCommander({ workspaceId: granted.workspaceId, path: 'page.txt', offset: 1, maxLines: 2, maxBytes: 1024 }, registry, child);
    assert.match(ranged.content, /^one\ntwo/);

    const multi = await readMultipleFilesWithDesktopCommander({
      workspaceId: granted.workspaceId,
      paths: ['page.txt', path.join(secondary, 'granted.txt')],
      maxBytes: 2048,
      secondaryReadGrants: registry.getSecondaryReadGrants(granted.workspaceId),
    }, registry, child);
    assert.equal(multi.files.length, 2);

    const listed = await listDirectoryWithDesktopCommander({ workspaceId: granted.workspaceId, path: 'dir', depth: 1 }, registry, child);
    assert.equal(listed.entries.some((e) => e.path === 'dir/alpha.txt'), true);

    const info = await fileInfoWithDesktopCommander({ workspaceId: granted.workspaceId, path: 'page.txt' }, registry, child);
    assert.equal(info.type, 'file');
    assert.equal(info.fileType, 'text');

    const searched = await filenameSearchWithDesktopCommander({ workspaceId: granted.workspaceId, query: 'alpha', path: 'dir', maxResults: 10 }, registry, child);
    assert.equal(searched.matches.some((p) => p === 'dir/alpha.txt'), true);
  } finally {
    await child.close();
  }
});

test('Outcome Preservation Fence is policy-only and does not enter Governance runtime/schema', () => {
  const policy = fs.readFileSync(new URL('../../CAPABILITY_ROUTING.md', import.meta.url), 'utf8');
  assert.match(policy, /Outcome Preservation Fence/);
  for (const disposition of ['DELIVERED', 'ROUTED_ELSEWHERE_WITH_EQUIVALENT_OUTCOME', 'DEFERRED', 'REJECTED_WITH_MATERIAL_REASON', 'SUPERSEDED_BY_HUMAN_DECISION']) {
    assert.match(policy, new RegExp(disposition));
  }
  const governanceDir = new URL('../../src/governance/', import.meta.url);
  for (const name of fs.readdirSync(governanceDir).filter((n) => n.endsWith('.js'))) {
    const source = fs.readFileSync(new URL(name, governanceDir), 'utf8');
    assert.doesNotMatch(source, /Outcome Preservation Fence|ROUTED_ELSEWHERE_WITH_EQUIVALENT_OUTCOME/);
  }
});
