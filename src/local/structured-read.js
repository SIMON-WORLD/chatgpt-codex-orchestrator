// Bounded structured local reads for the exact DesktopCommander child.
//
// This module is deliberately a parent-owned policy adapter. It does not
// expose raw upstream arguments, does not parse Office/PDF documents as a
// second engine, and never exposes a mutation path. The parent resolves the
// authorized canonical path, performs cheap signature/container checks, owns
// all budgets, and only then dispatches the exact pinned child read path.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceError } from './workspace.js';
import { isSensitivePath } from './sensitive.js';

export const STRUCTURED_READ_LIMITS = Object.freeze({
  image: Object.freeze({ inputBytes: 32 * 1024 * 1024, outputBytes: 32 * 1024 * 1024 }),
  excel: Object.freeze({
    inputBytes: 10 * 1024 * 1024,
    expandedBytes: 64 * 1024 * 1024,
    outputBytes: 4 * 1024 * 1024,
    rows: 2000,
    cells: 50000,
    results: 100,
    rawChildBytes: 8 * 1024 * 1024,
  }),
  pdf: Object.freeze({
    inputBytes: 32 * 1024 * 1024,
    outputBytes: 12 * 1024 * 1024,
    pages: 32,
    textBytes: 2 * 1024 * 1024,
    images: 32,
    imageBytes: 8 * 1024 * 1024,
    rawChildBytes: 16 * 1024 * 1024,
    timeoutMs: 45 * 1000,
  }),
  docx: Object.freeze({
    inputBytes: 16 * 1024 * 1024,
    expandedBytes: 64 * 1024 * 1024,
    xmlBytes: 4 * 1024 * 1024,
    outputBytes: 4 * 1024 * 1024,
    lines: 10000,
    rawChildBytes: 8 * 1024 * 1024,
    timeoutMs: 30 * 1000,
  }),
});

const IMAGE_SPECS = Object.freeze({
  '.png': Object.freeze({ mimeType: 'image/png' }),
  '.jpg': Object.freeze({ mimeType: 'image/jpeg' }),
  '.jpeg': Object.freeze({ mimeType: 'image/jpeg' }),
  '.gif': Object.freeze({ mimeType: 'image/gif' }),
  '.webp': Object.freeze({ mimeType: 'image/webp' }),
  '.bmp': Object.freeze({ mimeType: 'image/bmp' }),
});
const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xlsm']);
const DOCX_EXTENSIONS = new Set(['.docx']);
const PDF_EXTENSIONS = new Set(['.pdf']);
const ZIP_METHODS = new Set([0, 8]);
const ZIP_EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP_CENTRAL = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const ZIP_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function structuredError(message) {
  return new WorkspaceError('structured read: ' + message);
}

function assertIntegerBudget(value, fallback, hard, label) {
  const selected = value === undefined || value === null ? fallback : value;
  if (!Number.isInteger(selected) || selected <= 0 || selected > hard) {
    throw structuredError(label + ' must be a positive integer <= ' + hard);
  }
  return selected;
}

function assertNonNegativeInteger(value, fallback, hard, label) {
  const selected = value === undefined || value === null ? fallback : value;
  if (!Number.isInteger(selected) || selected < 0 || selected > hard) {
    throw structuredError(label + ' must be a non-negative integer <= ' + hard);
  }
  return selected;
}

function samePath(a, b) {
  const canonical = (value) => {
    try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
  };
  const left = canonical(a);
  const right = canonical(b);
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function safeRelative(root, target) {
  return path.relative(root, target).replace(/\\/g, '/');
}

function assertExtension(validation, allowed) {
  const visible = path.extname(validation.requestedPath).toLowerCase();
  const canonical = path.extname(validation.canonical).toLowerCase();
  if (!allowed.has(visible) || !allowed.has(canonical)) {
    throw structuredError('file extension is not authorized for this structured read');
  }
  return { visible, canonical };
}

export function validateStructuredTarget({
  workspaceId,
  path: requestedPath,
  secondaryReadGrants = [],
  registry,
  allowedExtensions,
  maxInputBytes,
} = {}) {
  if (!registry) throw structuredError('workspace registry is required');
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    throw structuredError('path is required');
  }
  const resolved = registry.resolve(workspaceId, requestedPath, { secondaryReadGrants });
  if (!fs.existsSync(resolved.canonical)) throw structuredError('file not found');
  let stat;
  try {
    stat = fs.statSync(resolved.canonical);
  } catch {
    throw structuredError('file is not readable');
  }
  if (!stat.isFile()) throw structuredError('target is not a regular file');
  if (stat.size > maxInputBytes) throw structuredError('input byte budget exceeded');

  const canonicalRel = safeRelative(resolved.authorizationRoot || resolved.workspace.root, resolved.canonical);
  if (isSensitivePath(requestedPath) || (canonicalRel && isSensitivePath(canonicalRel))) {
    throw structuredError('sensitive path blocked');
  }
  const extension = assertExtension({
    requestedPath,
    canonical: resolved.canonical,
  }, allowedExtensions);
  return {
    ...resolved,
    requestedPath,
    relPath: resolved.external ? resolved.canonical : requestedPath,
    canonical: resolved.canonical,
    size: stat.size,
    extension,
  };
}

function readPathBounded(canonical, maxBytes, { directRegularFile = false } = {}) {
  let stat;
  try { stat = directRegularFile ? fs.lstatSync(canonical) : fs.statSync(canonical); }
  catch { throw structuredError('file disappeared'); }
  if (!stat.isFile()) throw structuredError('target is not a regular file');
  if (stat.size > maxBytes) throw structuredError('input byte budget exceeded');
  let buffer;
  try { buffer = fs.readFileSync(canonical); } catch { throw structuredError('file is not readable'); }
  if (buffer.length > maxBytes) throw structuredError('input byte budget exceeded');
  return buffer;
}

function readBounded(target, maxBytes) {
  return readPathBounded(target.canonical, maxBytes);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function createPrivateSnapshot(sourceBytes, extension) {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-codex-structured-'));
  const snapshotPath = path.join(container, 'source' + extension);
  try {
    if (process.platform !== 'win32') fs.chmodSync(container, 0o700);
    fs.writeFileSync(snapshotPath, sourceBytes, { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(snapshotPath, 0o600);
    return { container, snapshotPath };
  } catch (error) {
    try { fs.rmSync(container, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); } catch {}
    throw structuredError('failed to create private structured-read snapshot');
  }
}

function cleanupPrivateSnapshot(container) {
  try {
    fs.rmSync(container, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  } catch {
    throw structuredError('failed to clean private structured-read snapshot');
  }
  if (fs.existsSync(container)) throw structuredError('failed to clean private structured-read snapshot');
}

function scratchMarkers(scratch) {
  const values = [scratch.container, scratch.snapshotPath];
  const markers = new Set();
  for (const value of values) {
    markers.add(value);
    markers.add(value.replace(/\\/g, '/'));
  }
  return [...markers];
}

function containsScratchPath(value, markers) {
  if (typeof value === 'string') return markers.some((marker) => marker && value.includes(marker));
  if (Array.isArray(value)) return value.some((item) => containsScratchPath(item, markers));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsScratchPath(item, markers));
  return false;
}

function assertNoScratchLeak(value, scratch) {
  if (containsScratchPath(value, scratchMarkers(scratch))) {
    throw structuredError('internal snapshot path leaked from provider output');
  }
}

async function withStableStructuredSnapshot({ target, maxInputBytes, sourceBytes }, operation) {
  const baseSha256 = sha256(sourceBytes);
  const scratch = createPrivateSnapshot(sourceBytes, target.extension.canonical);
  try {
    const beforeProvider = readPathBounded(scratch.snapshotPath, maxInputBytes, { directRegularFile: true });
    if (sha256(beforeProvider) !== baseSha256) throw structuredError('snapshot hash mismatch before provider dispatch');

    const result = await operation({
      snapshotPath: scratch.snapshotPath,
      baseSha256,
      sourceBytes: sourceBytes.length,
    });
    assertNoScratchLeak(result, scratch);

    const afterProvider = readPathBounded(scratch.snapshotPath, maxInputBytes, { directRegularFile: true });
    if (sha256(afterProvider) !== baseSha256) throw structuredError('snapshot changed during structured read');

    const currentSource = readPathBounded(target.canonical, maxInputBytes, { directRegularFile: true });
    if (sha256(currentSource) !== baseSha256) throw structuredError('source changed during structured read');

    assertNoScratchLeak(result, scratch);
    return result;
  } finally {
    cleanupPrivateSnapshot(scratch.container);
  }
}

function hasBytes(buffer, offset, bytes) {
  if (offset < 0 || offset + bytes.length > buffer.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function validPng(buffer) {
  if (!hasBytes(buffer, 0, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
  if (!hasBytes(buffer, 12, Buffer.from('IHDR', 'ascii')) || buffer.length < 33) return false;
  return buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0;
}

function validJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return false;
  for (let i = 2; i + 1 < buffer.length; i++) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) return true;
  }
  return false;
}

function validGif(buffer) {
  if (buffer.length < 14) return false;
  const header = buffer.subarray(0, 6).toString('ascii');
  if (header !== 'GIF87a' && header !== 'GIF89a') return false;
  return buffer[6] !== 0 || buffer[7] !== 0;
}

function validWebp(buffer) {
  if (buffer.length < 16 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
      buffer.subarray(8, 12).toString('ascii') !== 'WEBP') return false;
  const declared = buffer.readUInt32LE(4) + 8;
  return declared <= buffer.length && buffer.subarray(12, 16).toString('ascii').length === 4;
}

function validBmp(buffer) {
  if (buffer.length < 26 || buffer.subarray(0, 2).toString('ascii') !== 'BM') return false;
  const dibSize = buffer.readUInt32LE(14);
  if (![12, 16, 40, 52, 56, 108, 124].includes(dibSize)) return false;
  if (dibSize >= 40) {
    if (buffer.readInt32LE(18) === 0 || buffer.readInt32LE(22) === 0) return false;
  } else if (buffer.readUInt16LE(18) === 0 || buffer.readUInt16LE(20) === 0) {
    return false;
  }
  const offset = buffer.readUInt32LE(10);
  return offset >= 14 + dibSize && offset < buffer.length;
}

function validateImageSignature(buffer, extension) {
  const valid = extension === '.png' ? validPng(buffer)
    : extension === '.jpg' || extension === '.jpeg' ? validJpeg(buffer)
      : extension === '.gif' ? validGif(buffer)
        : extension === '.webp' ? validWebp(buffer)
          : extension === '.bmp' ? validBmp(buffer)
            : false;
  if (!valid) throw structuredError('image signature does not match the extension');
}

function decodeImageBlock(item, expectedMime, maxBytes) {
  if (!item || item.type !== 'image' || typeof item.data !== 'string' || typeof item.mimeType !== 'string') {
    throw structuredError('child returned an invalid image block');
  }
  if (item.mimeType.toLowerCase() !== expectedMime.toLowerCase()) {
    throw structuredError('child image MIME type does not match the validated file');
  }
  if (item.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(item.data)) {
    throw structuredError('child returned invalid base64 image data');
  }
  const bytes = Buffer.from(item.data, 'base64');
  if (bytes.length === 0 || bytes.length > maxBytes || item.data.length > maxBytes * 2) {
    throw structuredError('image output byte budget exceeded');
  }
  return { type: 'image', data: item.data, mimeType: item.mimeType, bytes: bytes.length };
}

function normalizeMcpResult(result, maxRawBytes) {
  if (!result || result.isError) throw structuredError('child rejected the structured read');
  const source = typeof result === 'string'
    ? [{ type: 'text', text: result }]
    : Array.isArray(result.content) ? result.content : [];
  const content = [];
  let rawBytes = 0;
  for (const item of source) {
    if (!item || (item.type !== 'text' && item.type !== 'image')) {
      throw structuredError('child returned an unsupported content block');
    }
    if (item.type === 'text') {
      const text = String(item.text || '');
      rawBytes += Buffer.byteLength(text, 'utf8');
      content.push({ type: 'text', text });
    } else {
      if (typeof item.data !== 'string' || typeof item.mimeType !== 'string') {
        throw structuredError('child returned an invalid image block');
      }
      rawBytes += Buffer.byteLength(item.data, 'utf8');
      const decoded = Buffer.from(item.data, 'base64');
      rawBytes += decoded.length;
      content.push({ type: 'image', data: item.data, mimeType: item.mimeType });
    }
    if (rawBytes > maxRawBytes) throw structuredError('child output byte budget exceeded');
  }
  return content;
}

async function callStructuredChild(child, method, args, timeoutMs, rawBytes) {
  if (!child || typeof child[method] !== 'function') {
    throw structuredError('desktop commander structured child adapter is required');
  }
  let timer;
  let timedOut = false;
  const operation = Promise.resolve().then(() => child[method](args));
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(structuredError('child timeout; generation invalidated'));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([operation, timeout]);
    return normalizeMcpResult(result, rawBytes);
  } catch (error) {
    if (timedOut) {
      try { await child.recoverAfterTimeout?.(); } catch {}
      throw error;
    }
    if (error instanceof WorkspaceError) throw error;
    throw structuredError('child read failed; recovery is required before retry');
  } finally {
    clearTimeout(timer);
    operation.catch(() => {});
  }
}

function textBlocks(content) {
  return content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

function enforceOutput(value, maxBytes) {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > maxBytes) throw structuredError('structured result byte budget exceeded');
  return value;
}

function publicPath(target) {
  return target.external ? target.canonical : target.requestedPath;
}

function zipNameSafe(name) {
  const normalized = name.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) return false;
  return !normalized.split('/').includes('..');
}

export function inspectZip(buffer, { maxExpandedBytes, maxEntries = 4096 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw structuredError('malformed ZIP container');
  const eocd = buffer.lastIndexOf(ZIP_EOCD);
  if (eocd < 0 || eocd + 22 > buffer.length) throw structuredError('malformed ZIP container');
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesDisk = buffer.readUInt16LE(eocd + 8);
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralBytes = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesDisk !== entries ||
      eocd + 22 + commentLength > buffer.length || entries > maxEntries ||
      centralBytes === 0xffffffff || centralOffset === 0xffffffff ||
      centralOffset + centralBytes > eocd) {
    throw structuredError('malformed or unsupported ZIP container');
  }

  const names = new Set();
  const entriesOut = [];
  let cursor = centralOffset;
  let expandedBytes = 0;
  for (let i = 0; i < entries; i++) {
    if (!hasBytes(buffer, cursor, ZIP_CENTRAL) || cursor + 46 > buffer.length) {
      throw structuredError('malformed ZIP central directory');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const expanded = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const comment = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + comment;
    if (end > buffer.length || (flags & 1) !== 0 || !ZIP_METHODS.has(method) ||
        compressed === 0xffffffff || expanded === 0xffffffff) {
      throw structuredError('malformed or unsupported ZIP entry');
    }
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (name.includes('\ufffd') || !zipNameSafe(name) || names.has(name)) {
      throw structuredError('unsafe or malformed ZIP entry name');
    }
    names.add(name);
    if (!hasBytes(buffer, localOffset, ZIP_LOCAL) || localOffset + 30 > buffer.length) {
      throw structuredError('malformed ZIP local header');
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const localName = buffer.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength);
    if (localName !== name || dataStart > buffer.length || dataStart + compressed > buffer.length) {
      throw structuredError('malformed ZIP entry data');
    }
    if (compressed > 0 && expanded / compressed > 200) {
      throw structuredError('ZIP expansion ratio budget exceeded');
    }
    expandedBytes += expanded;
    if (expandedBytes > maxExpandedBytes) throw structuredError('ZIP expanded byte budget exceeded');
    entriesOut.push({ name, compressed, expanded, method });
    cursor = end;
  }
  if (cursor !== centralOffset + centralBytes) throw structuredError('malformed ZIP central directory length');
  return { entries: entriesOut, expandedBytes, names };
}

function requireZipEntry(info, name) {
  if (!info.names.has(name)) throw structuredError('ZIP is missing required entry ' + name);
}

function parseMetadataText(raw, targetSize) {
  const lines = String(raw).split(/\r?\n/u);
  const sheets = [];
  for (const line of lines) {
    const match = line.match(/^\s*\[[0-9]+\]\s+\{\s*name:\s*(.*),\s*rowCount:\s*([0-9]+),\s*colCount:\s*([0-9]+)\s*\}\s*$/u);
    if (!match) continue;
    const name = match[1].trim();
    const rowCount = Number(match[2]);
    const colCount = Number(match[3]);
    if (!name || !Number.isSafeInteger(rowCount) || !Number.isSafeInteger(colCount)) {
      throw structuredError('malformed workbook sheet metadata');
    }
    sheets.push({ name, rowCount, colCount });
  }
  if (sheets.length === 0 || lines.some((line) => /^\s*error:\s*/iu.test(line))) {
    throw structuredError('child did not return bounded workbook metadata');
  }
  return {
    size: targetSize,
    sheets,
  };
}

function parseA1Cell(value) {
  const match = String(value).match(/^([A-Z]{1,4})([1-9][0-9]*)$/u);
  if (!match) throw structuredError('range must use bounded A1 notation');
  let column = 0;
  for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16384 || row > 1048576) throw structuredError('range exceeds spreadsheet bounds');
  return { row, column };
}

function rangeBudget(range) {
  if (range === undefined || range === null || range === '') return null;
  if (typeof range !== 'string' || range.length > 256 || /[\r\n]/u.test(range)) {
    throw structuredError('range is invalid');
  }
  const cellRange = range.includes('!') ? range.slice(range.lastIndexOf('!') + 1) : range;
  const parts = cellRange.split(':');
  if (parts.length > 2) throw structuredError('range is invalid');
  const first = parseA1Cell(parts[0]);
  const last = parseA1Cell(parts[1] || parts[0]);
  if (last.row < first.row || last.column < first.column) throw structuredError('range is reversed');
  return {
    rows: last.row - first.row + 1,
    cells: (last.row - first.row + 1) * (last.column - first.column + 1),
  };
}

function parseExcelValues(raw, maxRows, maxCells) {
  const text = textBlocks(raw);
  let data = null;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== '[' || (i > 0 && text[i - 1] !== '\n')) continue;
    try {
      const candidate = JSON.parse(text.slice(i).trim());
      if (Array.isArray(candidate)) {
        data = candidate;
        break;
      }
    } catch {}
  }
  if (!Array.isArray(data)) throw structuredError('child did not return a bounded worksheet array');
  if (data.length > maxRows) throw structuredError('worksheet row budget exceeded');
  let cells = 0;
  const values = data.map((row) => {
    if (!Array.isArray(row)) throw structuredError('malformed worksheet row');
    cells += row.length;
    if (cells > maxCells) throw structuredError('worksheet cell budget exceeded');
    return row.map((value) => {
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof value === 'object') return structuredClone(value);
      throw structuredError('unsupported worksheet cell value');
    });
  });
  return { values, rows: values.length, cells };
}

export async function readImageWithDesktopCommander(args = {}, registry, child) {
  const maxInputBytes = assertIntegerBudget(args.maxInputBytes, STRUCTURED_READ_LIMITS.image.inputBytes, STRUCTURED_READ_LIMITS.image.inputBytes, 'maxInputBytes');
  const maxOutputBytes = assertIntegerBudget(args.maxOutputBytes, STRUCTURED_READ_LIMITS.image.outputBytes, STRUCTURED_READ_LIMITS.image.outputBytes, 'maxOutputBytes');
  const target = validateStructuredTarget({
    ...args,
    registry,
    allowedExtensions: new Set(Object.keys(IMAGE_SPECS)),
    maxInputBytes,
  });
  const buffer = readBounded(target, maxInputBytes);
  validateImageSignature(buffer, target.extension.canonical);
  const spec = IMAGE_SPECS[target.extension.canonical];
  const rawContent = await callStructuredChild(child, 'readFileStructured', { path: target.canonical, offset: 0, maxLines: 1 }, 30000, maxOutputBytes * 2);
  const imageBlocks = rawContent.filter((item) => item.type === 'image');
  if (imageBlocks.length !== 1) throw structuredError('child did not return exactly one image block');
  const image = decodeImageBlock(imageBlocks[0], spec.mimeType, maxOutputBytes);
  const structuredContent = enforceOutput({
    kind: 'image',
    path: publicPath(target),
    mimeType: image.mimeType,
    bytes: image.bytes,
    sourceBytes: buffer.length,
  }, maxOutputBytes);
  const content = [{ type: 'image', data: image.data, mimeType: image.mimeType }];
  enforceContentBytes(content, Math.max(1, maxOutputBytes - Buffer.byteLength(JSON.stringify(structuredContent), 'utf8')));
  return { structuredContent, content };
}

function validateExcelSource(args, registry) {
  const maxInputBytes = assertIntegerBudget(args.maxInputBytes, STRUCTURED_READ_LIMITS.excel.inputBytes, STRUCTURED_READ_LIMITS.excel.inputBytes, 'maxInputBytes');
  const target = validateStructuredTarget({
    ...args,
    registry,
    allowedExtensions: EXCEL_EXTENSIONS,
    maxInputBytes,
  });
  return { target, maxInputBytes };
}

function preflightExcelBytes(buffer) {
  const zip = inspectZip(buffer, {
    maxExpandedBytes: STRUCTURED_READ_LIMITS.excel.expandedBytes,
  });
  requireZipEntry(zip, '[Content_Types].xml');
  requireZipEntry(zip, 'xl/workbook.xml');
}

function preflightExcel(args, registry) {
  const { target, maxInputBytes } = validateExcelSource(args, registry);
  preflightExcelBytes(readBounded(target, maxInputBytes));
  return { target, maxInputBytes };
}

export async function readExcelWithDesktopCommander(args = {}, registry, child) {
  const mode = args.mode || 'values';
  if (mode !== 'metadata' && mode !== 'values') throw structuredError('Excel mode is metadata or values');
  const maxOutputBytes = assertIntegerBudget(args.maxOutputBytes, STRUCTURED_READ_LIMITS.excel.outputBytes, STRUCTURED_READ_LIMITS.excel.outputBytes, 'maxOutputBytes');
  const maxRows = assertIntegerBudget(args.maxRows, STRUCTURED_READ_LIMITS.excel.rows, STRUCTURED_READ_LIMITS.excel.rows, 'maxRows');
  const maxCells = assertIntegerBudget(args.maxCells, STRUCTURED_READ_LIMITS.excel.cells, STRUCTURED_READ_LIMITS.excel.cells, 'maxCells');
  const { target, maxInputBytes } = validateExcelSource(args, registry);
  const sourceBuffer = readBounded(target, maxInputBytes);
  preflightExcelBytes(sourceBuffer);

  return withStableStructuredSnapshot({ target, maxInputBytes, sourceBytes: sourceBuffer }, async ({ snapshotPath, baseSha256, sourceBytes }) => {
    if (mode === 'metadata') {
      const raw = await callStructuredChild(child, 'getFileInfo', { path: snapshotPath }, 30000, STRUCTURED_READ_LIMITS.excel.rawChildBytes);
      const metadata = parseMetadataText(textBlocks(raw), sourceBytes);
      return {
        structuredContent: enforceOutput({
          kind: 'excel',
          mode,
          path: publicPath(target),
          size: metadata.size,
          baseSha256,
          sheets: metadata.sheets,
        }, maxOutputBytes),
        content: [],
      };
    }
    const range = rangeBudget(args.range);
    if (range && (range.rows > maxRows || range.cells > maxCells)) {
      throw structuredError('requested range exceeds row or cell budget');
    }
    const offset = assertNonNegativeInteger(args.offset, 0, 1048575, 'offset');
    const raw = await callStructuredChild(child, 'readFileStructured', {
      path: snapshotPath,
      offset,
      maxLines: maxRows,
      sheet: args.sheet,
      range: args.range,
    }, 30000, STRUCTURED_READ_LIMITS.excel.rawChildBytes);
    const parsed = parseExcelValues(raw, maxRows, maxCells);
    const result = enforceOutput({
      kind: 'excel',
      mode,
      path: publicPath(target),
      sheet: args.sheet || null,
      range: args.range || null,
      offset,
      rows: parsed.rows,
      cells: parsed.cells,
      values: parsed.values,
      truncated: parsed.rows >= maxRows,
      baseSha256,
    }, maxOutputBytes);
    return { structuredContent: result, content: [] };
  });
}

function parseExcelSearchPage(raw, expectedPath) {
  const results = [];
  const text = textBlocks(raw).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/^📄 (.*):([^:\n]+)!Row([0-9]+)(?::[0-9]+)? - (.*)$/u);
    if (!match) continue;
    let file;
    try { file = fs.realpathSync.native(match[1]); } catch { continue; }
    if (!samePath(file, expectedPath)) continue;
    results.push({
      sheet: match[2],
      row: Number(match[3]),
      snippet: match[4].slice(0, 100),
    });
  }
  const complete = /COMPLETED|Search completed/iu.test(text);
  const hasMore = /More results available/iu.test(text);
  const sessionMatch = text.match(/(?:Started content search session|Search session):\s*([^\n]+)/iu);
  return { results, complete, hasMore, sessionId: sessionMatch ? sessionMatch[1].trim() : null };
}

export async function searchExcelWithDesktopCommander(args = {}, registry, child) {
  const maxResults = assertIntegerBudget(args.maxResults, STRUCTURED_READ_LIMITS.excel.results, STRUCTURED_READ_LIMITS.excel.results, 'maxResults');
  const maxOutputBytes = assertIntegerBudget(args.maxOutputBytes, STRUCTURED_READ_LIMITS.excel.outputBytes, STRUCTURED_READ_LIMITS.excel.outputBytes, 'maxOutputBytes');
  if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 512) {
    throw structuredError('query is required and bounded');
  }
  const preflight = preflightExcel(args, registry);
  const target = preflight.target;
  const start = await callStructuredChild(child, 'startSearch', {
    path: target.canonical,
    pattern: args.query,
    searchType: 'content',
    filePattern: path.basename(target.canonical),
    ignoreCase: args.ignoreCase !== false,
    maxResults,
    includeHidden: false,
    contextLines: 0,
    timeout_ms: 30000,
    literalSearch: true,
    origin: 'llm',
  }, 30000, STRUCTURED_READ_LIMITS.excel.rawChildBytes);
  let page = parseExcelSearchPage(start, target.canonical);
  const sessionId = page.sessionId;
  if (!sessionId) throw structuredError('child did not return a search session');
  const matches = [];
  let offset = page.results.length;
  try {
    for (let attempt = 0; attempt < 20 && matches.length < maxResults; attempt++) {
      matches.push(...page.results.slice(0, maxResults - matches.length));
      if (matches.length >= maxResults || (page.complete && !page.hasMore && attempt > 0)) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
      page = parseExcelSearchPage(await callStructuredChild(child, 'getMoreSearchResults', {
        sessionId,
        offset,
        length: maxResults,
      }, 30000, STRUCTURED_READ_LIMITS.excel.rawChildBytes), target.canonical);
      offset += page.results.length;
    }
  } finally {
    try { await child.stopSearch({ sessionId }); } catch {}
  }
  const result = enforceOutput({
    kind: 'excel-search',
    path: publicPath(target),
    query: args.query,
    matches: matches.slice(0, maxResults),
    truncated: matches.length >= maxResults || !page.complete || page.hasMore,
  }, maxOutputBytes);
  return { structuredContent: result, content: [] };
}

function preflightPdf(args, registry) {
  const maxInputBytes = assertIntegerBudget(args.maxInputBytes, STRUCTURED_READ_LIMITS.pdf.inputBytes, STRUCTURED_READ_LIMITS.pdf.inputBytes, 'maxInputBytes');
  const target = validateStructuredTarget({
    ...args,
    registry,
    allowedExtensions: PDF_EXTENSIONS,
    maxInputBytes,
  });
  const sourceBuffer = readBounded(target, maxInputBytes);
  if (!hasBytes(sourceBuffer, 0, Buffer.from('%PDF-', 'ascii'))) throw structuredError('PDF signature mismatch');
  return { target, maxInputBytes, sourceBuffer };
}

function parsePdfContent(raw, pageOffset, pageCount, maxTextBytes, maxImages, maxImageBytes, includeImages) {
  const pages = [];
  const pendingImages = [];
  let imageCount = 0;
  let textBytes = 0;
  let imageBytes = 0;
  for (const item of raw) {
    if (item.type === 'image') {
      pendingImages.push(item);
      continue;
    }
    const match = item.text.match(/<!-- Page:\s*([0-9]+)\s*-->\s*([\s\S]*)/iu);
    if (!match) {
      if (/^Error reading PDF:/iu.test(item.text.trim())) throw structuredError('child rejected malformed PDF');
      continue;
    }
    const pageNumber = Number(match[1]);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) throw structuredError('child returned malformed PDF page number');
    const text = match[2];
    textBytes += Buffer.byteLength(text, 'utf8');
    if (textBytes > maxTextBytes) throw structuredError('PDF text byte budget exceeded');
    const images = [];
    for (const image of pendingImages.splice(0)) {
      imageCount += 1;
      if (imageCount > maxImages) throw structuredError('PDF image count budget exceeded');
      if (!/^image\/(?:png|jpeg|gif|webp|bmp)$/iu.test(image.mimeType)) {
        throw structuredError('child returned an unsupported PDF image MIME type');
      }
      const decoded = decodeImageBlock(image, image.mimeType, maxImageBytes);
      imageBytes += decoded.bytes;
      if (imageBytes > maxImageBytes) throw structuredError('PDF image byte budget exceeded');
      if (includeImages) images.push({ type: 'image', data: decoded.data, mimeType: decoded.mimeType, bytes: decoded.bytes });
    }
    pages.push({ pageNumber, text, images });
  }
  if (pendingImages.length > 0) throw structuredError('PDF image output was not attached to a page');
  if (pages.length === 0) throw structuredError('child returned no bounded PDF pages');
  if (pages.length > pageCount) throw structuredError('PDF page budget exceeded');
  for (const page of pages) {
    if (page.pageNumber < pageOffset + 1 || page.pageNumber > pageOffset + pageCount) {
      throw structuredError('child returned a page outside the requested range');
    }
  }
  return pages;
}

function enforceContentBytes(content, maxBytes) {
  let bytes = 0;
  for (const item of content) {
    bytes += item.type === 'text'
      ? Buffer.byteLength(item.text || '', 'utf8')
      : Buffer.byteLength(item.data || '', 'utf8');
    if (bytes > maxBytes) throw structuredError('structured result byte budget exceeded');
  }
}

export async function readPdfWithDesktopCommander(args = {}, registry, child) {
  const maxPages = assertIntegerBudget(args.pageCount, STRUCTURED_READ_LIMITS.pdf.pages, STRUCTURED_READ_LIMITS.pdf.pages, 'pageCount');
  const pageOffset = assertNonNegativeInteger(args.pageOffset, 0, 1000000, 'pageOffset');
  const maxTextBytes = assertIntegerBudget(args.maxTextBytes, STRUCTURED_READ_LIMITS.pdf.textBytes, STRUCTURED_READ_LIMITS.pdf.textBytes, 'maxTextBytes');
  const maxImages = assertIntegerBudget(args.maxImages, STRUCTURED_READ_LIMITS.pdf.images, STRUCTURED_READ_LIMITS.pdf.images, 'maxImages');
  const maxImageBytes = assertIntegerBudget(args.maxImageBytes, STRUCTURED_READ_LIMITS.pdf.imageBytes, STRUCTURED_READ_LIMITS.pdf.imageBytes, 'maxImageBytes');
  const maxOutputBytes = assertIntegerBudget(args.maxOutputBytes, STRUCTURED_READ_LIMITS.pdf.outputBytes, STRUCTURED_READ_LIMITS.pdf.outputBytes, 'maxOutputBytes');
  const timeoutMs = assertIntegerBudget(args.timeoutMs, STRUCTURED_READ_LIMITS.pdf.timeoutMs, STRUCTURED_READ_LIMITS.pdf.timeoutMs, 'timeoutMs');
  const { target, maxInputBytes, sourceBuffer } = preflightPdf(args, registry);
  const includeImages = args.includeImages !== false;
  return withStableStructuredSnapshot({ target, maxInputBytes, sourceBytes: sourceBuffer }, async ({ snapshotPath, baseSha256 }) => {
    const raw = await callStructuredChild(child, 'readFileStructured', {
      path: snapshotPath,
      offset: pageOffset,
      maxLines: maxPages,
    }, timeoutMs, STRUCTURED_READ_LIMITS.pdf.rawChildBytes);
    const pages = parsePdfContent(raw, pageOffset, maxPages, maxTextBytes, maxImages, maxImageBytes, includeImages);
    const publicPages = pages.map((page) => ({
      pageNumber: page.pageNumber,
      text: page.text,
      images: page.images.map((image) => ({ mimeType: image.mimeType, bytes: image.bytes })),
    }));
    const result = enforceOutput({
      kind: 'pdf',
      path: publicPath(target),
      pageOffset,
      pageCount: publicPages.length,
      pages: publicPages,
      baseSha256,
    }, maxOutputBytes);
    const content = [];
    for (const page of pages) {
      if (includeImages) content.push(...page.images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType })));
      content.push({ type: 'text', text: '<!-- Page: ' + page.pageNumber + ' -->\n' + page.text });
    }
    const structuredBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    enforceContentBytes(content, Math.max(1, maxOutputBytes - structuredBytes));
    return { structuredContent: result, content };
  });
}

function preflightDocx(args, registry, maxXmlBytes) {
  const maxInputBytes = assertIntegerBudget(args.maxInputBytes, STRUCTURED_READ_LIMITS.docx.inputBytes, STRUCTURED_READ_LIMITS.docx.inputBytes, 'maxInputBytes');
  const target = validateStructuredTarget({
    ...args,
    registry,
    allowedExtensions: DOCX_EXTENSIONS,
    maxInputBytes,
  });
  const sourceBuffer = readBounded(target, maxInputBytes);
  const zip = inspectZip(sourceBuffer, {
    maxExpandedBytes: STRUCTURED_READ_LIMITS.docx.expandedBytes,
  });
  requireZipEntry(zip, '[Content_Types].xml');
  requireZipEntry(zip, 'word/document.xml');
  const documentEntry = zip.entries.find((entry) => entry.name === 'word/document.xml');
  if (!documentEntry || documentEntry.expanded > maxXmlBytes) {
    throw structuredError('DOCX XML byte budget exceeded');
  }
  return { target, maxInputBytes, sourceBuffer };
}

function stripDocxMutationHints(text) {
  return String(text)
    .replace(/^Edit with:.*$/gim, '')
    .replace(/^Raw XML:.*$/gim, '')
    .replace(/For bulk changes[\s\S]*$/im, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseDocxOutline(text) {
  const clean = stripDocxMutationHints(text);
  const header = clean.match(/DOCX Outline:\s*([0-9]+) body children,\s*([0-9]+) paragraphs,\s*([0-9]+) tables,\s*([0-9]+) images/iu);
  if (!header) throw structuredError('child did not return a bounded DOCX outline');
  return {
    outline: clean,
    bodyChildren: Number(header[1]),
    paragraphs: Number(header[2]),
    tables: Number(header[3]),
    images: Number(header[4]),
  };
}

export async function readDocxWithDesktopCommander(args = {}, registry, child) {
  const mode = args.mode || 'outline';
  if (!['outline', 'xml', 'info'].includes(mode)) throw structuredError('DOCX mode is outline, xml, or info');
  const maxOutputBytes = assertIntegerBudget(args.maxOutputBytes, STRUCTURED_READ_LIMITS.docx.outputBytes, STRUCTURED_READ_LIMITS.docx.outputBytes, 'maxOutputBytes');
  const maxXmlBytes = assertIntegerBudget(args.maxXmlBytes, STRUCTURED_READ_LIMITS.docx.xmlBytes, STRUCTURED_READ_LIMITS.docx.xmlBytes, 'maxXmlBytes');
  const maxLines = assertIntegerBudget(args.maxLines, STRUCTURED_READ_LIMITS.docx.lines, STRUCTURED_READ_LIMITS.docx.lines, 'maxLines');
  const timeoutMs = assertIntegerBudget(args.timeoutMs, STRUCTURED_READ_LIMITS.docx.timeoutMs, STRUCTURED_READ_LIMITS.docx.timeoutMs, 'timeoutMs');
  const { target, maxInputBytes, sourceBuffer } = preflightDocx(args, registry, maxXmlBytes);

  return withStableStructuredSnapshot({ target, maxInputBytes, sourceBytes: sourceBuffer }, async ({ snapshotPath, baseSha256, sourceBytes }) => {
    if (mode === 'xml') {
      const requestedOffset = assertNonNegativeInteger(args.offset, 1, maxLines - 1, 'offset');
      // DesktopCommander 0.2.51 intentionally selects its raw XML child path
      // only for a non-zero offset. Offset 1 is therefore the bounded raw-read
      // entry point; the returned typed offset records that child semantic.
      const childOffset = Math.max(1, requestedOffset);
      const raw = await callStructuredChild(child, 'readFileStructured', {
        path: snapshotPath,
        offset: childOffset,
        maxLines,
      }, timeoutMs, STRUCTURED_READ_LIMITS.docx.rawChildBytes);
      const text = textBlocks(raw);
      const xml = text.replace(/^\[DOCX XML:[^\n]*\]\n?/iu, '').trim();
      if (!xml || Buffer.byteLength(xml, 'utf8') > maxXmlBytes) throw structuredError('DOCX XML byte budget exceeded');
      if (xml.split(/\r?\n/u).length > maxLines) throw structuredError('DOCX XML line budget exceeded');
      const result = enforceOutput({
        kind: 'docx',
        mode,
        path: publicPath(target),
        offset: childOffset,
        xml,
        truncated: true,
        baseSha256,
      }, maxOutputBytes);
      const content = [{ type: 'text', text: xml }];
      enforceContentBytes(content, Math.max(1, maxOutputBytes - Buffer.byteLength(JSON.stringify(result), 'utf8')));
      return { structuredContent: result, content };
    }

    const raw = await callStructuredChild(child, 'readFileStructured', {
      path: snapshotPath,
      offset: 0,
      maxLines,
    }, timeoutMs, STRUCTURED_READ_LIMITS.docx.rawChildBytes);
    const outline = parseDocxOutline(textBlocks(raw));
    const base = {
      kind: 'docx',
      mode,
      path: publicPath(target),
      compressedBytes: sourceBytes,
      baseSha256,
      bodyChildren: outline.bodyChildren,
      paragraphs: outline.paragraphs,
      tables: outline.tables,
      images: outline.images,
    };
    const result = mode === 'info'
      ? enforceOutput(base, maxOutputBytes)
      : enforceOutput({ ...base, outline: outline.outline }, maxOutputBytes);
    const content = mode === 'outline' ? [{ type: 'text', text: outline.outline }] : [];
    enforceContentBytes(content, Math.max(1, maxOutputBytes - Buffer.byteLength(JSON.stringify(result), 'utf8')));
    return { structuredContent: result, content };
  });
}
