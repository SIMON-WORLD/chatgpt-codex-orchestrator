import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadV02Config } from '../../src/config.js';
import { validateRead } from '../../src/local/read.js';
import { WorkspaceError, WorkspaceRegistry } from '../../src/local/workspace.js';
import { ProcessService } from '../../src/local/process.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-scope-'));
  const selected = path.join(root, 'selected');
  const other = path.join(root, 'other');
  fs.mkdirSync(selected, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(selected, 'safe.txt'), 'selected\n', 'utf8');
  fs.writeFileSync(path.join(other, 'safe.txt'), 'other\n', 'utf8');
  fs.writeFileSync(path.join(other, '.env'), 'TOKEN=not-for-read\n', 'utf8');
  return { root, selected, other };
}

test('legacy config and selected_roots preserve workspaceRoots without auto-widening', () => {
  const f = fixture();
  const legacy = loadV02Config({ workspaceRoots: [f.selected] });
  assert.equal(legacy.filesystemScope, 'selected_roots');
  assert.deepEqual(legacy.workspaceRoots, [path.resolve(f.selected)]);

  const registry = new WorkspaceRegistry({ allowedRoots: [f.selected] });
  assert.throws(() => registry.open({ path: f.other }), WorkspaceError);
  assert.deepEqual(registry.allowedRoots, [path.resolve(f.selected)]);
});

test('os_user_scope opens multiple explicit canonical locations without injecting drive roots', () => {
  const f = fixture();
  const registry = new WorkspaceRegistry({ allowedRoots: [], filesystemScope: 'os_user_scope' });
  assert.deepEqual(registry.allowedRoots, []);

  const first = registry.open({ path: f.selected });
  const second = registry.open({ path: f.other });
  assert.notEqual(first.workspaceId, second.workspaceId);
  assert.equal(first.filesystemScope, 'os_user_scope');
  assert.equal(second.root, fs.realpathSync.native(f.other));
  assert.equal(registry.hasAllowedRoots, true);
});

test('Windows path normalization keeps selected-root comparisons case-insensitive', () => {
  if (process.platform !== 'win32') return;
  const f = fixture();
  const registry = new WorkspaceRegistry({ allowedRoots: [f.selected.toUpperCase()] });
  const opened = registry.open({ path: f.selected.toLowerCase() });
  assert.equal(opened.root.toLowerCase(), fs.realpathSync.native(f.selected).toLowerCase());
});

test('os_user_scope preserves relative symlink containment and allows explicit absolute typed reads/searches', (t) => {
  const f = fixture();
  const link = path.join(f.selected, 'outside-link');
  try { fs.symlinkSync(f.other, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.skip('symlink/junction not permitted: ' + error.message); return; }

  const selected = new WorkspaceRegistry({ allowedRoots: [f.selected] });
  const selectedWorkspace = selected.open({ path: f.selected });
  assert.throws(() => validateRead({ workspaceId: selectedWorkspace.workspaceId, path: 'outside-link/safe.txt' }, selected), WorkspaceError);

  const osUser = new WorkspaceRegistry({ filesystemScope: 'os_user_scope' });
  const osWorkspace = osUser.open({ path: f.selected });
  assert.throws(() => osUser.resolve(osWorkspace.workspaceId, 'outside-link/safe.txt'), /symlink escapes workspace/);

  const absoluteRead = validateRead({ workspaceId: osWorkspace.workspaceId, path: path.join(f.other, 'safe.txt') }, osUser);
  assert.equal(absoluteRead.canonical, fs.realpathSync.native(path.join(f.other, 'safe.txt')));
  assert.equal(absoluteRead.relPath, absoluteRead.canonical);
  assert.throws(() => validateRead({ workspaceId: osWorkspace.workspaceId, path: path.join(f.other, '.env') }, osUser), WorkspaceError);

  const absoluteSearch = osUser.resolveSearchScope(osWorkspace.workspaceId, f.other);
  assert.equal(absoluteSearch.external, true);
  assert.equal(absoluteSearch.root, fs.realpathSync.native(f.other));
});

test('workspaceId is required for path resolution in both filesystem policies', () => {
  const f = fixture();
  for (const registry of [
    new WorkspaceRegistry({ allowedRoots: [f.selected] }),
    new WorkspaceRegistry({ filesystemScope: 'os_user_scope' }),
  ]) {
    assert.throws(() => registry.resolve(undefined, path.join(f.selected, 'safe.txt')), WorkspaceError);
  }
});

test('os_user_scope keeps process startup bound to the explicitly opened workspace', async () => {
  const f = fixture();
  const registry = new WorkspaceRegistry({ filesystemScope: 'os_user_scope' });
  const opened = registry.open({ path: f.selected });
  const calls = [];
  const service = new ProcessService({
    workspaceRegistry: registry,
    platform: 'linux',
    desktopCommanderChild: {
      startProcess: async (args) => { calls.push(args); return { pid: 1234, status: 'running', output: '', exitCode: null, truncated: false }; },
      readProcessOutput: async () => ({ status: 'completed', output: '', exitCode: 0, truncated: false }),
      forceTerminate: async () => ({ terminated: true }),
    },
  });
  try {
    const result = await service.start({ workspaceId: opened.workspaceId, command: 'printf scoped' });
    assert.ok(result.processHandle);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, `cd '${opened.root}' && printf scoped`);
  } finally {
    await service.close();
  }
});

test('generic scope aliases do not override the explicit filesystemScope field', () => {
  const f = fixture();
  const cfg = loadV02Config({
    workspaceRoot: f.selected,
    scope: 'os_user_scope',
    filesystemScopePolicy: 'os_user_scope',
  });
  assert.equal(cfg.filesystemScope, 'selected_roots');
});
