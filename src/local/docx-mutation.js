import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceError } from './workspace.js';
import { isBlockedMutationPath } from './sensitive.js';
import {
  STRUCTURED_READ_LIMITS,
  inspectZip,
  readDocxWithDesktopCommander,
} from './structured-read.js';

const DOCX_EXT = '.docx';
const DOCX_CREATE_INPUT_BYTES = 1024 * 1024;
const DOCX_TEXT_BYTES = 64 * 1024;

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
  if (typeof value !== 'string' || !value.trim()) throw new WorkspaceError('DOCX path must be a non-empty relative path');
  if (value.includes('\0')) throw new WorkspaceError('DOCX path contains a NUL byte');
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
    throw new WorkspaceError('DOCX path must be relative to the primary workspace');
  }
  if (value.replace(/\\/g, '/').split('/').includes('..')) throw new WorkspaceError('DOCX path may not contain traversal components');
  return value;
}

function assertDocxBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > STRUCTURED_READ_LIMITS.docx.inputBytes) {
    throw new WorkspaceError('DOCX exceeds input byte budget');
  }
  const zip = inspectZip(buffer, { maxExpandedBytes: STRUCTURED_READ_LIMITS.docx.expandedBytes });
  if (!zip.names.has('[Content_Types].xml') || !zip.names.has('word/document.xml')) {
    throw new WorkspaceError('DOCX package is missing required entries');
  }
  const doc = zip.entries.find((entry) => entry.name === 'word/document.xml');
  if (!doc || doc.expanded > STRUCTURED_READ_LIMITS.docx.xmlBytes) {
    throw new WorkspaceError('DOCX XML byte budget exceeded');
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function decodeXml(value) {
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

function decodeTextWithRawOffsets(encoded) {
  const source = String(encoded);
  const rawOffsets = [0];
  let text = '';
  let rawIndex = 0;
  while (rawIndex < source.length) {
    const rawStart = rawIndex;
    let decodedChunk;
    if (source[rawIndex] === '&') {
      const entity = source.slice(rawIndex).match(/^&(?:#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/iu);
      if (entity) {
        rawIndex += entity[0].length;
        decodedChunk = decodeXml(entity[0]);
      }
    }
    if (decodedChunk === undefined) {
      const codePoint = source.codePointAt(rawIndex);
      decodedChunk = String.fromCodePoint(codePoint);
      rawIndex += decodedChunk.length;
    }
    text += decodedChunk;
    for (let index = 0; index < decodedChunk.length; index += 1) {
      rawOffsets.push(index === decodedChunk.length - 1 ? rawIndex : rawStart);
    }
  }
  return { text, rawOffsets };
}

function textNodes(xml) {
  const nodes = [];
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/gu;
  let match;
  while ((match = re.exec(String(xml))) !== null) {
    const raw = match[0];
    const close = raw.indexOf('>');
    nodes.push({
      raw,
      open: raw.slice(0, close + 1),
      encoded: match[1],
      text: decodeXml(match[1]),
    });
  }
  return nodes;
}

function paragraphContainers(xml) {
  const paragraphs = [];
  const paragraphRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/gu;
  let paragraphMatch;
  while ((paragraphMatch = paragraphRe.exec(String(xml))) !== null) {
    const raw = paragraphMatch[0];
    const nodes = [];
    const nodeRe = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/gu;
    let nodeMatch;
    let logicalOffset = 0;
    while ((nodeMatch = nodeRe.exec(raw)) !== null) {
      const nodeRaw = nodeMatch[0];
      const close = nodeRaw.indexOf('>');
      const decoded = decodeTextWithRawOffsets(nodeMatch[1]);
      nodes.push({
        raw: nodeRaw,
        open: nodeRaw.slice(0, close + 1),
        encoded: nodeMatch[1],
        text: decoded.text,
        rawOffsets: decoded.rawOffsets,
        rawStart: nodeMatch.index,
        rawEnd: nodeMatch.index + nodeRaw.length,
        logicalStart: logicalOffset,
        logicalEnd: logicalOffset + decoded.text.length,
      });
      logicalOffset += decoded.text.length;
    }
    paragraphs.push({
      raw,
      nodes,
      text: nodes.map((node) => node.text).join(''),
    });
  }
  return paragraphs;
}

function visibleSequence(xml) {
  return textNodes(xml).map((node) => node.text);
}

function visibleParagraphSequence(xml) {
  return paragraphContainers(xml).map((paragraph) => paragraph.text);
}

function findVisibleOccurrences(paragraphs, find) {
  const occurrences = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    let cursor = 0;
    while (cursor <= paragraph.text.length - find.length) {
      const start = paragraph.text.indexOf(find, cursor);
      if (start < 0) break;
      occurrences.push({
        paragraphIndex,
        start,
        end: start + find.length,
      });
      cursor = start + find.length;
    }
  });
  return occurrences;
}

function replaceVisibleText(text, find, replacement) {
  let cursor = 0;
  let output = '';
  while (cursor <= text.length - find.length) {
    const start = text.indexOf(find, cursor);
    if (start < 0) break;
    output += text.slice(cursor, start) + replacement;
    cursor = start + find.length;
  }
  return output + text.slice(cursor);
}

function shapeTextOpen(open, text) {
  if (text && (/^\s/u.test(text) || /\s$/u.test(text)) && !/\bxml:space\s*=/u.test(open)) {
    return open.replace(/>$/u, ' xml:space="preserve">');
  }
  return open;
}

function transformParagraph(paragraph, occurrences, replacement) {
  const editsByNode = new Map();
  for (const occurrence of occurrences) {
    const covered = paragraph.nodes.filter((node) => (
      node.logicalEnd > occurrence.start && node.logicalStart < occurrence.end
    ));
    if (covered.length === 0) {
      throw new WorkspaceError('DOCX visible-text match could not be mapped to text nodes');
    }
    covered.forEach((node, coveredIndex) => {
      const nodeIndex = paragraph.nodes.indexOf(node);
      const localStart = Math.max(occurrence.start, node.logicalStart) - node.logicalStart;
      const localEnd = Math.min(occurrence.end, node.logicalEnd) - node.logicalStart;
      const edits = editsByNode.get(nodeIndex) || [];
      edits.push({
        rawStart: node.rawOffsets[localStart],
        rawEnd: node.rawOffsets[localEnd],
        insert: coveredIndex === 0 ? escapeXml(replacement) : '',
      });
      editsByNode.set(nodeIndex, edits);
    });
  }

  const nodeReplacements = [];
  for (const [nodeIndex, edits] of editsByNode.entries()) {
    const node = paragraph.nodes[nodeIndex];
    let encoded = node.encoded;
    edits.sort((left, right) => right.rawStart - left.rawStart || right.rawEnd - left.rawEnd);
    for (const edit of edits) {
      encoded = encoded.slice(0, edit.rawStart) + edit.insert + encoded.slice(edit.rawEnd);
    }
    const finalText = decodeXml(encoded);
    const newRaw = finalText === ''
      ? node.open.replace(/>$/u, '/>')
      : shapeTextOpen(node.open, finalText) + encoded + '</w:t>';
    if (newRaw !== node.raw) {
      nodeReplacements.push({
        start: node.rawStart,
        end: node.rawEnd,
        newRaw,
      });
    }
  }

  let transformed = paragraph.raw;
  nodeReplacements.sort((left, right) => right.start - left.start);
  for (const replacementItem of nodeReplacements) {
    transformed = transformed.slice(0, replacementItem.start)
      + replacementItem.newRaw
      + transformed.slice(replacementItem.end);
  }
  return transformed;
}

function buildParagraphEditGroups(paragraphs, occurrences, replacement) {
  const occurrencesByParagraph = new Map();
  for (const occurrence of occurrences) {
    const list = occurrencesByParagraph.get(occurrence.paragraphIndex) || [];
    list.push(occurrence);
    occurrencesByParagraph.set(occurrence.paragraphIndex, list);
  }

  const groups = new Map();
  for (const [paragraphIndex, paragraphOccurrences] of occurrencesByParagraph.entries()) {
    const paragraph = paragraphs[paragraphIndex];
    const newString = transformParagraph(paragraph, paragraphOccurrences, replacement);
    const existing = groups.get(paragraph.raw);
    if (existing && existing.newString !== newString) {
      throw new WorkspaceError('DOCX paragraph replacement is ambiguous');
    }
    groups.set(paragraph.raw, {
      oldString: paragraph.raw,
      newString,
      expectedReplacements: (existing?.expectedReplacements || 0) + 1,
    });
  }
  return [...groups.values()];
}

function validateText(value, label, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && value.length === 0)) throw new WorkspaceError(label + ' must be a string');
  if (Buffer.byteLength(value, 'utf8') > DOCX_TEXT_BYTES) throw new WorkspaceError(label + ' exceeds text byte budget');
  return value;
}

function preserveMode(source, temp) {
  try { fs.chmodSync(temp, fs.statSync(source).mode); } catch {}
}

export class DocxMutationService {
  constructor({ workspaceRegistry, mutationOwner, desktopCommanderChild } = {}) {
    this.registry = workspaceRegistry;
    this.owner = mutationOwner;
    this.child = desktopCommanderChild;
  }

  _requireDependencies() {
    if (!this.registry || !this.owner || !this.child) throw new WorkspaceError('DocxMutationService dependencies are not configured');
  }

  _target(workspaceId, requestedPath, { forCreate = false } = {}) {
    const requested = requireRelativePath(requestedPath);
    if (path.extname(requested).toLowerCase() !== DOCX_EXT) throw new WorkspaceError('DOCX mutation supports only .docx');
    if (isBlockedMutationPath(requested)) throw new WorkspaceError('DOCX mutation path is blocked by policy');
    const resolved = this.registry.resolveWritable(workspaceId, requested, { forCreate });
    if (!samePath(resolved.absolute, resolved.canonical)) throw new WorkspaceError('DOCX target may not be a symlink or junction alias');
    const canonicalRel = path.relative(resolved.workspace.root, resolved.canonical);
    if (isBlockedMutationPath(canonicalRel)) throw new WorkspaceError('DOCX canonical path is blocked by policy');
    return { requested, ...resolved };
  }

  async _xml(workspaceId, relPath) {
    const result = await readDocxWithDesktopCommander({
      workspaceId,
      path: relPath,
      mode: 'xml',
      offset: 1,
      maxLines: STRUCTURED_READ_LIMITS.docx.lines,
      maxXmlBytes: STRUCTURED_READ_LIMITS.docx.xmlBytes,
      maxOutputBytes: STRUCTURED_READ_LIMITS.docx.outputBytes,
    }, this.registry, this.child);
    return result?.structuredContent?.xml || '';
  }

  async editText({ workspaceId, path: requestedPath, find, replace, expectedOccurrences = 1, expectedBaseSha256 } = {}) {
    this._requireDependencies();
    find = validateText(find, 'find');
    replace = validateText(replace, 'replace', { empty: true });
    if (find === replace) throw new WorkspaceError('DOCX replacement must change the visible text');
    if (!Number.isInteger(expectedOccurrences) || expectedOccurrences < 1 || expectedOccurrences > 100) {
      throw new WorkspaceError('expectedOccurrences must be an integer from 1 to 100');
    }
    if (typeof expectedBaseSha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(expectedBaseSha256)) {
      throw new WorkspaceError('expectedBaseSha256 is required');
    }
    const target = this._target(workspaceId, requestedPath);
    if (!target.exists || !fs.statSync(target.absolute).isFile()) throw new WorkspaceError('DOCX target must be an existing regular file');
    const original = fs.readFileSync(target.absolute);
    assertDocxBytes(original);
    const baseSha256 = sha256(original);
    if (baseSha256 !== expectedBaseSha256.toLowerCase()) throw new WorkspaceError('stale DOCX base hash');

    const beforeXml = await this._xml(workspaceId, target.requested);
    const beforeParagraphs = paragraphContainers(beforeXml);
    const occurrences = findVisibleOccurrences(beforeParagraphs, find);
    if (occurrences.length !== expectedOccurrences) {
      throw new WorkspaceError('expected ' + expectedOccurrences + ' visible occurrence(s) but found ' + occurrences.length);
    }
    const editGroups = buildParagraphEditGroups(beforeParagraphs, occurrences, replace);
    const expectedParagraphs = beforeParagraphs.map((paragraph) => replaceVisibleText(paragraph.text, find, replace));

    const unitId = crypto.randomUUID();
    const tempName = '.docx-' + unitId + '-' + process.pid + '.docx';
    const tempFile = path.join(path.dirname(target.absolute), tempName);
    const tempRel = path.relative(target.workspace.root, tempFile);
    let acquired = false;
    let renamed = false;
    try {
      this.owner.acquire('chatgpt', unitId);
      acquired = true;
      const current = fs.readFileSync(target.absolute);
      assertDocxBytes(current);
      if (sha256(current) !== baseSha256) throw new WorkspaceError('stale DOCX immediately before mutation');
      fs.writeFileSync(tempFile, current);
      preserveMode(target.absolute, tempFile);

      for (const group of editGroups) {
        await this.child.editBlock({
          filePath: tempFile,
          oldString: group.oldString,
          newString: group.newString,
          expectedReplacements: group.expectedReplacements,
        });
      }

      const tempBytes = fs.readFileSync(tempFile);
      assertDocxBytes(tempBytes);
      const afterXml = await this._xml(workspaceId, tempRel);
      if (JSON.stringify(visibleParagraphSequence(afterXml)) !== JSON.stringify(expectedParagraphs)) {
        throw new WorkspaceError('DOCX visible-text readback did not match requested replacement');
      }

      fs.renameSync(tempFile, target.absolute);
      renamed = true;
      const finalXml = await this._xml(workspaceId, target.requested);
      if (JSON.stringify(visibleParagraphSequence(finalXml)) !== JSON.stringify(expectedParagraphs)) {
        throw new WorkspaceError('DOCX post-replace readback did not match requested replacement');
      }
      const resultSha256 = sha256(fs.readFileSync(target.absolute));
      this.owner.markUnitState('reconciled');
      this.owner.release();
      acquired = false;
      return {
        operation: 'docx_edit_text',
        provider: 'desktop-commander-0.2.51',
        path: target.requested,
        expectedOccurrences,
        baseSha256,
        resultSha256,
        status: 'applied',
      };
    } catch (error) {
      if (fs.existsSync(tempFile)) {
        try { fs.rmSync(tempFile, { force: true }); } catch {}
      }
      if (acquired) {
        if (renamed) {
          try { this.owner.markUnitState('unknown'); } catch {}
        } else {
          try { this.owner.markUnitState('reconciled'); } catch {}
          try { this.owner.release(); } catch {}
        }
      }
      throw error;
    }
  }

  async createText({ workspaceId, path: requestedPath, text } = {}) {
    this._requireDependencies();
    text = validateText(text, 'text', { empty: true });
    if (Buffer.byteLength(text, 'utf8') > DOCX_CREATE_INPUT_BYTES) throw new WorkspaceError('DOCX creation input exceeds byte budget');
    const target = this._target(workspaceId, requestedPath, { forCreate: true });
    if (target.exists) throw new WorkspaceError('DOCX create target already exists');
    const parent = path.dirname(target.absolute);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new WorkspaceError('DOCX create parent directory does not exist');
    const expectedTexts = text.split('\n').map((line) => {
      const heading = line.match(/^(#{1,6})\s+(.+)/u);
      return heading ? heading[2] : line;
    }).filter((line) => line !== '');

    const unitId = crypto.randomUUID();
    const tempName = '.docx-create-' + unitId + '-' + process.pid + '.docx';
    const tempFile = path.join(parent, tempName);
    const tempRel = path.relative(target.workspace.root, tempFile);
    let acquired = false;
    let renamed = false;
    try {
      this.owner.acquire('chatgpt', unitId);
      acquired = true;
      if (fs.existsSync(target.absolute)) throw new WorkspaceError('DOCX create target appeared concurrently');
      await this.child.writeFile({ path: tempFile, content: text, mode: 'rewrite' });
      const tempBytes = fs.readFileSync(tempFile);
      assertDocxBytes(tempBytes);
      const xml = await this._xml(workspaceId, tempRel);
      if (JSON.stringify(visibleSequence(xml)) !== JSON.stringify(expectedTexts)) {
        throw new WorkspaceError('DOCX create visible-text readback did not match input');
      }
      if (fs.existsSync(target.absolute)) throw new WorkspaceError('DOCX create target appeared concurrently');
      fs.renameSync(tempFile, target.absolute);
      renamed = true;
      const finalXml = await this._xml(workspaceId, target.requested);
      if (JSON.stringify(visibleSequence(finalXml)) !== JSON.stringify(expectedTexts)) {
        throw new WorkspaceError('DOCX create post-write readback did not match input');
      }
      const resultSha256 = sha256(fs.readFileSync(target.absolute));
      this.owner.markUnitState('reconciled');
      this.owner.release();
      acquired = false;
      return {
        operation: 'docx_create_text',
        provider: 'desktop-commander-0.2.51',
        path: target.requested,
        resultSha256,
        status: 'applied',
      };
    } catch (error) {
      if (fs.existsSync(tempFile)) {
        try { fs.rmSync(tempFile, { force: true }); } catch {}
      }
      if (acquired) {
        if (renamed) {
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
