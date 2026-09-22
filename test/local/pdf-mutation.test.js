import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PdfFileHandler } from '@wonderwhy-er/desktop-commander/dist/utils/files/pdf.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { MutationOwner } from '../../src/state/mutation-owner.js';
import { PdfMutationService } from '../../src/local/pdf-mutation.js';

const require = createRequire(import.meta.url);
const { PDFDocument } = require('pdf-lib');

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixture({ secondary = false } = {}) {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'issue137-pdf-'));
  const primary = path.join(host, 'primary');
  const outside = path.join(host, 'outside');
  fs.mkdirSync(primary);
  fs.mkdirSync(outside);
  const registry = new WorkspaceRegistry({ allowedRoots: [host] });
  const workspace = registry.open({ path: primary, secondaryReadGrants: secondary ? [outside] : [] });
  return { host, primary, outside, registry, workspace };
}

async function makePdf(file, pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200 + i, 200 + i]);
  fs.writeFileSync(file, Buffer.from(await doc.save()));
}

function exactChild({ failWrite = false, failReadAfter = null } = {}) {
  const handler = new PdfFileHandler();
  let readCount = 0;
  return {
    async writePdf({ path: filePath, operations, outputPath }) {
      if (failWrite) throw new Error('provider PDF write failed');
      const result = await handler.editRange(filePath, '', operations, { outputPath });
      if (!result?.success) throw new Error(result?.errors?.[0]?.error || 'provider PDF write failed');
      return 'ok';
    },
    async readFileStructured({ path: filePath, offset = 0, maxLines = 32 }) {
      readCount += 1;
      if (failReadAfter !== null && readCount > failReadAfter) throw new Error('provider PDF read failed');
      const out = await handler.read(filePath, { offset, length: maxLines });
      const content = [];
      for (const page of out.metadata?.pages || []) {
        content.push({ type: 'text', text: '<!-- Page: ' + page.pageNumber + ' -->\n' + (page.text || '') });
      }
      return { content };
    },
  };
}

test('Issue #137 PDF deletes and inserts pages with 1-based public semantics', async () => {
  const f = fixture();
  const dest = path.join(f.primary, 'dest.pdf');
  const source = path.join(f.primary, 'source.pdf');
  await makePdf(dest, 3);
  await makePdf(source, 2);
  const owner = new MutationOwner();
  const service = new PdfMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: exactChild() });
  const result = await service.mutatePages({
    workspaceId: f.workspace.workspaceId,
    path: 'dest.pdf',
    expectedBaseSha256: hashFile(dest),
    operations: [
      { type: 'delete_pages', pages: [2] },
      { type: 'insert_pdf', atPage: 2, sourcePath: 'source.pdf' },
    ],
  });
  assert.equal(result.provider, 'desktop-commander-0.2.51');
  assert.equal(result.pageCount, 4);
  assert.equal(owner.owner, 'none');
});

test('Issue #137 PDF accepts an explicitly granted secondary read source but never a secondary destination', async () => {
  const f = fixture({ secondary: true });
  const dest = path.join(f.primary, 'dest.pdf');
  const source = path.join(f.outside, 'source.pdf');
  await makePdf(dest, 1);
  await makePdf(source, 1);
  const owner = new MutationOwner();
  const service = new PdfMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: exactChild() });
  const result = await service.mutatePages({
    workspaceId: f.workspace.workspaceId,
    path: 'dest.pdf',
    expectedBaseSha256: hashFile(dest),
    operations: [{ type: 'insert_pdf', atPage: 2, sourcePath: source }],
  });
  assert.equal(result.pageCount, 2);
  await assert.rejects(() => service.mutatePages({
    workspaceId: f.workspace.workspaceId,
    path: source,
    expectedBaseSha256: hashFile(source),
    operations: [{ type: 'delete_pages', pages: [1] }],
  }), /primary workspace/u);
});

test('Issue #137 PDF rejects markdown/browser create semantics and invalid page operations', async () => {
  const f = fixture();
  const dest = path.join(f.primary, 'dest.pdf');
  await makePdf(dest, 2);
  const service = new PdfMutationService({ workspaceRegistry: f.registry, mutationOwner: new MutationOwner(), desktopCommanderChild: exactChild() });
  const base = hashFile(dest);
  await assert.rejects(() => service.mutatePages({
    workspaceId: f.workspace.workspaceId, path: 'dest.pdf', expectedBaseSha256: base,
    operations: [{ type: 'insert', pageIndex: 0, markdown: '# nope' }],
  }), /delete_pages or insert_pdf/u);
  await assert.rejects(() => service.mutatePages({
    workspaceId: f.workspace.workspaceId, path: 'dest.pdf', expectedBaseSha256: base,
    operations: [{ type: 'delete_pages', pages: [3] }],
  }), /1-based pages/u);
  await assert.rejects(() => service.mutatePages({
    workspaceId: f.workspace.workspaceId, path: 'dest.pdf', expectedBaseSha256: base,
    operations: [{ type: 'delete_pages', pages: [1, 2] }],
  }), /delete every page/u);
});

test('Issue #137 PDF stale hash and provider failure leave original intact and release owner before replace', async () => {
  const f = fixture();
  const dest = path.join(f.primary, 'dest.pdf');
  await makePdf(dest, 2);
  const base = hashFile(dest);
  const owner = new MutationOwner();
  const service = new PdfMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: exactChild({ failWrite: true }) });
  await assert.rejects(() => service.mutatePages({
    workspaceId: f.workspace.workspaceId, path: 'dest.pdf', expectedBaseSha256: '0'.repeat(64),
    operations: [{ type: 'delete_pages', pages: [1] }],
  }), /stale/u);
  await assert.rejects(() => service.mutatePages({
    workspaceId: f.workspace.workspaceId, path: 'dest.pdf', expectedBaseSha256: base,
    operations: [{ type: 'delete_pages', pages: [1] }],
  }), /provider PDF write failed/u);
  assert.equal(hashFile(dest), base);
  assert.equal(owner.owner, 'none');
  assert.equal(fs.readdirSync(f.primary).some((name) => name.startsWith('.pdf-')), false);
});
