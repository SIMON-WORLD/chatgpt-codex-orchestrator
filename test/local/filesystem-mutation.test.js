import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { MutationOwner } from '../../src/state/mutation-owner.js';
import { OperationState } from '../../src/state/operation-state.js';
import { ChangeSetService, computeSha256 } from '../../src/local/change-set.js';
import { FilesystemMutationService } from '../../src/local/filesystem-mutation.js';
import { startMcpServer } from '../../src/mcp/server.js';

function fixture(prefix = 'issue137-fs-') {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const primary = path.join(host, 'primary');
  const outside = path.join(host, 'outside');
  fs.mkdirSync(primary);
  fs.mkdirSync(outside);
  const registry = new WorkspaceRegistry({ allowedRoots: [host] });
  const workspace = registry.open({ path: primary, secondaryReadGrants: [outside] });
  return { host, primary, outside, registry, workspace };
}

function fakeChild({ failCreate = false } = {}) {
  const calls = [];
  return {
    calls,
    async createDirectory({ path: target }) {
      calls.push(['createDirectory', target]);
      if (failCreate) throw new Error('child create failed');
      fs.mkdirSync(target, { recursive: true });
      return 'Successfully created directory';
    },
    async moveFile({ source, destination }) {
      calls.push(['moveFile', source, destination]);
      fs.renameSync(source, destination);
      return 'Successfully moved';
    },
    async writeFile({ path: target, content }) {
      calls.push(['writeFile', target, content]);
      fs.writeFileSync(target, content, 'utf8');
      return 'Successfully wrote file';
    },
  };
}

test('Issue #137 filesystem service creates nested directories and moves files/directories with exact readback', async () => {
  const f = fixture();
  const owner = new MutationOwner();
  const child = fakeChild();
  const service = new FilesystemMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: child });

  const created = await service.createDirectory({ workspaceId: f.workspace.workspaceId, path: 'created/nested' });
  assert.deepEqual(created, { operation: 'create_directory', path: 'created/nested', status: 'applied' });
  assert.equal(fs.statSync(path.join(f.primary, 'created', 'nested')).isDirectory(), true);
  assert.equal(owner.owner, 'none');

  fs.writeFileSync(path.join(f.primary, 'source.txt'), 'filesystem mutation\n', 'utf8');
  const movedFile = await service.movePath({ workspaceId: f.workspace.workspaceId, source: 'source.txt', destination: 'created/nested/moved.txt' });
  assert.equal(movedFile.status, 'applied');
  assert.equal(fs.existsSync(path.join(f.primary, 'source.txt')), false);
  assert.equal(fs.readFileSync(path.join(f.primary, 'created', 'nested', 'moved.txt'), 'utf8'), 'filesystem mutation\n');

  fs.mkdirSync(path.join(f.primary, 'source-dir'));
  fs.writeFileSync(path.join(f.primary, 'source-dir', 'child.txt'), 'dir\n', 'utf8');
  await service.movePath({ workspaceId: f.workspace.workspaceId, source: 'source-dir', destination: 'created/moved-dir' });
  assert.equal(fs.readFileSync(path.join(f.primary, 'created', 'moved-dir', 'child.txt'), 'utf8'), 'dir\n');
  assert.equal(child.calls.filter(([name]) => name === 'createDirectory').length, 1);
  assert.equal(child.calls.filter(([name]) => name === 'moveFile').length, 2);
  assert.equal(owner.owner, 'none');
});

test('Issue #137 filesystem mutation fails closed for traversal, secondary/cross-root, collisions, types, and directory descendants', async () => {
  const f = fixture();
  const owner = new MutationOwner();
  const child = fakeChild();
  const service = new FilesystemMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: child });
  fs.writeFileSync(path.join(f.primary, 'file'), 'x', 'utf8');
  fs.mkdirSync(path.join(f.primary, 'dir'));
  fs.mkdirSync(path.join(f.primary, 'dir', 'inside'));
  fs.writeFileSync(path.join(f.primary, 'parent-file'), 'x', 'utf8');

  await assert.rejects(() => service.createDirectory({ workspaceId: f.workspace.workspaceId, path: '../escape' }), /traversal|escapes/u);
  await assert.rejects(() => service.createDirectory({ workspaceId: f.workspace.workspaceId, path: path.join(f.outside, 'secondary-write') }), /relative path/u);
  await assert.rejects(() => service.movePath({ workspaceId: f.workspace.workspaceId, source: path.join(f.outside, 'x'), destination: 'x' }), /relative path/u);
  await assert.rejects(() => service.createDirectory({ workspaceId: f.workspace.workspaceId, path: 'dir' }), /already exists/u);
  await assert.rejects(() => service.movePath({ workspaceId: f.workspace.workspaceId, source: 'file', destination: 'dir' }), /already exists/u);
  await assert.rejects(() => service.createDirectory({ workspaceId: f.workspace.workspaceId, path: 'parent-file/child' }), /parent/u);
  await assert.rejects(() => service.movePath({ workspaceId: f.workspace.workspaceId, source: 'dir', destination: 'dir/inside/subdir' }), /itself|descendant/u);

  const link = path.join(f.primary, 'link');
  try {
    fs.symlinkSync(f.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    // Symlink creation may be unavailable on a restricted Windows runner.
  }
  if (fs.existsSync(link)) {
    await assert.rejects(() => service.createDirectory({ workspaceId: f.workspace.workspaceId, path: 'link/new' }), /symlink|junction/u);
    await assert.rejects(() => service.movePath({ workspaceId: f.workspace.workspaceId, source: 'link', destination: 'link-moved' }), /symlink|junction/u);
  }
  assert.equal(child.calls.length, 0, 'all rejected requests must fail before child dispatch');
});

test('Issue #137 filesystem mutation preserves MutationOwner fail-closed lifecycle', async () => {
  const f = fixture();
  const owner = new MutationOwner();
  const child = fakeChild({ failCreate: true });
  const service = new FilesystemMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: child });

  await assert.rejects(() => service.createDirectory({ workspaceId: f.workspace.workspaceId, path: 'failed' }), /child create failed/u);
  assert.equal(owner.owner, 'chatgpt');
  assert.equal(owner.unitState, 'unknown');
  owner.markUnitState('reconciled');
  owner.release();

  owner.acquire('codex', 'codex-unit');
  await assert.rejects(() => service.createDirectory({ workspaceId: f.workspace.workspaceId, path: 'blocked' }), /already owned by codex/u);
  assert.equal(child.calls.length, 1);
  owner.markUnitState('reconciled');
  owner.release();
});

test('Issue #137 existing bounded edit keeps atomic parent apply, base-hash, mode, and readback protections', async () => {
  const f = fixture();
  const target = path.join(f.primary, 'note.txt');
  fs.writeFileSync(target, 'hello world', 'utf8');
  const owner = new MutationOwner();
  const ops = new OperationState({ dataRoot: f.host });
  const child = fakeChild();
  const changeSet = new ChangeSetService({ workspaceRegistry: f.registry, operationState: ops, mutationOwner: owner });

  const baseHash = computeSha256(Buffer.from('hello world', 'utf8'));
  const preview = await changeSet.preview({
    workspaceId: f.workspace.workspaceId,
    change: { path: 'note.txt', baseHash, replacements: [{ oldText: 'world', newText: 'there', expectedOccurrences: 1 }] },
  });
  const applied = await changeSet.apply({ workspaceId: f.workspace.workspaceId, changeSetId: preview.changeSetId });
  assert.equal(applied.status, 'applied');
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello there');
  assert.equal(child.calls.some(([name]) => name === 'writeFile'), false, 'ordinary ChangeSet edits must not route through non-atomic child.writeFile');
  assert.equal(fs.readdirSync(f.primary).some((name) => name.startsWith('.edit-')), false, 'atomic temp file must be renamed and cleaned');
  assert.equal(owner.owner, 'none');

  const stalePreview = await changeSet.preview({
    workspaceId: f.workspace.workspaceId,
    change: { path: 'note.txt', baseHash: applied.resultHash, replacements: [{ oldText: 'there', newText: 'stale', expectedOccurrences: 1 }] },
  });
  fs.writeFileSync(target, 'concurrent change', 'utf8');
  await assert.rejects(() => changeSet.apply({ workspaceId: f.workspace.workspaceId, changeSetId: stalePreview.changeSetId }), /stale/u);
  assert.equal(fs.readFileSync(target, 'utf8'), 'concurrent change');
  assert.equal(owner.owner, 'none');
});

test('Issue #137 MCP exposes typed filesystem tools, enforces Governance, and exposes no child mutation tool', async (t) => {
  const f = fixture();
  const owner = new MutationOwner();
  const ops = new OperationState({ dataRoot: f.host });
  const child = fakeChild();
  const governance = {
    authorizeMutation({ authorityToken }) {
      if (authorityToken !== 'approved') throw new Error('authority required');
      return { taskId: 'issue-137' };
    },
  };
  const server = await startMcpServer({
    workspaceRegistry: f.registry,
    mutationOwner: owner,
    operationState: ops,
    governanceService: governance,
    desktopCommanderChild: child,
    host: '127.0.0.1',
    port: 0,
  });
  t.after(() => server.close());
  const client = new Client({ name: 'issue137-filesystem', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(server.url));
  t.after(() => client.close());
  const textOf = (result) => result.content.find((item) => item.type === 'text').text;

  const opened = JSON.parse(textOf(await client.callTool({ name: 'workspace_open', arguments: { path: f.primary } })));
  const workspaceId = opened.workspaceId;
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  assert.equal(names.has('filesystem_create_directory'), true);
  assert.equal(names.has('filesystem_move'), true);
  for (const typedMutation of ['excel_write_range', 'docx_edit_text', 'docx_create_text', 'pdf_mutate_pages']) {
    assert.equal(names.has(typedMutation), true);
  }
  assert.equal(names.has('edit'), true);
  for (const forbidden of ['write_file', 'edit_block', 'write_pdf', 'create_directory', 'move_file', 'callTool', 'start_process']) assert.equal(names.has(forbidden), false);

  const unauthorizedRequests = [
    { name: 'excel_write_range', arguments: { workspaceId, path: 'book.xlsx', range: 'Sheet1!A1', values: [[1]], expectedBaseSha256: '0'.repeat(64) } },
    { name: 'docx_edit_text', arguments: { workspaceId, path: 'book.docx', find: 'before', replace: 'after', expectedOccurrences: 1, expectedBaseSha256: '0'.repeat(64) } },
    { name: 'docx_create_text', arguments: { workspaceId, path: 'book.docx', text: 'content' } },
    { name: 'pdf_mutate_pages', arguments: { workspaceId, path: 'book.pdf', operations: [{ type: 'delete_pages', pages: [1] }], expectedBaseSha256: '0'.repeat(64) } },
  ];
  for (const request of unauthorizedRequests) {
    const rejected = await client.callTool(request);
    assert.equal(rejected.isError, true);
    assert.match(textOf(rejected), /authority required/u);
  }
  assert.equal(child.calls.length, 0, 'Direct Local auth must run before every typed mutation service');

  const rejected = await client.callTool({ name: 'filesystem_create_directory', arguments: { workspaceId, path: 'new-dir' } });
  assert.equal(rejected.isError, true);
  assert.equal(child.calls.length, 0);

  const created = await client.callTool({ name: 'filesystem_create_directory', arguments: { workspaceId, path: 'new-dir', authorityToken: 'approved' } });
  assert.equal(JSON.parse(textOf(created)).status, 'applied');
  fs.writeFileSync(path.join(f.primary, 'source.txt'), 'source', 'utf8');
  const moved = await client.callTool({ name: 'filesystem_move', arguments: { workspaceId, source: 'source.txt', destination: 'new-dir/moved.txt', authorityToken: 'approved' } });
  assert.equal(JSON.parse(textOf(moved)).status, 'applied');

  const note = path.join(f.primary, 'note.txt');
  fs.writeFileSync(note, 'before', 'utf8');
  const preview = JSON.parse(textOf(await client.callTool({
    name: 'edit',
    arguments: { workspaceId, mode: 'preview', change: { path: 'note.txt', baseHash: computeSha256(Buffer.from('before')), replacements: [{ oldText: 'before', newText: 'after', expectedOccurrences: 1 }] } },
  })));
  const editRejected = await client.callTool({ name: 'edit', arguments: { workspaceId, mode: 'apply', changeSetId: preview.changeSetId } });
  assert.equal(editRejected.isError, true);
  const editApplied = await client.callTool({ name: 'edit', arguments: { workspaceId, mode: 'apply', changeSetId: preview.changeSetId, authorityToken: 'approved' } });
  assert.equal(JSON.parse(textOf(editApplied)).status, 'applied');
  assert.equal(fs.readFileSync(note, 'utf8'), 'after');
});
