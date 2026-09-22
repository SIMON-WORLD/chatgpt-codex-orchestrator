import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
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

function fixtureXmlText(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function fixtureRun(text) {
  const preserve = /^\s/u.test(text) || /\s$/u.test(text);
  const space = preserve ? ' xml:space="preserve"' : '';
  return '<w:r><w:t' + space + '>' + fixtureXmlText(text) + '</w:t></w:r>';
}

function fixtureParagraph(parts) {
  return '<w:p>' + parts.map((part) => fixtureRun(part)).join('') + '</w:p>';
}

function fixtureTable(cells) {
  const grid = cells.map(() => '<w:gridCol w:w="2400"/>').join('');
  const row = cells.map((parts) => (
    '<w:tc><w:tcPr/>' + fixtureParagraph(parts) + '</w:tc>'
  )).join('');
  return '<w:tbl><w:tblPr/><w:tblGrid>' + grid + '</w:tblGrid><w:tr>' + row + '</w:tr></w:tbl>';
}

async function rewriteDocxBody(file, bodyXml) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const entry = zip.file('word/document.xml');
  assert.ok(entry, 'word/document.xml must exist');
  const xml = await entry.async('string');
  const bodyMatch = xml.match(/<w:body>([\s\S]*?)<\/w:body>/u);
  assert.ok(bodyMatch, 'w:body must exist');
  const section = bodyMatch[1].match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*$/u)?.[0] || '';
  const next = xml.replace(
    /<w:body>[\s\S]*?<\/w:body>/u,
    '<w:body>' + bodyXml + section + '</w:body>',
  );
  zip.file('word/document.xml', next);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(file, bytes);
}

function decodeFixtureXml(value) {
  return String(value).replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|amp|lt|gt|quot|apos);/giu, (token, hex, dec) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (dec) return String.fromCodePoint(Number.parseInt(dec, 10));
    if (token.toLowerCase() === '&amp;') return '&';
    if (token.toLowerCase() === '&lt;') return '<';

    if (token.toLowerCase() === '&gt;') return '>';
    if (token.toLowerCase() === '&quot;') return '"';
    return "'";
  });
}

async function rawDocxXml(file) {
  const out = await new DocxFileHandler().read(file, { offset: 1, length: 10000 });
  return out.content;
}

function visibleParagraphTexts(xml) {
  const paragraphs = [];
  const paragraphRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/gu;
  let paragraphMatch;
  while ((paragraphMatch = paragraphRe.exec(String(xml))) !== null) {
    const texts = [];
    const nodeRe = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/gu;
    let nodeMatch;
    while ((nodeMatch = nodeRe.exec(paragraphMatch[0])) !== null) {
      texts.push(decodeFixtureXml(nodeMatch[1]));
    }
    paragraphs.push(texts.join(''));
  }
  return paragraphs;
}

test('Issue #137 DOCX visible edit matches a phrase split across two runs', async () => {
  const f = fixture();
  const file = path.join(f.primary, 'split-two.docx');
  await makeDocx(file, 'seed');
  await rewriteDocxBody(file, fixtureParagraph(['Hello ', 'world']));
  const owner = new MutationOwner();
  const service = new DocxMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: exactChild() });
  await service.editText({
    workspaceId: f.workspace.workspaceId,
    path: 'split-two.docx',
    find: 'Hello world',
    replace: 'Goodbye',
    expectedOccurrences: 1,
    expectedBaseSha256: hashFile(file),
  });
  const raw = await rawDocxXml(file);
  assert.deepEqual(visibleParagraphTexts(raw), ['Goodbye']);
  assert.equal((raw.match(/<w:r\b/gu) || []).length, 2);
  assert.equal(owner.owner, 'none');
});

test('Issue #137 DOCX visible edit preserves partial boundary text and escapes replacement payload', async () => {
  const f = fixture();
  const file = path.join(f.primary, 'split-three.docx');
  await makeDocx(file, 'seed');
  await rewriteDocxBody(file, fixtureParagraph(['prefix HEL', 'LO ', 'WORLD suffix']));

  const owner = new MutationOwner();
  const service = new DocxMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: exactChild() });
  const replacement = '<w:tab/> & "quoted" \'single\'';
  await service.editText({
    workspaceId: f.workspace.workspaceId,
    path: 'split-three.docx',
    find: 'HELLO WORLD',
    replace: replacement,
    expectedOccurrences: 1,
    expectedBaseSha256: hashFile(file),
  });
  const raw = await rawDocxXml(file);
  assert.deepEqual(visibleParagraphTexts(raw), ['prefix ' + replacement + ' suffix']);
  assert.match(raw, /&lt;w:tab\/&gt; &amp; &quot;quoted&quot; &apos;single&apos;/u);
  assert.doesNotMatch(raw, /<w:tab\s*\/>/u);
  assert.equal((raw.match(/<w:r\b/gu) || []).length, 3);
  const outline = await new DocxFileHandler().read(file, {});
  assert.ok(outline.content);
  assert.equal(owner.owner, 'none');
});

test('Issue #137 DOCX expectedOccurrences counts multiple split-run visible matches exactly', async () => {
  const f = fixture();
  const file = path.join(f.primary, 'multiple.docx');
  await makeDocx(file, 'seed');
  await rewriteDocxBody(file, fixtureParagraph(['Alpha ', 'Beta']) + fixtureParagraph(['Alpha ', 'Beta']));
  const owner = new MutationOwner();

  const service = new DocxMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: exactChild() });
  const base = hashFile(file);
  await assert.rejects(() => service.editText({
    workspaceId: f.workspace.workspaceId,
    path: 'multiple.docx',
    find: 'Alpha Beta',
    replace: 'X',
    expectedOccurrences: 1,
    expectedBaseSha256: base,
  }), /expected 1 visible occurrence\(s\) but found 2/u);
  assert.equal(hashFile(file), base);
  assert.equal(owner.owner, 'none');
  await service.editText({
    workspaceId: f.workspace.workspaceId,
    path: 'multiple.docx',
    find: 'Alpha Beta',
    replace: 'X',
    expectedOccurrences: 2,
    expectedBaseSha256: base,
  });
  assert.deepEqual(visibleParagraphTexts(await rawDocxXml(file)), ['X', 'X']);
  assert.equal(owner.owner, 'none');
});

test('Issue #137 DOCX visible edit matches split runs inside a table cell', async () => {
  const f = fixture();
  const file = path.join(f.primary, 'table.docx');

  await makeDocx(file, 'seed');
  await rewriteDocxBody(file, fixtureTable([['Cell ', 'phrase']]));
  const owner = new MutationOwner();
  const service = new DocxMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: exactChild() });
  await service.editText({
    workspaceId: f.workspace.workspaceId,
    path: 'table.docx',
    find: 'Cell phrase',
    replace: 'Replaced',
    expectedOccurrences: 1,
    expectedBaseSha256: hashFile(file),
  });
  assert.deepEqual(visibleParagraphTexts(await rawDocxXml(file)), ['Replaced']);
  const outline = await new DocxFileHandler().read(file, {});
  assert.ok(outline.content);
  assert.equal(owner.owner, 'none');
});

test('Issue #137 DOCX visible edit never matches across paragraph or table-cell boundaries', async () => {
  const f = fixture();
  const paragraphFile = path.join(f.primary, 'paragraph-boundary.docx');
  await makeDocx(paragraphFile, 'seed');
  await rewriteDocxBody(paragraphFile, fixtureParagraph(['Hello ']) + fixtureParagraph(['world']));
  const owner = new MutationOwner();
  const service = new DocxMutationService({ workspaceRegistry: f.registry, mutationOwner: owner, desktopCommanderChild: exactChild() });

  await assert.rejects(() => service.editText({
    workspaceId: f.workspace.workspaceId,
    path: 'paragraph-boundary.docx',
    find: 'Hello world',
    replace: 'Nope',
    expectedOccurrences: 1,
    expectedBaseSha256: hashFile(paragraphFile),
  }), /found 0/u);

  const cellFile = path.join(f.primary, 'cell-boundary.docx');
  await makeDocx(cellFile, 'seed');
  await rewriteDocxBody(cellFile, fixtureTable([['Cell '], ['phrase']]));
  await assert.rejects(() => service.editText({
    workspaceId: f.workspace.workspaceId,
    path: 'cell-boundary.docx',
    find: 'Cell phrase',
    replace: 'Nope',
    expectedOccurrences: 1,
    expectedBaseSha256: hashFile(cellFile),
  }), /found 0/u);
  assert.equal(owner.owner, 'none');
});
