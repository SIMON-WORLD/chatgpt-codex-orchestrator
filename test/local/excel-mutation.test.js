import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as SheetJSModule from 'xlsx';
import { ExcelFileHandler } from '@wonderwhy-er/desktop-commander/dist/utils/files/excel.js';
import { WorkspaceRegistry } from '../../src/local/workspace.js';
import { MutationOwner } from '../../src/state/mutation-owner.js';
import { ExcelMutationService, EXCEL_MUTATION_LIMITS } from '../../src/local/excel-mutation.js';

const XLSX = SheetJSModule.default ?? SheetJSModule;

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixture(prefix = 'issue137-excel-') {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const primary = path.join(host, 'primary');
  const outside = path.join(host, 'outside');
  fs.mkdirSync(primary);
  fs.mkdirSync(outside);
  const registry = new WorkspaceRegistry({ allowedRoots: [host] });
  const workspace = registry.open({ path: primary, secondaryReadGrants: [outside] });
  return { host, primary, outside, registry, workspace };
}

function exactProviderChild({ failEdit = false } = {}) {
  const handler = new ExcelFileHandler();
  const calls = [];
  return {
    calls,
    async editBlock({ filePath, range, content }) {
      calls.push(['editBlock', filePath, range, content]);
      if (failEdit) throw new Error('provider edit failed');
      return handler.editRange(filePath, range, content);
    },
    async readFileStructured({ path: filePath, offset = 0, maxLines = 2000, sheet, range }) {
      const out = await handler.read(filePath, { offset, length: maxLines, sheet, range });
      return { content: [{ type: 'text', text: out.content }] };
    },
  };
}

function writeXlsx(file, values = [['before', 1]]) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(values);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  fs.writeFileSync(file, Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })));
}

function writeXlsm(file, values = [['before', 1]]) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(values);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  wb.vbaraw = Buffer.from('ISSUE137-VBA-SENTINEL');
  wb.Workbook = {
    WBProps: { CodeName: 'Issue137Workbook' },
    Sheets: [{ name: 'Sheet1', CodeName: 'Issue137Sheet' }],
  };
  fs.writeFileSync(file, Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsm', bookVBA: true })));
}

function serviceFor(f, { child = exactProviderChild(), sheetJs = XLSX, owner = new MutationOwner() } = {}) {
  return {
    child,
    owner,
    service: new ExcelMutationService({
      workspaceRegistry: f.registry,
      mutationOwner: owner,
      desktopCommanderChild: child,
      sheetJs,
    }),
  };
}

test('Issue #137 .xlsx range mutation uses pinned provider and preserves leading-equals literals', async () => {
  const f = fixture();
  const file = path.join(f.primary, 'book.xlsx');
  writeXlsx(file);
  const { service, child, owner } = serviceFor(f);
  const base = hashFile(file);
  const result = await service.mutateRange({
    workspaceId: f.workspace.workspaceId,
    path: 'book.xlsx',
    range: 'Sheet1!A1:B1',
    values: [['=ISSUE137_LITERAL', 42]],
    expectedBaseSha256: base,
  });
  assert.equal(result.provider, 'desktop-commander-0.2.51');
  assert.deepEqual(result.readback, [['=ISSUE137_LITERAL', 42]]);
  assert.notEqual(result.resultSha256, base);
  assert.equal(owner.owner, 'none');
  const call = child.calls.find(([name]) => name === 'editBlock');
  assert.ok(call);
  assert.deepEqual(call[3][0][0], { richText: [{ text: '=ISSUE137_LITERAL' }] });
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer', cellFormula: true });
  assert.equal(wb.Sheets.Sheet1.A1.f, undefined);
});

test('Issue #137 .xlsm mutation preserves VBA bytes, code names, literal strings, and atomic readback', async () => {
  const f = fixture();
  const file = path.join(f.primary, 'macro.xlsm');
  writeXlsm(file);
  const before = XLSX.read(fs.readFileSync(file), { type: 'buffer', bookVBA: true, cellFormula: true });
  const beforeVbaHash = crypto.createHash('sha256').update(Buffer.from(before.vbaraw)).digest('hex');
  const beforeCodes = JSON.stringify(before.Workbook);
  const { service, owner } = serviceFor(f);
  const result = await service.mutateRange({
    workspaceId: f.workspace.workspaceId,
    path: 'macro.xlsm',
    range: 'Sheet1!A1:B1',
    values: [['=MACRO_LITERAL', true]],
    expectedBaseSha256: hashFile(file),
  });
  assert.equal(result.provider, 'sheetjs-ce-0.20.3');
  assert.deepEqual(result.readback, [['=MACRO_LITERAL', true]]);
  assert.equal(owner.owner, 'none');
  const after = XLSX.read(fs.readFileSync(file), { type: 'buffer', bookVBA: true, cellFormula: true });
  const afterVbaHash = crypto.createHash('sha256').update(Buffer.from(after.vbaraw)).digest('hex');
  assert.equal(afterVbaHash, beforeVbaHash);
  assert.equal(JSON.stringify(after.Workbook), beforeCodes);
  assert.equal(after.Sheets.Sheet1.A1.v, '=MACRO_LITERAL');
  assert.equal(after.Sheets.Sheet1.A1.f, undefined);
});

test('Issue #137 Excel mutation rejects stale, shape, formula objects, .xls, traversal and secondary writes before dispatch', async () => {
  const f = fixture();
  const xlsx = path.join(f.primary, 'book.xlsx');
  writeXlsx(xlsx);
  const xls = path.join(f.primary, 'legacy.xls');
  fs.writeFileSync(xls, 'legacy');
  const { service, child, owner } = serviceFor(f);
  const workspaceId = f.workspace.workspaceId;
  const base = hashFile(xlsx);
  await assert.rejects(() => service.mutateRange({ workspaceId, path: 'book.xlsx', range: 'Sheet1!A1:A1', values: [[1, 2]], expectedBaseSha256: base }), /shape/u);
  await assert.rejects(() => service.mutateRange({ workspaceId, path: 'book.xlsx', range: 'Sheet1!A1:A1', values: [[{ formula: '1+1' }]], expectedBaseSha256: base }), /formulas|non-primitive/u);
  await assert.rejects(() => service.mutateRange({ workspaceId, path: 'book.xlsx', range: 'Sheet1!A1:A1', values: [[1]], expectedBaseSha256: '0'.repeat(64) }), /stale/u);
  await assert.rejects(() => service.mutateRange({ workspaceId, path: 'legacy.xls', range: 'Sheet1!A1:A1', values: [[1]], expectedBaseSha256: hashFile(xls) }), /\.xls mutation is not supported/u);
  await assert.rejects(() => service.mutateRange({ workspaceId, path: '../escape.xlsx', range: 'Sheet1!A1:A1', values: [[1]], expectedBaseSha256: base }), /traversal|escapes/u);
  await assert.rejects(() => service.mutateRange({ workspaceId, path: path.join(f.outside, 'book.xlsx'), range: 'Sheet1!A1:A1', values: [[1]], expectedBaseSha256: base }), /relative/u);
  assert.equal(child.calls.length, 0);
  assert.equal(owner.owner, 'none');
});

test('Issue #137 Excel mutation enforces row/cell and serialized-input budgets', async () => {
  const f = fixture();
  const file = path.join(f.primary, 'book.xlsx');
  writeXlsx(file);
  const { service, owner } = serviceFor(f);
  const base = hashFile(file);
  const tooManyRows = Array.from({ length: EXCEL_MUTATION_LIMITS.rows + 1 }, () => [1]);
  await assert.rejects(() => service.mutateRange({
    workspaceId: f.workspace.workspaceId,
    path: 'book.xlsx',
    range: 'Sheet1!A1:A2001',
    values: tooManyRows,
    expectedBaseSha256: base,
  }), /budget/u);
  const huge = 'x'.repeat(EXCEL_MUTATION_LIMITS.mutationInputBytes + 10);
  await assert.rejects(() => service.mutateRange({
    workspaceId: f.workspace.workspaceId,
    path: 'book.xlsx',
    range: 'Sheet1!A1:A1',
    values: [[huge]],
    expectedBaseSha256: base,
  }), /byte budget/u);
  assert.equal(owner.owner, 'none');
});

test('Issue #137 .xlsm fidelity failure leaves original unchanged and releases ownership before replace', async () => {
  const f = fixture();
  const file = path.join(f.primary, 'macro.xlsm');
  writeXlsm(file);
  const originalHash = hashFile(file);
  const originalWrite = XLSX.write.bind(XLSX);
  const badSheetJs = {
    ...XLSX,
    write(workbook, options) {
      const saved = workbook.vbaraw;
      workbook.vbaraw = Buffer.from('CORRUPTED-VBA');
      try { return originalWrite(workbook, options); }
      finally { workbook.vbaraw = saved; }
    },
  };
  const owner = new MutationOwner();
  const { service } = serviceFor(f, { sheetJs: badSheetJs, owner });
  await assert.rejects(() => service.mutateRange({
    workspaceId: f.workspace.workspaceId,
    path: 'macro.xlsm',
    range: 'Sheet1!A1:A1',
    values: [['after']],
    expectedBaseSha256: originalHash,
  }), /VBA project fidelity guard/u);
  assert.equal(hashFile(file), originalHash);
  assert.equal(owner.owner, 'none');
  assert.equal(fs.readdirSync(f.primary).some((name) => name.startsWith('.excel-')), false);
});

test('Issue #137 provider failure after .xlsx dispatch retains unknown MutationOwner', async () => {
  const f = fixture();
  const file = path.join(f.primary, 'book.xlsx');
  writeXlsx(file);
  const owner = new MutationOwner();
  const child = exactProviderChild({ failEdit: true });
  const { service } = serviceFor(f, { owner, child });
  await assert.rejects(() => service.mutateRange({
    workspaceId: f.workspace.workspaceId,
    path: 'book.xlsx',
    range: 'Sheet1!A1:A1',
    values: [['after']],
    expectedBaseSha256: hashFile(file),
  }), /provider edit failed/u);
  assert.equal(owner.owner, 'chatgpt');
  assert.equal(owner.unitState, 'unknown');
  owner.markUnitState('reconciled');
  owner.release();
});
