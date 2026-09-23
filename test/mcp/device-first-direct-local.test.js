import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { PDFDocument, rgb } from 'pdf-lib';
import { DocxFileHandler } from '@wonderwhy-er/desktop-commander/dist/utils/files/docx.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMcpServer } from '../../src/mcp/server.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { createDurableGovernanceService } from '../../src/governance/durable.js';
import { MutationOwner } from '../../src/state/mutation-owner.js';
import { OperationState } from '../../src/state/operation-state.js';

function textOf(result) {
  const item = result?.content?.find((entry) => entry.type === 'text');
  return item ? item.text : '';
}

function structuredOf(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = textOf(result);
  return text ? JSON.parse(text) : null;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { result, text: textOf(result), structured: structuredOf(result) };
}

async function makePdf(file, labels) {
  const pdf = await PDFDocument.create();
  for (const label of labels) {
    const page = pdf.addPage([300, 200]);
    page.drawText(label, { x: 20, y: 150, size: 18, color: rgb(0, 0, 0) });
  }
  fs.writeFileSync(file, Buffer.from(await pdf.save()));
}

async function fixture() {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'issue159-device-first-'));
  const primary = path.join(host, 'primary');
  const secondary = path.join(host, 'secondary');
  fs.mkdirSync(primary);
  fs.mkdirSync(secondary);
  fs.writeFileSync(path.join(primary, 'note.txt'), 'before', 'utf8');
  fs.writeFileSync(path.join(primary, 'move-me.txt'), 'move me', 'utf8');
  fs.writeFileSync(path.join(secondary, 'read-only.txt'), 'secondary', 'utf8');

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');
  sheet.addRows([
    ['name', 'amount'],
    ['before', 1],
  ]);
  await workbook.xlsx.writeFile(path.join(primary, 'book.xlsx'));

  const docx = new DocxFileHandler();
  await docx.write(path.join(primary, 'existing.docx'), 'Before DOCX', 'rewrite');

  await makePdf(path.join(primary, 'document.pdf'), ['Page one', 'Page two']);

  return { host, primary, secondary };
}

test('Issue #159 ordinary Direct Local read/write works with durable Governance present but no active mission authority', async (t) => {
  const f = await fixture();
  const registry = new WorkspaceRegistry({ allowedRoots: [f.host] });
  const governance = createDurableGovernanceService({ dataRoot: f.host, namespace: 'issue159' });
  const owner = new MutationOwner();
  const operationState = new OperationState({ dataRoot: f.host });
  const verifyChecks = {
    effectful: {
      effect: 'workspace_effect',
      command: process.execPath,
      args: ['-e', "require('fs').writeFileSync('verified.txt','ok')"],
      timeoutMs: 10000,
    },
  };
  const server = await startMcpServer({
    workspaceRegistry: registry,
    governanceService: governance,
    mutationOwner: owner,
    operationState,
    verifyChecks,
    host: '127.0.0.1',
    port: 0,
    allowedRoots: [f.host],
  });
  const client = new Client({ name: 'issue159-device-first', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(server.url));
  t.after(async () => {
    try { await client.close(); } catch {}
    try { await server.close(); } catch {}
    try { governance.close(); } catch {}
    fs.rmSync(f.host, { recursive: true, force: true });
  });

  const governanceBefore = JSON.parse((await call(client, 'governance_status', {})).text);
  const opened = JSON.parse((await call(client, 'workspace_open', {
    path: f.primary,
    secondaryReadGrants: [f.secondary],
  })).text);
  const workspaceId = opened.workspaceId;

  const listed = await client.listTools();
  const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
  const ordinaryMutationTools = [
    'edit',
    'filesystem_create_directory',
    'filesystem_move',
    'excel_write_range',
    'docx_create_text',
    'docx_edit_text',
    'pdf_mutate_pages',
    'verify',
  ];
  for (const name of ordinaryMutationTools) {
    const properties = byName[name]?.inputSchema?.properties || {};
    assert.ok(byName[name], name + ' must be listed');
    for (const field of ['taskId', 'authorityToken', 'executionToken']) {
      assert.equal(Object.hasOwn(properties, field), false, name + ' must not expose ' + field);
    }
  }

  // Text preview/apply requires only the bound workspace/resource scope.
  const firstRead = JSON.parse((await call(client, 'read', {
    workspaceId,
    path: 'note.txt',
  })).text);
  const preview = JSON.parse((await call(client, 'edit', {
    workspaceId,
    mode: 'preview',
    change: {
      path: 'note.txt',
      baseHash: firstRead.sha256,
      replacements: [{ oldText: 'before', newText: 'after', expectedOccurrences: 1 }],
    },
  })).text);
  const applied = JSON.parse((await call(client, 'edit', {
    workspaceId,
    mode: 'apply',
    changeSetId: preview.changeSetId,
  })).text);
  assert.equal(applied.status, 'applied');
  assert.equal(fs.readFileSync(path.join(f.primary, 'note.txt'), 'utf8'), 'after');

  const created = JSON.parse((await call(client, 'filesystem_create_directory', {
    workspaceId,
    path: 'created',
  })).text);
  assert.equal(created.status, 'applied');
  const moved = JSON.parse((await call(client, 'filesystem_move', {
    workspaceId,
    source: 'move-me.txt',
    destination: 'created/moved.txt',
  })).text);
  assert.equal(moved.status, 'applied');
  assert.equal(fs.readFileSync(path.join(f.primary, 'created', 'moved.txt'), 'utf8'), 'move me');

  // Typed reads provide the exact optimistic-concurrency base consumed by mutations.
  const excelRead = await call(client, 'read_excel', {
    workspaceId,
    path: 'book.xlsx',
    mode: 'values',
    sheet: 'Data',
    range: 'A1:B2',
  });
  assert.match(excelRead.structured.baseSha256, /^[0-9a-f]{64}$/u);
  const excelWrite = JSON.parse((await call(client, 'excel_write_range', {
    workspaceId,
    path: 'book.xlsx',
    range: 'Data!A2:B2',
    values: [['device-first', 9]],
    expectedBaseSha256: excelRead.structured.baseSha256,
  })).text);
  assert.equal(excelWrite.status, 'applied');
  const excelReadback = await call(client, 'read_excel', {
    workspaceId,
    path: 'book.xlsx',
    mode: 'values',
    sheet: 'Data',
    range: 'A1:B2',
  });
  assert.match(JSON.stringify(excelReadback.structured), /device-first/u);
  assert.notEqual(excelReadback.structured.baseSha256, excelRead.structured.baseSha256);

  const staleExcel = await call(client, 'excel_write_range', {
    workspaceId,
    path: 'book.xlsx',
    range: 'Data!A2:A2',
    values: [['must-fail']],
    expectedBaseSha256: excelRead.structured.baseSha256,
  });
  assert.equal(staleExcel.result.isError, true);
  assert.match(staleExcel.text, /stale Excel/iu);

  const docxCreated = JSON.parse((await call(client, 'docx_create_text', {
    workspaceId,
    path: 'created.docx',
    text: 'Device first DOCX',
  })).text);
  assert.equal(docxCreated.status, 'applied');
  const docxRead = await call(client, 'read_docx', {
    workspaceId,
    path: 'created.docx',
    mode: 'outline',
  });
  assert.match(JSON.stringify(docxRead.structured), /Device first DOCX/u);
  assert.match(docxRead.structured.baseSha256, /^[0-9a-f]{64}$/u);
  const docxEdited = JSON.parse((await call(client, 'docx_edit_text', {
    workspaceId,
    path: 'created.docx',
    find: 'Device first DOCX',
    replace: 'Device resource DOCX',
    expectedOccurrences: 1,
    expectedBaseSha256: docxRead.structured.baseSha256,
  })).text);
  assert.equal(docxEdited.status, 'applied');
  const docxReadback = await call(client, 'read_docx', {
    workspaceId,
    path: 'created.docx',
    mode: 'outline',
  });
  assert.match(JSON.stringify(docxReadback.structured), /Device resource DOCX/u);

  const pdfRead = await call(client, 'read_pdf', {
    workspaceId,
    path: 'document.pdf',
    pageCount: 2,
    includeImages: false,
  });
  assert.match(pdfRead.structured.baseSha256, /^[0-9a-f]{64}$/u);
  assert.equal(pdfRead.structured.pages.length, 2);
  const pdfWrite = JSON.parse((await call(client, 'pdf_mutate_pages', {
    workspaceId,
    path: 'document.pdf',
    operations: [{ type: 'delete_pages', pages: [2] }],
    expectedBaseSha256: pdfRead.structured.baseSha256,
  })).text);
  assert.equal(pdfWrite.status, 'applied');
  const pdfReadback = await call(client, 'read_pdf', {
    workspaceId,
    path: 'document.pdf',
    pageCount: 2,
    includeImages: false,
  });
  assert.equal(pdfReadback.structured.pages.length, 1);

  const verified = JSON.parse((await call(client, 'verify', {
    workspaceId,
    check: 'effectful',
  })).text);
  assert.equal(verified.passed, true);
  assert.equal(fs.readFileSync(path.join(f.primary, 'verified.txt'), 'utf8'), 'ok');

  // Explicit secondary grants remain read-only.
  const secondaryRead = JSON.parse((await call(client, 'read', {
    workspaceId,
    path: path.join(f.secondary, 'read-only.txt'),
  })).text);
  assert.equal(secondaryRead.content, 'secondary');
  const secondaryWrite = await call(client, 'filesystem_create_directory', {
    workspaceId,
    path: path.join(f.secondary, 'must-not-write'),
  });
  assert.equal(secondaryWrite.result.isError, true);
  assert.match(secondaryWrite.text, /relative|primary workspace/iu);

  const traversal = await call(client, 'filesystem_create_directory', {
    workspaceId,
    path: '../escape',
  });
  assert.equal(traversal.result.isError, true);
  assert.match(traversal.text, /traversal|escapes/iu);

  const sensitive = await call(client, 'filesystem_create_directory', {
    workspaceId,
    path: '.git/blocked',
  });
  assert.equal(sensitive.result.isError, true);
  assert.match(sensitive.text, /blocked|policy/iu);

  const link = path.join(f.primary, 'secondary-link');
  try {
    fs.symlinkSync(f.secondary, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {}
  if (fs.existsSync(link)) {
    const throughLink = await call(client, 'filesystem_create_directory', {
      workspaceId,
      path: 'secondary-link/blocked',
    });
    assert.equal(throughLink.result.isError, true);
    assert.match(throughLink.text, /symlink|junction/iu);
  }

  owner.acquire('codex', 'conflicting-writer');
  const writerConflict = await call(client, 'filesystem_create_directory', {
    workspaceId,
    path: 'writer-conflict',
  });
  assert.equal(writerConflict.result.isError, true);
  assert.match(writerConflict.text, /owned by codex|cannot acquire chatgpt/iu);
  owner.markUnitState('reconciled');
  owner.release();
  assert.equal(fs.existsSync(path.join(f.primary, 'writer-conflict')), false);

  // Legacy mission-authority fields are not accepted and ignored.
  const staleAuthorityField = await call(client, 'verify', {
    workspaceId,
    check: 'effectful',
    executionToken: 'legacy-token',
  });
  assert.equal(staleAuthorityField.result.isError, true);
  assert.match(staleAuthorityField.text, /executionToken|unrecognized|invalid/i);

  const governanceAfter = JSON.parse((await call(client, 'governance_status', {})).text);
  assert.deepEqual(
    governanceAfter,
    governanceBefore,
    'ordinary Direct Local operations must not create, advance, revise, or otherwise mutate durable Governance state',
  );
});
