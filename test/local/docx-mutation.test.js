import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DocxFileHandler } from '@wonderwhy-er/desktop-commander/dist/utils/files/docx.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { MutationOwner } from '../../src/state/mutation-owner.js';
import { DocxMutationService } from '../../src/local/docx-mutation.js';

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixture() {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'issue137-docx-'));
  const primary = path.join(host, 'primary');
  const outside = path.join(host, 'outside');
  fs.mkdirSync(primary);
  fs.mkdirSync(outside);
  const registry = new WorkspaceRegistry({ allowedRoots: [host] });
  const workspace = registry.open({ path: primary, secondaryReadGrants: [outside] });
  return { host, primary, outside, registry, workspace };
}

function exactChild({ failEdit = false, failWrite = false } = {}) {
  const handler = new DocxFileHandler();
  return {
    async writeFile({ path: filePath, content, mode }) {
      if (failWrite) throw new Error('provider write failed');
      await handler.write(filePath, content, mode);
      return 'ok';
    },
    async editBlock({ filePath, oldString, newString, expectedReplacements }) {
      if (failEdit) throw new Error('provider edit failed');
      const out = await handler.editRange(filePath, '', {
        old_string: oldString,
        new_string: newString,
        expected_replacements: expectedReplacements,
      });
      if (!out.success) throw new Error(out.errors?.[0]?.error || 'provider edit failed');
      return 'ok';
    },
    async readFileStructured({ path: filePath, offset = 0, maxLines = 10000 }) {
      const out = await handler.read(filePath, { offset, length: maxLines });
      return { content: [{ type: 'text', text: out.content }] };
    },
  };
}

async function makeDocx(file, text) {
  await new DocxFileHandler().write(file, text, 'rewrite');
}

test('Issue #137 DOCX edit replaces visible text safely and preserves XML escaping', async () => {
  const f = fixture();
  const file = path.join(f.primary, 'doc.docx');
  await makeDocx(file, 'Hello & world\nSecond line\nHello & world');
  const owner = new MutationOwner();
  const service = new DocxMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: exactChild() });
  const base = hashFile(file);
  const result = await service.editText({
    workspaceId: f.workspace.workspaceId,
    path: 'doc.docx',
    find: 'Hello & world',
    replace: 'A < B & "quoted"',
    expectedOccurrences: 2,
    expectedBaseSha256: base,
  });
  assert.equal(result.provider, 'desktop-commander-0.2.51');
  assert.equal(owner.owner, 'none');
  const outline = await new DocxFileHandler().read(file, {});
  assert.match(outline.content, /Second line/u);
  assert.doesNotMatch(outline.content, /Hello &amp; world/u);
  const raw = await new DocxFileHandler().read(file, { offset: 1, length: 10000 });
  assert.match(raw.content, /A &lt; B &amp; &quot;quoted&quot;/u);
});

test('Issue #137 DOCX edit enforces expected occurrence, stale hash, and primary-only path', async () => {
  const f = fixture();
  const file = path.join(f.primary, 'doc.docx');
  await makeDocx(file, 'One\nOne');
  const owner = new MutationOwner();
  const child = exactChild();
  const service = new DocxMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: child });
  const base = hashFile(file);
  await assert.rejects(() => service.editText({
    workspaceId: f.workspace.workspaceId, path: 'doc.docx', find: 'One', replace: 'Two', expectedOccurrences: 1, expectedBaseSha256: base,
  }), /expected 1 visible occurrence/u);
  await assert.rejects(() => service.editText({
    workspaceId: f.workspace.workspaceId, path: 'doc.docx', find: 'One', replace: 'Two', expectedOccurrences: 2, expectedBaseSha256: '0'.repeat(64),
  }), /stale/u);
  await assert.rejects(() => service.editText({
    workspaceId: f.workspace.workspaceId, path: path.join(f.outside, 'doc.docx'), find: 'One', replace: 'Two', expectedOccurrences: 2, expectedBaseSha256: base,
  }), /relative/u);
  assert.equal(owner.owner, 'none');
});

test('Issue #137 DOCX provider failure on temp leaves original unchanged and releases owner', async () => {
  const f = fixture();
  const file = path.join(f.primary, 'doc.docx');
  await makeDocx(file, 'Before');
  const base = hashFile(file);
  const owner = new MutationOwner();
  const service = new DocxMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: exactChild({ failEdit: true }) });
  await assert.rejects(() => service.editText({
    workspaceId: f.workspace.workspaceId, path: 'doc.docx', find: 'Before', replace: 'After', expectedBaseSha256: base,
  }), /provider edit failed/u);
  assert.equal(hashFile(file), base);
  assert.equal(owner.owner, 'none');
});

test('Issue #137 DOCX create uses exact child, headings, escaping, and atomic target creation', async () => {
  const f = fixture();
  const owner = new MutationOwner();
  const service = new DocxMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: exactChild() });
  const result = await service.createText({
    workspaceId: f.workspace.workspaceId,
    path: 'created.docx',
    text: '# Heading & More\nBody <safe>\n\n## Sub',
  });
  assert.equal(result.status, 'applied');
  assert.equal(owner.owner, 'none');
  const outline = await new DocxFileHandler().read(path.join(f.primary, 'created.docx'), {});
  assert.match(outline.content, /style="Heading1"/u);
  assert.match(outline.content, /Heading &amp; More/u);
  assert.match(outline.content, /Body &lt;safe&gt;/u);
  assert.match(outline.content, /Sub/u);
  await assert.rejects(() => service.createText({
    workspaceId: f.workspace.workspaceId, path: 'created.docx', text: 'again',
  }), /already exists/u);
});

test('Issue #137 DOCX create provider failure leaves no final or temp artifact', async () => {
  const f = fixture();
  const owner = new MutationOwner();
  const service = new DocxMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: exactChild({ failWrite: true }) });
  await assert.rejects(() => service.createText({
    workspaceId: f.workspace.workspaceId, path: 'fail.docx', text: 'content',
  }), /provider write failed/u);
  assert.equal(fs.existsSync(path.join(f.primary, 'fail.docx')), false);
  assert.equal(fs.readdirSync(f.primary).some((name) => name.startsWith('.docx-create-')), false);
  assert.equal(owner.owner, 'none');
});
