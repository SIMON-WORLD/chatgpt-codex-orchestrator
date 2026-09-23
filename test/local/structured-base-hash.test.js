import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { PDFDocument, rgb } from 'pdf-lib';
import { ExcelFileHandler } from '@wonderwhy-er/desktop-commander/dist/utils/files/excel.js';
import { PdfFileHandler } from '@wonderwhy-er/desktop-commander/dist/utils/files/pdf.js';
import { DocxFileHandler } from '@wonderwhy-er/desktop-commander/dist/utils/files/docx.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { MutationOwner } from '../../src/state/mutation-owner.js';
import { ExcelMutationService } from '../../src/local/excel-mutation.js';
import { PdfMutationService } from '../../src/local/pdf-mutation.js';
import { DocxMutationService } from '../../src/local/docx-mutation.js';
import {
  readImageWithDesktopCommander,
  readExcelWithDesktopCommander,
  searchExcelWithDesktopCommander,
  readPdfWithDesktopCommander,
  readDocxWithDesktopCommander,
} from '../../src/local/structured-read.js';
import { DesktopCommanderChild } from '../../src/local/desktop-commander-child.js';
import { startMcpServer } from '../../src/mcp/server.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hashFile(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function grants(fixture) {
  return fixture.registry.getSecondaryReadGrants(fixture.workspace.workspaceId);
}

async function makePdf(file, labels = ['PDF marker', 'Second PDF marker']) {
  const pdf = await PDFDocument.create();
  for (const label of labels) {
    const page = pdf.addPage([300, 200]);
    page.drawText(label, { x: 20, y: 150, size: 18, color: rgb(0, 0, 0) });
  }
  fs.writeFileSync(file, Buffer.from(await pdf.save()));
}

async function makeFixture(prefix = 'issue156-base-hash-') {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const primary = path.join(host, 'primary');
  const external = path.join(host, 'external');
  fs.mkdirSync(primary);
  fs.mkdirSync(external);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');
  sheet.addRows([
    ['name', 'amount'],
    ['alpha marker', 3],
    ['beta', 7],
  ]);
  await workbook.xlsx.writeFile(path.join(primary, 'book.xlsx'));
  fs.copyFileSync(path.join(primary, 'book.xlsx'), path.join(primary, 'macro.xlsm'));
  fs.copyFileSync(path.join(primary, 'book.xlsx'), path.join(external, 'granted.xlsx'));

  await makePdf(path.join(primary, 'document.pdf'));
  fs.copyFileSync(path.join(primary, 'document.pdf'), path.join(external, 'granted.pdf'));

  const docxHandler = new DocxFileHandler();
  await docxHandler.write(path.join(primary, 'document.docx'), 'Hello DOCX\nSecond line', 'rewrite');
  fs.copyFileSync(path.join(primary, 'document.docx'), path.join(external, 'granted.docx'));

  fs.writeFileSync(path.join(primary, 'image.png'), PNG_1X1);

  const registry = new WorkspaceRegistry({ allowedRoots: [host] });
  const workspace = registry.open({ path: primary, secondaryReadGrants: [external] });
  return { host, primary, external, registry, workspace };
}

function providerChild() {
  const excel = new ExcelFileHandler();
  const pdf = new PdfFileHandler();
  const docx = new DocxFileHandler();
  return {
    async readFileStructured({ path: filePath, offset = 0, maxLines = 2000, sheet, range }) {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.xlsx' || ext === '.xlsm') {
        const out = await excel.read(filePath, { offset, length: maxLines, sheet, range });
        return { content: [{ type: 'text', text: out.content }] };
      }
      if (ext === '.pdf') {
        const out = await pdf.read(filePath, { offset, length: maxLines });
        return {
          content: (out.metadata?.pages || []).map((page) => ({
            type: 'text',
            text: '<!-- Page: ' + page.pageNumber + ' -->\n' + (page.text || ''),
          })),
        };
      }
      if (ext === '.docx') {
        const out = await docx.read(filePath, { offset, length: maxLines });
        return { content: [{ type: 'text', text: out.content }] };
      }
      throw new Error('unexpected provider extension ' + ext);
    },
    async editBlock({ filePath, range, content, oldString, newString, expectedReplacements }) {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.xlsx' || ext === '.xlsm') return excel.editRange(filePath, range, content);
      if (ext === '.docx') {
        const out = await docx.editRange(filePath, '', {
          old_string: oldString,
          new_string: newString,
          expected_replacements: expectedReplacements,
        });
        if (!out.success) throw new Error(out.errors?.[0]?.error || 'provider DOCX edit failed');
        return 'ok';
      }
      throw new Error('unexpected edit extension ' + ext);
    },
    async writePdf({ path: filePath, operations, outputPath }) {
      const out = await pdf.editRange(filePath, '', operations, { outputPath });
      if (!out?.success) throw new Error(out?.errors?.[0]?.error || 'provider PDF write failed');
      return 'ok';
    },
  };
}

function structuredResult(callResult) {
  if (callResult?.structuredContent) return callResult.structuredContent;
  const block = callResult?.content?.find((item) => item.type === 'text');
  return block ? JSON.parse(block.text) : null;
}


test('Issue #156 typed reads return exact whole-file hashes while image/search remain unbroadened', async () => {
  const fixture = await makeFixture();
  const child = new DesktopCommanderChild();
  const workspaceId = fixture.workspace.workspaceId;
  try {
    const xlsx = path.join(fixture.primary, 'book.xlsx');
    const xlsxHash = hashFile(xlsx);
    const metadata = await readExcelWithDesktopCommander({
      workspaceId,
      path: 'book.xlsx',
      mode: 'metadata',
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.equal(metadata.structuredContent.baseSha256, xlsxHash);
    assert.equal(metadata.structuredContent.size, fs.statSync(xlsx).size);

    const values = await readExcelWithDesktopCommander({
      workspaceId,
      path: 'book.xlsx',
      mode: 'values',
      sheet: 'Data',
      range: 'A1:B2',
      maxRows: 2,
      maxCells: 4,
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.equal(values.structuredContent.baseSha256, xlsxHash);

    const offsetValues = await readExcelWithDesktopCommander({
      workspaceId,
      path: 'book.xlsx',
      mode: 'values',
      sheet: 'Data',
      offset: 1,
      maxRows: 1,
      maxCells: 10,
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.equal(offsetValues.structuredContent.baseSha256, xlsxHash);

    const xlsm = path.join(fixture.primary, 'macro.xlsm');
    const xlsmHash = hashFile(xlsm);
    const xlsmMetadata = await readExcelWithDesktopCommander({
      workspaceId,
      path: 'macro.xlsm',
      mode: 'metadata',
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    const xlsmValues = await readExcelWithDesktopCommander({
      workspaceId,
      path: 'macro.xlsm',
      mode: 'values',
      sheet: 'Data',
      range: 'A1:B2',
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.equal(xlsmMetadata.structuredContent.baseSha256, xlsmHash);
    assert.equal(xlsmValues.structuredContent.baseSha256, xlsmHash);

    const pdf = path.join(fixture.primary, 'document.pdf');
    const pdfHash = hashFile(pdf);
    const partialPdf = await readPdfWithDesktopCommander({
      workspaceId,
      path: 'document.pdf',
      pageOffset: 1,
      pageCount: 1,
      includeImages: false,
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.equal(partialPdf.structuredContent.baseSha256, pdfHash);
    assert.match(partialPdf.structuredContent.pages[0].text, /Second PDF marker/iu);

    const docx = path.join(fixture.primary, 'document.docx');
    const docxHash = hashFile(docx);
    for (const mode of ['outline', 'info', 'xml']) {
      const result = await readDocxWithDesktopCommander({
        workspaceId,
        path: 'document.docx',
        mode,
        offset: mode === 'xml' ? 1 : undefined,
        secondaryReadGrants: grants(fixture),
      }, fixture.registry, child);
      assert.equal(result.structuredContent.baseSha256, docxHash);
      if (mode !== 'xml') assert.equal(result.structuredContent.compressedBytes, fs.statSync(docx).size);
    }

    for (const [name, reader] of [
      ['granted.xlsx', (sourcePath) => readExcelWithDesktopCommander({
        workspaceId, path: sourcePath, mode: 'metadata', secondaryReadGrants: grants(fixture),
      }, fixture.registry, child)],
      ['granted.pdf', (sourcePath) => readPdfWithDesktopCommander({
        workspaceId, path: sourcePath, pageCount: 1, includeImages: false, secondaryReadGrants: grants(fixture),
      }, fixture.registry, child)],
      ['granted.docx', (sourcePath) => readDocxWithDesktopCommander({
        workspaceId, path: sourcePath, mode: 'info', secondaryReadGrants: grants(fixture),
      }, fixture.registry, child)],
    ]) {
      const sourcePath = path.join(fixture.external, name);
      const result = await reader(sourcePath);
      assert.equal(result.structuredContent.baseSha256, hashFile(sourcePath));
    }

    const image = await readImageWithDesktopCommander({
      workspaceId,
      path: 'image.png',
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.equal(Object.hasOwn(image.structuredContent, 'baseSha256'), false);

    const search = await searchExcelWithDesktopCommander({
      workspaceId,
      path: 'book.xlsx',
      query: 'marker',
      maxResults: 10,
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.equal(Object.hasOwn(search.structuredContent, 'baseSha256'), false);
  } finally {
    await child.close();
  }
});


test('Issue #156 provider dispatch uses private extension-preserving snapshots and cleans them on success', async () => {
  const fixture = await makeFixture();
  const workspaceId = fixture.workspace.workspaceId;
  const seen = [];
  const fakeChild = {
    async getFileInfo({ path: filePath }) {
      seen.push(filePath);
      assert.equal(fs.existsSync(filePath), true);
      return { content: [{ type: 'text', text: '[0] { name: Data, rowCount: 3, colCount: 2 }' }] };
    },
    async readFileStructured({ path: filePath, offset = 0 }) {
      seen.push(filePath);
      assert.equal(fs.existsSync(filePath), true);
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.pdf') return { content: [{ type: 'text', text: '<!-- Page: 1 -->\nSnapshot PDF' }] };
      if (ext === '.docx') {
        if (offset > 0) return { content: [{ type: 'text', text: '[DOCX XML: snapshot]\n<w:document xmlns:w="x"><w:body/></w:document>' }] };
        return { content: [{ type: 'text', text: 'DOCX Outline: 1 body children, 1 paragraphs, 0 tables, 0 images\nSnapshot DOCX' }] };
      }
      return { content: [{ type: 'text', text: '[[\"snapshot\"]]' }] };
    },
  };

  const excel = await readExcelWithDesktopCommander({
    workspaceId,
    path: 'book.xlsx',
    mode: 'metadata',
    secondaryReadGrants: grants(fixture),
  }, fixture.registry, fakeChild);
  const pdf = await readPdfWithDesktopCommander({
    workspaceId,
    path: 'document.pdf',
    pageCount: 1,
    includeImages: false,
    secondaryReadGrants: grants(fixture),
  }, fixture.registry, fakeChild);
  const docx = await readDocxWithDesktopCommander({
    workspaceId,
    path: 'document.docx',
    mode: 'outline',
    secondaryReadGrants: grants(fixture),
  }, fixture.registry, fakeChild);

  assert.deepEqual(seen.map((filePath) => path.extname(filePath).toLowerCase()), ['.xlsx', '.pdf', '.docx']);
  const publicResults = JSON.stringify([excel, pdf, docx]);
  for (const snapshotPath of seen) {
    assert.notEqual(snapshotPath, path.join(fixture.primary, 'book.xlsx'));
    assert.equal(snapshotPath.startsWith(fixture.primary), false);
    assert.equal(snapshotPath.startsWith(fixture.external), false);
    assert.equal(fs.existsSync(snapshotPath), false);
    assert.equal(fs.existsSync(path.dirname(snapshotPath)), false);
    assert.equal(publicResults.includes(snapshotPath), false);
    assert.equal(publicResults.includes(snapshotPath.replace(/\\/g, '/')), false);
  }
});

test('Issue #156 persistent source change fails the whole read and cleans scratch state', async () => {
  const fixture = await makeFixture();
  const source = path.join(fixture.primary, 'book.xlsx');
  let snapshotPath;
  const fakeChild = {
    async getFileInfo({ path: filePath }) {
      snapshotPath = filePath;
      fs.appendFileSync(source, Buffer.from('changed'));
      return { content: [{ type: 'text', text: '[0] { name: Data, rowCount: 3, colCount: 2 }' }] };
    },
  };
  await assert.rejects(() => readExcelWithDesktopCommander({
    workspaceId: fixture.workspace.workspaceId,
    path: 'book.xlsx',
    mode: 'metadata',
    secondaryReadGrants: grants(fixture),
  }, fixture.registry, fakeChild), /source changed during structured read/iu);
  assert.ok(snapshotPath);
  assert.equal(fs.existsSync(path.dirname(snapshotPath)), false);
});

test('Issue #156 source ABA remains content-bound to snapshot A and may return hash A', async () => {
  const fixture = await makeFixture();
  const source = path.join(fixture.primary, 'book.xlsx');
  const original = fs.readFileSync(source);
  const expectedHash = sha256Bytes(original);
  let snapshotPath;
  const fakeChild = {
    async getFileInfo({ path: filePath }) {
      snapshotPath = filePath;
      assert.equal(hashFile(filePath), expectedHash);
      fs.writeFileSync(source, Buffer.concat([original, Buffer.from('temporary-B')]));
      fs.writeFileSync(source, original);
      return { content: [{ type: 'text', text: '[0] { name: SnapshotA, rowCount: 3, colCount: 2 }' }] };
    },
  };
  const result = await readExcelWithDesktopCommander({
    workspaceId: fixture.workspace.workspaceId,
    path: 'book.xlsx',
    mode: 'metadata',
    secondaryReadGrants: grants(fixture),
  }, fixture.registry, fakeChild);
  assert.equal(result.structuredContent.baseSha256, expectedHash);
  assert.equal(result.structuredContent.sheets[0].name, 'SnapshotA');
  assert.ok(snapshotPath);
  assert.equal(fs.existsSync(path.dirname(snapshotPath)), false);
});

test('Issue #156 snapshot modification fails closed and scratch is cleaned', async () => {
  const fixture = await makeFixture();
  let snapshotPath;
  const fakeChild = {
    async getFileInfo({ path: filePath }) {
      snapshotPath = filePath;
      fs.appendFileSync(filePath, Buffer.from('mutated'));
      return { content: [{ type: 'text', text: '[0] { name: Data, rowCount: 3, colCount: 2 }' }] };
    },
  };
  await assert.rejects(() => readExcelWithDesktopCommander({
    workspaceId: fixture.workspace.workspaceId,
    path: 'book.xlsx',
    mode: 'metadata',
    secondaryReadGrants: grants(fixture),
  }, fixture.registry, fakeChild), /snapshot changed during structured read/iu);
  assert.ok(snapshotPath);
  assert.equal(fs.existsSync(path.dirname(snapshotPath)), false);
});

test('Issue #156 provider failure and timeout both clean private scratch state', async () => {
  const fixture = await makeFixture();
  let failedPath;
  const failingChild = {
    async getFileInfo({ path: filePath }) {
      failedPath = filePath;
      throw new Error('provider failed');
    },
  };
  await assert.rejects(() => readExcelWithDesktopCommander({
    workspaceId: fixture.workspace.workspaceId,
    path: 'book.xlsx',
    mode: 'metadata',
    secondaryReadGrants: grants(fixture),
  }, fixture.registry, failingChild), /child read failed/iu);
  assert.ok(failedPath);
  assert.equal(fs.existsSync(path.dirname(failedPath)), false);

  let timeoutPath;
  let recovered = 0;
  const timeoutChild = {
    readFileStructured: async ({ path: filePath }) => {
      timeoutPath = filePath;
      return new Promise(() => {});
    },
    recoverAfterTimeout: async () => { recovered += 1; },
  };
  await assert.rejects(() => readPdfWithDesktopCommander({
    workspaceId: fixture.workspace.workspaceId,
    path: 'document.pdf',
    pageCount: 1,
    includeImages: false,
    timeoutMs: 30,
    secondaryReadGrants: grants(fixture),
  }, fixture.registry, timeoutChild), /timeout/iu);
  assert.equal(recovered, 1);
  assert.ok(timeoutPath);
  assert.equal(fs.existsSync(path.dirname(timeoutPath)), false);
});
