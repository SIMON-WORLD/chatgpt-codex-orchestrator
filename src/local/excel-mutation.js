import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as SheetJSModule from 'xlsx';
import { WorkspaceError } from './workspace.js';
import { isBlockedMutationPath } from './sensitive.js';
import {
  STRUCTURED_READ_LIMITS,
  inspectZip,
  readExcelWithDesktopCommander,
} from './structured-read.js';

const DEFAULT_SHEETJS = SheetJSModule.default ?? SheetJSModule;
const XLSX_EXT = '.xlsx';
const XLSM_EXT = '.xlsm';
const XLS_EXT = '.xls';
const MUTATION_INPUT_BYTES = 1024 * 1024;
const EXCEL_MAX_ROWS = STRUCTURED_READ_LIMITS.excel.rows;
const EXCEL_MAX_CELLS = STRUCTURED_READ_LIMITS.excel.cells;
const EXCEL_MAX_INPUT_BYTES = STRUCTURED_READ_LIMITS.excel.inputBytes;
const EXCEL_MAX_EXPANDED_BYTES = STRUCTURED_READ_LIMITS.excel.expandedBytes;

export const EXCEL_MUTATION_LIMITS = Object.freeze({
  inputBytes: EXCEL_MAX_INPUT_BYTES,
  expandedBytes: EXCEL_MAX_EXPANDED_BYTES,
  mutationInputBytes: MUTATION_INPUT_BYTES,
  rows: EXCEL_MAX_ROWS,
  cells: EXCEL_MAX_CELLS,
});

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function samePath(left, right) {
  let a = path.resolve(left);
  let b = path.resolve(right);
  if (process.platform === 'win32') {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return a === b;
}

function requireRelativePath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkspaceError('Excel mutation path must be a non-empty relative path');
  }
  if (value.includes('\0')) throw new WorkspaceError('Excel mutation path contains a NUL byte');
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
    throw new WorkspaceError('Excel mutation path must be relative to the primary workspace');
  }
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.includes('..')) throw new WorkspaceError('Excel mutation path may not contain traversal components');
  return value;
}

function parseRange(value) {
  if (typeof value !== 'string' || !value.trim() || !value.includes('!')) {
    throw new WorkspaceError('Excel range must be an explicit Sheet!A1 or Sheet!A1:B2 range');
  }
  const bang = value.lastIndexOf('!');
  let sheet = value.slice(0, bang);
  const cells = value.slice(bang + 1);
  if (!sheet || !cells) throw new WorkspaceError('Excel range must include a sheet name and cell range');
  if (sheet.startsWith("'") && sheet.endsWith("'") && sheet.length >= 2) {
    sheet = sheet.slice(1, -1).replace(/''/g, "'");
  } else if (sheet.includes("'")) {
    throw new WorkspaceError('Excel sheet quoting is malformed');
  }
  const match = cells.match(/^([A-Za-z]+)([1-9][0-9]*)(?::([A-Za-z]+)([1-9][0-9]*))?$/u);
  if (!match) throw new WorkspaceError('Excel range must use A1 or A1:B2 notation');
  const startCol = columnNumber(match[1]);
  const startRow = Number(match[2]);
  const endCol = columnNumber(match[3] || match[1]);
  const endRow = Number(match[4] || match[2]);
  if (startCol > endCol || startRow > endRow) throw new WorkspaceError('Excel range must be rectangular and ordered');
  if (endCol > 16384 || endRow > 1048576) throw new WorkspaceError('Excel range exceeds worksheet bounds');
  const rows = endRow - startRow + 1;
  const cols = endCol - startCol + 1;
  const cellsCount = rows * cols;
  if (rows > EXCEL_MAX_ROWS || cellsCount > EXCEL_MAX_CELLS) {
    throw new WorkspaceError('Excel range exceeds row or cell budget');
  }
  return { sheet, cells, startRow, startCol, endRow, endCol, rows, cols, cellsCount };
}

function columnNumber(value) {
  let out = 0;
  for (const ch of String(value).toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) throw new WorkspaceError('Excel column reference is invalid');
    out = out * 26 + (code - 64);
  }
  return out;
}

function validateValues(values, range) {
  if (!Array.isArray(values) || values.length !== range.rows) {
    throw new WorkspaceError('Excel values must be a 2D array matching the requested range shape');
  }
  for (const row of values) {
    if (!Array.isArray(row) || row.length !== range.cols) {
      throw new WorkspaceError('Excel values must be a 2D array matching the requested range shape');
    }
    for (const value of row) {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
      if (typeof value === 'number' && Number.isFinite(value)) continue;
      throw new WorkspaceError('Excel formulas and non-primitive cell values are not supported');
    }
  }
  const serialized = JSON.stringify(values);
  if (Buffer.byteLength(serialized, 'utf8') > MUTATION_INPUT_BYTES) {
    throw new WorkspaceError('Excel mutation input exceeds byte budget');
  }
}

function assertReadableWorkbook(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new WorkspaceError('Excel workbook bytes are unavailable');
  if (buffer.length > EXCEL_MAX_INPUT_BYTES) throw new WorkspaceError('Excel workbook exceeds input byte budget');
  inspectZip(buffer, { maxExpandedBytes: EXCEL_MAX_EXPANDED_BYTES });
}

function codeNames(workbook) {
  return {
    workbook: workbook?.Workbook?.WBProps?.CodeName ?? null,
    sheets: (workbook?.SheetNames || []).map((name, index) => ({
      name,
      codeName: workbook?.Workbook?.Sheets?.[index]?.CodeName ?? null,
    })),
  };
}

function bufferFromVba(workbook) {
  const value = workbook?.vbaraw;
  if (!value || typeof value.length !== 'number' || value.length === 0) {
    throw new WorkspaceError('macro-enabled .xlsm input must contain a non-empty VBA project');
  }
  return Buffer.from(value);
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cellAddress(sheetJs, row, col) {
  return sheetJs.utils.encode_cell({ r: row - 1, c: col - 1 });
}

function applySheetJsValues(sheetJs, worksheet, range, values) {
  for (let r = 0; r < range.rows; r++) {
    for (let c = 0; c < range.cols; c++) {
      const address = cellAddress(sheetJs, range.startRow + r, range.startCol + c);
      const value = values[r][c];
      if (value === null) {
        delete worksheet[address];
      } else if (typeof value === 'string') {
        worksheet[address] = { t: 's', v: value };
      } else if (typeof value === 'number') {
        worksheet[address] = { t: 'n', v: value };
      } else if (typeof value === 'boolean') {
        worksheet[address] = { t: 'b', v: value };
      }
    }
  }
  const requested = {
    s: { r: range.startRow - 1, c: range.startCol - 1 },
    e: { r: range.endRow - 1, c: range.endCol - 1 },
  };
  if (!worksheet['!ref']) {
    worksheet['!ref'] = sheetJs.utils.encode_range(requested);
    return;
  }
  const current = sheetJs.utils.decode_range(worksheet['!ref']);
  const union = {
    s: { r: Math.min(current.s.r, requested.s.r), c: Math.min(current.s.c, requested.s.c) },
    e: { r: Math.max(current.e.r, requested.e.r), c: Math.max(current.e.c, requested.e.c) },
  };
  worksheet['!ref'] = sheetJs.utils.encode_range(union);
}

function verifySheetJsRange(sheetJs, workbook, range, expected) {
  const worksheet = workbook?.Sheets?.[range.sheet];
  if (!worksheet) throw new WorkspaceError('target sheet is missing after .xlsm serialization');
  const actual = [];
  for (let r = 0; r < range.rows; r++) {
    const row = [];
    for (let c = 0; c < range.cols; c++) {
      const address = cellAddress(sheetJs, range.startRow + r, range.startCol + c);
      const cell = worksheet[address];
      if (cell?.f !== undefined && cell?.f !== null) {
        throw new WorkspaceError('formula appeared in the requested .xlsm range');
      }
      row.push(cell ? (cell.v ?? null) : null);
    }
    actual.push(row);
  }
  if (!valuesEqual(actual, expected)) throw new WorkspaceError('requested .xlsm range did not round-trip exactly');
}

function preserveMode(source, temp) {
  try {
    const stat = fs.statSync(source);
    fs.chmodSync(temp, stat.mode);
  } catch {}
}

export class ExcelMutationService {
  constructor({ workspaceRegistry, mutationOwner, desktopCommanderChild, sheetJs = DEFAULT_SHEETJS } = {}) {
    this.registry = workspaceRegistry;
    this.owner = mutationOwner;
    this.child = desktopCommanderChild;
    this.sheetJs = sheetJs;
  }

  _requireDependencies() {
    if (!this.registry || !this.owner || !this.child) {
      throw new WorkspaceError('ExcelMutationService dependencies are not configured');
    }
  }

  _target(workspaceId, requestedPath) {
    const requested = requireRelativePath(requestedPath);
    if (isBlockedMutationPath(requested)) throw new WorkspaceError('Excel mutation path is blocked by policy');
    const resolved = this.registry.resolveWritable(workspaceId, requested);
    if (!resolved.exists) throw new WorkspaceError('Excel mutation target does not exist');
    const stat = fs.statSync(resolved.absolute);
    if (!stat.isFile()) throw new WorkspaceError('Excel mutation target must be a regular file');
    if (!samePath(resolved.absolute, resolved.canonical)) {
      throw new WorkspaceError('Excel mutation target may not be a symlink or junction alias');
    }
    const effectiveRel = path.relative(resolved.workspace.root, resolved.canonical);
    if (isBlockedMutationPath(effectiveRel)) throw new WorkspaceError('Excel mutation canonical path is blocked by policy');
    const ext = path.extname(resolved.absolute).toLowerCase();
    if (ext === XLS_EXT) throw new WorkspaceError('legacy .xls mutation is not supported');
    if (ext !== XLSX_EXT && ext !== XLSM_EXT) throw new WorkspaceError('Excel mutation supports only .xlsx and .xlsm');
    return { requested, ...resolved, ext };
  }

  async mutateRange({ workspaceId, path: requestedPath, range: requestedRange, values, expectedBaseSha256 } = {}) {
    this._requireDependencies();
    if (typeof expectedBaseSha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(expectedBaseSha256)) {
      throw new WorkspaceError('expectedBaseSha256 is required');
    }
    const target = this._target(workspaceId, requestedPath);
    const range = parseRange(requestedRange);
    validateValues(values, range);
    const original = fs.readFileSync(target.absolute);
    assertReadableWorkbook(original);
    const baseSha256 = sha256(original);
    if (baseSha256 !== expectedBaseSha256.toLowerCase()) throw new WorkspaceError('stale Excel workbook base hash');

    const unitId = crypto.randomUUID();
    let acquired = false;
    let dispatchAttempted = false;
    let tempFile = null;
    try {
      this.owner.acquire('chatgpt', unitId);
      acquired = true;
      const current = fs.readFileSync(target.absolute);
      assertReadableWorkbook(current);
      if (sha256(current) !== baseSha256) throw new WorkspaceError('stale Excel workbook immediately before mutation');

      let provider;
      if (target.ext === XLSX_EXT) {
        provider = 'desktop-commander-0.2.51';
        tempFile = path.join(path.dirname(target.absolute), '.excel-' + unitId + '-' + process.pid + '.xlsx');
        fs.writeFileSync(tempFile, current);
        preserveMode(target.absolute, tempFile);
        const encoded = values.map((row) => row.map((value) => (
          typeof value === 'string' && value.startsWith('=')
            ? { richText: [{ text: value }] }
            : value
        )));
        dispatchAttempted = true;
        await this.child.editBlock({ filePath: tempFile, range: requestedRange, content: encoded });
      } else {
        provider = 'sheetjs-ce-0.20.3';
        const workbook = this.sheetJs.read(current, {
          type: 'buffer',
          bookVBA: true,
          cellFormula: true,
          cellStyles: true,
          cellNF: true,
        });
        if (!workbook?.SheetNames?.includes(range.sheet)) throw new WorkspaceError('target sheet does not exist');
        const beforeVba = bufferFromVba(workbook);
        const beforeVbaSha256 = sha256(beforeVba);
        const beforeCodeNames = codeNames(workbook);
        const worksheet = workbook.Sheets[range.sheet];
        applySheetJsValues(this.sheetJs, worksheet, range, values);
        const output = Buffer.from(this.sheetJs.write(workbook, {
          type: 'buffer',
          bookType: 'xlsm',
          bookVBA: true,
        }));
        assertReadableWorkbook(output);
        tempFile = path.join(path.dirname(target.absolute), '.excel-' + unitId + '-' + process.pid + '.xlsm');
        fs.writeFileSync(tempFile, output);
        preserveMode(target.absolute, tempFile);
        const verified = this.sheetJs.read(fs.readFileSync(tempFile), {
          type: 'buffer',
          bookVBA: true,
          cellFormula: true,
          cellStyles: true,
          cellNF: true,
        });
        const afterVba = bufferFromVba(verified);
        if (afterVba.length !== beforeVba.length || sha256(afterVba) !== beforeVbaSha256) {
          throw new WorkspaceError('VBA project fidelity guard failed');
        }
        if (JSON.stringify(codeNames(verified)) !== JSON.stringify(beforeCodeNames)) {
          throw new WorkspaceError('VBA code-name fidelity guard failed');
        }
        verifySheetJsRange(this.sheetJs, verified, range, values);
        dispatchAttempted = true;
        fs.renameSync(tempFile, target.absolute);
        tempFile = null;
      }

      const providerReadPath = target.ext === XLSX_EXT
        ? path.relative(target.workspace.root, tempFile)
        : target.requested;
      const resultBytes = fs.readFileSync(target.ext === XLSX_EXT ? tempFile : target.absolute);
      assertReadableWorkbook(resultBytes);
      const readbackResult = await readExcelWithDesktopCommander({
        workspaceId,
        path: providerReadPath,
        mode: 'values',
        sheet: range.sheet,
        range: range.cells,
        maxRows: range.rows,
        maxCells: range.cellsCount,
      }, this.registry, this.child);
      const readback = readbackResult?.structuredContent?.values;
      if (!valuesEqual(readback, values)) throw new WorkspaceError('Excel mutation readback did not match requested values');
      if (target.ext === XLSX_EXT) {
        dispatchAttempted = true;
        fs.renameSync(tempFile, target.absolute);
        tempFile = null;
        const finalReadbackResult = await readExcelWithDesktopCommander({
          workspaceId,
          path: target.requested,
          mode: 'values',
          sheet: range.sheet,
          range: range.cells,
          maxRows: range.rows,
          maxCells: range.cellsCount,
        }, this.registry, this.child);
        const finalReadback = finalReadbackResult?.structuredContent?.values;
        if (!valuesEqual(finalReadback, values)) throw new WorkspaceError('Excel post-replace readback did not match requested values');
      }
      const resultSha256 = sha256(fs.readFileSync(target.absolute));
      this.owner.markUnitState('reconciled');
      this.owner.release();
      acquired = false;
      return {
        operation: 'excel_mutate_range',
        provider,
        path: target.requested,
        range: requestedRange,
        baseSha256,
        resultSha256,
        readback,
        status: 'applied',
      };
    } catch (error) {
      if (tempFile && fs.existsSync(tempFile)) {
        try { fs.rmSync(tempFile, { force: true }); } catch {}
      }
      if (acquired) {
        if (dispatchAttempted) {
          try { this.owner.markUnitState('unknown'); } catch {}
        } else {
          try { this.owner.markUnitState('reconciled'); } catch {}
          try { this.owner.release(); } catch {}
        }
      }
      throw error;
    }
  }
}
