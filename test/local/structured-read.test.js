import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import { PDFDocument, rgb } from 'pdf-lib';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import {
  STRUCTURED_READ_LIMITS,
  inspectZip,
  readImageWithDesktopCommander,
  readExcelWithDesktopCommander,
  searchExcelWithDesktopCommander,
  readPdfWithDesktopCommander,
  readDocxWithDesktopCommander,
} from '../../src/local/structured-read.js';
import { DesktopCommanderChild } from '../../src/local/desktop-commander-child.js';
import { startMcpServer } from '../../src/mcp/server.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const require = createRequire(import.meta.url);
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const WEBP_1X1 = Buffer.from('UklGRiIAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=', 'base64');
const JPEG_1X1 = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AYf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AYf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z', 'base64');

function bmp1x1() {
  const buffer = Buffer.alloc(58);
  buffer.write('BM', 0, 2, 'ascii');
  buffer.writeUInt32LE(58, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(1, 18);
  buffer.writeInt32LE(1, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(0, 30);
  buffer.writeUInt32LE(4, 34);
  buffer.writeInt32LE(2835, 38);
  buffer.writeInt32LE(2835, 42);
  buffer.writeUInt32LE(0, 46);
  buffer.writeUInt32LE(0, 50);
  buffer.writeUInt8(0xff, 54);
  buffer.writeUInt8(0, 55);
  buffer.writeUInt8(0, 56);
  buffer.writeUInt8(0, 57);
  return buffer;
}

async function makeFixtures() {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'issue135-structured-'));
  const primary = path.join(host, 'primary');
  const external = path.join(host, 'external');
  const sibling = path.join(host, 'sibling');
  fs.mkdirSync(primary); fs.mkdirSync(external); fs.mkdirSync(sibling);

  const images = {
    '.png': PNG_1X1,
    '.jpg': JPEG_1X1,
    '.jpeg': JPEG_1X1,
    '.gif': GIF_1X1,
    '.webp': WEBP_1X1,
    '.bmp': bmp1x1(),
  };
  for (const [extension, bytes] of Object.entries(images)) fs.writeFileSync(path.join(primary, 'image' + extension), bytes);
  fs.writeFileSync(path.join(primary, 'spoof.png'), JPEG_1X1);
  fs.writeFileSync(path.join(primary, 'blocked.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg>');
  fs.writeFileSync(path.join(external, 'granted.png'), PNG_1X1);
  fs.writeFileSync(path.join(sibling, 'blocked.png'), PNG_1X1);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');
  sheet.addRows([
    ['name', 'amount'],
    ['alpha marker', 3],
    ['beta', 7],
  ]);
  sheet.getCell('C2').value = { formula: 'B2*2', result: 6 };
  const xlsx = path.join(primary, 'book.xlsx');
  await workbook.xlsx.writeFile(xlsx);
  fs.copyFileSync(xlsx, path.join(primary, 'macro.xlsm'));
  fs.copyFileSync(xlsx, path.join(primary, 'legacy.xls'));
  fs.writeFileSync(path.join(primary, 'malformed.xlsx'), 'not a zip', 'utf8');

  const docxZip = new PizZip();
  docxZip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  docxZip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>');
  fs.writeFileSync(path.join(primary, 'document.docx'), docxZip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
  fs.writeFileSync(path.join(primary, 'malformed.docx'), 'not a zip', 'utf8');

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 200]);
  page.drawText('PDF marker', { x: 20, y: 150, size: 18, color: rgb(0, 0, 0) });
  page.drawImage(await pdf.embedPng(PNG_1X1), { x: 20, y: 20, width: 40, height: 40 });
  fs.writeFileSync(path.join(primary, 'document.pdf'), await pdf.save());
  fs.writeFileSync(path.join(primary, 'malformed.pdf'), 'not a pdf', 'utf8');

  const registry = new WorkspaceRegistry({ allowedRoots: [host] });
  const workspace = registry.open({ path: primary, secondaryReadGrants: [external] });
  return { host, primary, external, sibling, registry, workspace };
}

function grants(fixture) {
  return fixture.registry.getSecondaryReadGrants(fixture.workspace.workspaceId);
}

test('real child raster reads preserve typed image blocks and reject spoof/SVG/authority escapes', async () => {
  const fixture = await makeFixtures();
  const child = new DesktopCommanderChild();
  try {
    for (const extension of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']) {
      const result = await readImageWithDesktopCommander({
        workspaceId: fixture.workspace.workspaceId,
        path: 'image' + extension,
        secondaryReadGrants: grants(fixture),
      }, fixture.registry, child);
      assert.equal(result.structuredContent.kind, 'image');
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, 'image');
      assert.equal(result.content[0].mimeType, extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/' + extension.slice(1));
    }
    await assert.rejects(() => readImageWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: 'spoof.png',
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child), /signature/iu);
    await assert.rejects(() => readImageWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: 'blocked.svg',
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child), /extension/iu);
    await assert.rejects(() => readImageWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: path.join(fixture.sibling, 'blocked.png'),
      secondaryReadGrants: [],
    }, fixture.registry, child), /secondary read grant/iu);
    const granted = await readImageWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: path.join(fixture.external, 'granted.png'),
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.equal(granted.structuredContent.bytes > 0, true);
  } finally {
    await child.close();
  }
});

test('real child Excel metadata/values/search are bounded and .xls/malformed inputs fail closed', async () => {
  const fixture = await makeFixtures();
  const child = new DesktopCommanderChild();
  try {
    const metadata = await readExcelWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: 'book.xlsx',
      mode: 'metadata',
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.equal(metadata.structuredContent.sheets[0].name, 'Data');
    assert.equal(metadata.structuredContent.sheets[0].rowCount >= 3, true);

    const values = await readExcelWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: 'macro.xlsm',
      mode: 'values',
      sheet: 'Data',
      range: 'A1:B3',
      maxRows: 10,
      maxCells: 20,
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.deepEqual(values.structuredContent.values[1], ['alpha marker', 3]);
    assert.equal(values.structuredContent.cells, 6);

    const matches = await searchExcelWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: 'book.xlsx',
      query: 'marker',
      maxResults: 10,
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.equal(matches.structuredContent.matches.some((match) => match.sheet === 'Data' && match.row === 2), true);

    for (const name of ['legacy.xls', 'malformed.xlsx']) {
      await assert.rejects(() => readExcelWithDesktopCommander({
        workspaceId: fixture.workspace.workspaceId,
        path: name,
        secondaryReadGrants: grants(fixture),
      }, fixture.registry, child), /extension|ZIP|container|budget|workbook/iu);
    }
    const expansionProbe = new PizZip();
    expansionProbe.file('bomb.txt', 'x'.repeat(2 * 1024 * 1024));
    const expansionBytes = expansionProbe.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    assert.throws(() => inspectZip(expansionBytes, { maxExpandedBytes: 1024 }), /expanded|ratio/iu);
    await assert.rejects(() => readExcelWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: 'book.xlsx',
      range: 'A1:Z100',
      maxCells: 10,
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child), /budget/iu);
    await assert.rejects(() => readExcelWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: path.join(fixture.sibling, 'blocked.xlsx'),
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child), /secondary read grant|not found/iu);
  } finally {
    await child.close();
  }
});

test('real child PDF pages/text/typed embedded images use bounded read path; metadata shortcut is absent', async () => {
  const fixture = await makeFixtures();
  const child = new DesktopCommanderChild();
  try {
    const result = await readPdfWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: 'document.pdf',
      pageCount: 2,
      maxImages: 4,
      maxImageBytes: 1024 * 1024,
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.equal(result.structuredContent.kind, 'pdf');
    assert.match(result.structuredContent.pages[0].text, /PDF marker/iu);
    assert.equal(result.content.some((item) => item.type === 'image'), true);
    assert.equal(Object.hasOwn(result.structuredContent, 'metadataOnly'), false);
    await assert.rejects(() => readPdfWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: 'malformed.pdf',
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child), /signature/iu);
    await assert.rejects(() => readPdfWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: 'document.pdf',
      pageCount: 1,
      maxTextBytes: 1,
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child), /text byte budget/iu);
  } finally {
    await child.close();
  }
});

test('real child DOCX outline/raw XML/info are bounded and mutation hints are not exposed', async () => {
  const fixture = await makeFixtures();
  const child = new DesktopCommanderChild();
  try {
    const outline = await readDocxWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: 'document.docx',
      mode: 'outline',
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.match(outline.structuredContent.outline, /Hello DOCX/iu);
    assert.doesNotMatch(outline.structuredContent.outline, /edit_block|start_process|bulk changes/iu);
    const xml = await readDocxWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: 'document.docx',
      mode: 'xml',
      offset: 1,
      maxLines: 20,
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.match(xml.structuredContent.xml, /w:document/iu);
    const info = await readDocxWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: 'document.docx',
      mode: 'info',
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child);
    assert.equal(info.structuredContent.paragraphs, 1);
    await assert.rejects(() => readDocxWithDesktopCommander({
      workspaceId: fixture.workspace.workspaceId,
      path: 'malformed.docx',
      secondaryReadGrants: grants(fixture),
    }, fixture.registry, child), /ZIP|container/iu);
  } finally {
    await child.close();
  }
});

test('structured child timeout invalidates the generation and retains no mutation/raw escape hatch', async () => {
  let recovered = 0;
  const fakeChild = {
    readFileStructured: async () => new Promise(() => {}),
    recoverAfterTimeout: async () => { recovered += 1; },
  };
  const fixture = await makeFixtures();
  await assert.rejects(() => readPdfWithDesktopCommander({
    workspaceId: fixture.workspace.workspaceId,
    path: 'document.pdf',
    pageCount: 1,
    timeoutMs: 50,
    secondaryReadGrants: grants(fixture),
  }, fixture.registry, fakeChild), /timeout/iu);
  assert.equal(recovered, 1);
});

test('pinned PDF embedded-image regression stays on decoded raw pixels and public MCP surface is typed/read-only', async (t) => {
  const packageRoot = path.dirname(require.resolve('@wonderwhy-er/desktop-commander/package.json'));
  const source = fs.readFileSync(path.join(packageRoot, 'dist', 'tools', 'pdf', 'extract-images.js'), 'utf8');
  assert.match(source, /sharp\(Buffer\.from\(data\),/u);
  assert.match(source, /raw:\s*\{/u);
  assert.match(source, /channels:\s*channels/u);

  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'issue135-schema-'));
  const registry = new WorkspaceRegistry({ allowedRoots: [host] });
  const server = await startMcpServer({ workspaceRegistry: registry, host: '127.0.0.1', port: 0, desktopCommanderChild: {
    readFileStructured: async () => ({ content: [] }),
  } });
  t.after(() => server.close());
  const client = new Client({ name: 'issue135-schema', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(server.url));
  t.after(() => client.close());
  const listed = await client.listTools();
  const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
  for (const name of ['read_image', 'read_excel', 'search_excel', 'read_pdf', 'read_docx']) {
    assert.equal(Object.hasOwn(byName, name), true);
    assert.equal(byName[name].annotations.readOnlyHint, true);
  }
  for (const forbidden of ['write_file', 'edit_block', 'execute_command', 'shell']) {
    assert.equal(Object.hasOwn(byName, forbidden), false);
  }
  assert.equal(STRUCTURED_READ_LIMITS.pdf.timeoutMs > 0, true);
});
