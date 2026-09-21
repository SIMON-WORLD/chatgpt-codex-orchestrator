import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceError } from './workspace.js';
import { isBlockedMutationPath } from './sensitive.js';
import { STRUCTURED_READ_LIMITS, readPdfWithDesktopCommander } from './structured-read.js';

const PDF_EXT = '.pdf';
const MAX_OPERATIONS = 16;
const MAX_PAGES = STRUCTURED_READ_LIMITS.pdf.pages;

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
  if (typeof value !== 'string' || !value.trim()) throw new WorkspaceError('PDF destination path must be a non-empty relative path');
  if (value.includes('\0')) throw new WorkspaceError('PDF destination path contains a NUL byte');
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) throw new WorkspaceError('PDF destination must be inside the primary workspace');
  if (value.replace(/\\/g, '/').split('/').includes('..')) throw new WorkspaceError('PDF destination path may not contain traversal components');
  return value;
}

function preserveMode(source, temp) {
  try { fs.chmodSync(temp, fs.statSync(source).mode); } catch {}
}

export class PdfMutationService {
  constructor({ workspaceRegistry, mutationOwner, desktopCommanderChild } = {}) {
    this.registry = workspaceRegistry;
    this.owner = mutationOwner;
    this.child = desktopCommanderChild;
  }

  _requireDependencies() {
    if (!this.registry || !this.owner || !this.child) throw new WorkspaceError('PdfMutationService dependencies are not configured');
  }

  _destination(workspaceId, requestedPath) {
    const requested = requireRelativePath(requestedPath);
    if (path.extname(requested).toLowerCase() !== PDF_EXT) throw new WorkspaceError('PDF mutation supports only .pdf');
    if (isBlockedMutationPath(requested)) throw new WorkspaceError('PDF destination path is blocked by policy');
    const resolved = this.registry.resolveWritable(workspaceId, requested);
    if (!resolved.exists || !fs.statSync(resolved.absolute).isFile()) throw new WorkspaceError('PDF destination must be an existing regular file');
    if (!samePath(resolved.absolute, resolved.canonical)) throw new WorkspaceError('PDF destination may not be a symlink or junction alias');
    const canonicalRel = path.relative(resolved.workspace.root, resolved.canonical);
    if (isBlockedMutationPath(canonicalRel)) throw new WorkspaceError('PDF canonical destination is blocked by policy');
    return { requested, ...resolved };
  }

  async _pageCount(workspaceId, requestedPath, secondaryReadGrants = []) {
    const first = await readPdfWithDesktopCommander({
      workspaceId,
      path: requestedPath,
      secondaryReadGrants,
      pageOffset: 0,
      pageCount: MAX_PAGES,
      includeImages: false,
      maxTextBytes: STRUCTURED_READ_LIMITS.pdf.textBytes,
      maxImages: STRUCTURED_READ_LIMITS.pdf.images,
      maxImageBytes: STRUCTURED_READ_LIMITS.pdf.imageBytes,
      maxOutputBytes: STRUCTURED_READ_LIMITS.pdf.outputBytes,
      timeoutMs: STRUCTURED_READ_LIMITS.pdf.timeoutMs,
    }, this.registry, this.child);
    const count = first?.structuredContent?.pageCount ?? 0;
    if (count === MAX_PAGES) {
      const extra = await readPdfWithDesktopCommander({
        workspaceId,
        path: requestedPath,
        secondaryReadGrants,
        pageOffset: MAX_PAGES - 1,
        pageCount: 2,
        includeImages: false,
        maxTextBytes: STRUCTURED_READ_LIMITS.pdf.textBytes,
        maxImages: STRUCTURED_READ_LIMITS.pdf.images,
        maxImageBytes: STRUCTURED_READ_LIMITS.pdf.imageBytes,
        maxOutputBytes: STRUCTURED_READ_LIMITS.pdf.outputBytes,
        timeoutMs: STRUCTURED_READ_LIMITS.pdf.timeoutMs,
      }, this.registry, this.child);
      if ((extra?.structuredContent?.pageCount ?? 0) > 1) throw new WorkspaceError('PDF page count exceeds mutation budget');
    }
    if (count < 1) throw new WorkspaceError('PDF must contain at least one page');
    return count;
  }

  async _normalizeOperations(workspaceId, operations, initialPages) {
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPERATIONS) {
      throw new WorkspaceError('PDF operations must contain 1 to ' + MAX_OPERATIONS + ' bounded operations');
    }
    const grants = this.registry.getSecondaryReadGrants(workspaceId);
    const normalized = [];
    let pages = initialPages;

    for (const operation of operations) {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
        throw new WorkspaceError('PDF operation must be a typed object');
      }
      if (operation.type === 'delete_pages') {
        if (!Array.isArray(operation.pages) || operation.pages.length < 1 || operation.pages.length > MAX_PAGES) {
          throw new WorkspaceError('delete_pages requires a bounded pages array');
        }
        const unique = [...new Set(operation.pages)];
        if (unique.length !== operation.pages.length || unique.some((page) => !Number.isInteger(page) || page < 1 || page > pages)) {
          throw new WorkspaceError('delete_pages uses unique 1-based pages within the current document');
        }
        if (pages - unique.length < 1) throw new WorkspaceError('PDF mutation may not delete every page');
        normalized.push({ type: 'delete', pageIndexes: unique.map((page) => page - 1) });
        pages -= unique.length;
        continue;
      }

      if (operation.type === 'insert_pdf') {
        if (!Number.isInteger(operation.atPage) || operation.atPage < 1 || operation.atPage > pages + 1) {
          throw new WorkspaceError('insert_pdf atPage is a 1-based insertion position');
        }
        if (typeof operation.sourcePath !== 'string' || !operation.sourcePath.trim()) {
          throw new WorkspaceError('insert_pdf requires sourcePath');
        }
        const source = this.registry.resolve(workspaceId, operation.sourcePath, { secondaryReadGrants: grants });
        if (!fs.existsSync(source.canonical) || !fs.statSync(source.canonical).isFile()) throw new WorkspaceError('PDF source must be a readable regular file');
        if (path.extname(source.canonical).toLowerCase() !== PDF_EXT) throw new WorkspaceError('PDF insert source must be .pdf');
        const sourceRel = path.relative(source.authorizationRoot || source.workspace.root, source.canonical);
        if (isBlockedMutationPath(operation.sourcePath) || (sourceRel && isBlockedMutationPath(sourceRel))) {
          throw new WorkspaceError('PDF insert source is blocked by policy');
        }
        const sourcePages = await this._pageCount(workspaceId, operation.sourcePath, grants);
        if (pages + sourcePages > MAX_PAGES) throw new WorkspaceError('PDF result page count exceeds mutation budget');
        normalized.push({ type: 'insert', pageIndex: operation.atPage - 1, sourcePdfPath: source.canonical });
        pages += sourcePages;
        continue;
      }

      throw new WorkspaceError('PDF operation type must be delete_pages or insert_pdf; markdown/browser creation is not authorized');
    }
    return { normalized, expectedPages: pages };
  }

  async mutatePages({ workspaceId, path: requestedPath, operations, expectedBaseSha256 } = {}) {
    this._requireDependencies();
    if (typeof expectedBaseSha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(expectedBaseSha256)) {
      throw new WorkspaceError('expectedBaseSha256 is required');
    }
    const target = this._destination(workspaceId, requestedPath);
    const original = fs.readFileSync(target.absolute);
    if (original.length > STRUCTURED_READ_LIMITS.pdf.inputBytes) throw new WorkspaceError('PDF destination exceeds input byte budget');
    const baseSha256 = sha256(original);
    if (baseSha256 !== expectedBaseSha256.toLowerCase()) throw new WorkspaceError('stale PDF base hash');
    const initialPages = await this._pageCount(workspaceId, target.requested);
    const { normalized, expectedPages } = await this._normalizeOperations(workspaceId, operations, initialPages);

    const unitId = crypto.randomUUID();
    const tempName = '.pdf-' + unitId + '-' + process.pid + '.pdf';
    const tempFile = path.join(path.dirname(target.absolute), tempName);
    const tempRel = path.relative(target.workspace.root, tempFile);
    let acquired = false;
    let renamed = false;
    try {
      this.owner.acquire('chatgpt', unitId);
      acquired = true;
      const current = fs.readFileSync(target.absolute);
      if (current.length > STRUCTURED_READ_LIMITS.pdf.inputBytes || sha256(current) !== baseSha256) {
        throw new WorkspaceError('stale PDF immediately before mutation');
      }
      await this.child.writePdf({ path: target.absolute, operations: normalized, outputPath: tempFile });
      if (!fs.existsSync(tempFile)) throw new WorkspaceError('PDF provider did not create bounded output');
      const tempBytes = fs.readFileSync(tempFile);
      if (tempBytes.length > STRUCTURED_READ_LIMITS.pdf.outputBytes) throw new WorkspaceError('PDF output exceeds output byte budget');
      preserveMode(target.absolute, tempFile);
      const tempPages = await this._pageCount(workspaceId, tempRel);
      if (tempPages !== expectedPages) throw new WorkspaceError('PDF temp readback page count mismatch');

      fs.renameSync(tempFile, target.absolute);
      renamed = true;
      const finalPages = await this._pageCount(workspaceId, target.requested);
      if (finalPages !== expectedPages) throw new WorkspaceError('PDF post-replace page count mismatch');
      const resultSha256 = sha256(fs.readFileSync(target.absolute));
      this.owner.markUnitState('reconciled');
      this.owner.release();
      acquired = false;
      return {
        operation: 'pdf_mutate_pages',
        provider: 'desktop-commander-0.2.51',
        path: target.requested,
        baseSha256,
        resultSha256,
        pageCount: finalPages,
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
