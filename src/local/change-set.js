// chatgpt-codex-orchestrator: bounded Direct Local change-set engine (v0.2 M3).
// Two-phase through a single primitive: mode=preview (in-memory, no mutation) and
// mode=apply (atomic write after acquiring chatgpt mutation ownership). Base-hash
// stale-write protection + durable operation state + idempotent replay.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceError } from './workspace.js';
import { isBlockedMutationPath } from './sensitive.js';

export const EDIT_BOUNDS = {
  maxExistingBytes: 256 * 1024,
  maxNewBytes: 64 * 1024,
  maxReplacements: 16,
  maxReplacementBytes: 32 * 1024,
};

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function isBinary(buf) { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) if (buf[i] === 0) return true; return false; }

export class ChangeSetService {
  constructor({ workspaceRegistry, operationState, mutationOwner }) {
    this.registry = workspaceRegistry;
    this.ops = operationState;
    this.owner = mutationOwner;
  }

  _requireOwner() { if (!this.owner) throw new WorkspaceError('shared mutation owner is required for Direct Local mutation'); }

  async preview({ workspaceId, change }) {
    this._requireOwner();
    if (!change || typeof change !== 'object') throw new WorkspaceError('edit requires a change object');
    const { path: relPath, baseHash = null, replacements = [], createContent = null } = change;
    const writeResolved = this.registry.resolveWritable(workspaceId, relPath, { forCreate: createContent !== null });
    const { workspace, absolute, exists } = writeResolved;
    if (isBlockedMutationPath(path.relative(workspace.root, absolute))) throw new WorkspaceError('edit blocked: high-risk/internal/generated path');

    let contentBuf;
    if (exists && createContent === null) {
      const st = fs.statSync(absolute);
      if (st.size > EDIT_BOUNDS.maxExistingBytes) throw new WorkspaceError('file exceeds editable size bound');
      contentBuf = fs.readFileSync(absolute);
      if (isBinary(contentBuf)) throw new WorkspaceError('binary file not editable');
      const actual = sha256(contentBuf);
      if (!baseHash) throw new WorkspaceError('editing an existing file requires baseHash');
      if (actual !== baseHash) throw new WorkspaceError('baseHash mismatch (stale file)');
    } else if (!exists && createContent !== null) {
      contentBuf = Buffer.from(createContent, 'utf8');
      if (contentBuf.length > EDIT_BOUNDS.maxNewBytes) throw new WorkspaceError('new file exceeds size bound');
    } else {
      throw new WorkspaceError('target does not exist and no createContent supplied');
    }

    let content = contentBuf.toString('utf8');
    if (replacements.length) {
      if (replacements.length > EDIT_BOUNDS.maxReplacements) throw new WorkspaceError('too many replacements');
      let inserted = 0;
      for (const r of replacements) {
        if (!r || typeof r.oldText !== 'string' || typeof r.newText !== 'string') throw new WorkspaceError('bad replacement');
        const count = content.split(r.oldText).length - 1;
        if (count !== (r.expectedOccurrences === undefined ? 1 : r.expectedOccurrences)) throw new WorkspaceError(`expectedOccurrences mismatch (${count} found)`);
        inserted += Buffer.byteLength(r.newText, 'utf8');
        content = content.split(r.oldText).join(r.newText);
      }
      if (inserted > EDIT_BOUNDS.maxReplacementBytes) throw new WorkspaceError('replacement text exceeds bound');
    }

    const proposed = Buffer.from(content, 'utf8');
    const proposedHash = sha256(proposed);
    const changeSetId = crypto.randomUUID();
    const diff = buildDiff(exists ? fs.readFileSync(absolute, 'utf8') : '', content);
    this.ops.save(changeSetId, {
      changeSetId, workspaceRoot: workspace.root, path: relPath, baseHash, proposedHash,
      createContent: createContent !== null ? createContent : null, replacements,
      mutationUnitId: changeSetId, status: 'previewed', createdAt: Date.now(), updatedAt: Date.now(),
    });
    return { changeSetId, path: relPath, baseHash, proposedHash, diff, bounds: EDIT_BOUNDS, exists };
  }

  async apply({ workspaceId, changeSetId }) {
    this._requireOwner();
    const op = this.ops.load(changeSetId);
    if (!op) throw new WorkspaceError(`unknown changeSetId: ${changeSetId}`);
    const { workspace, absolute, exists } = this.registry.resolveWritable(workspaceId, op.path, { forCreate: !op.baseHash && op.createContent !== null });
    if (op.workspaceRoot && workspace.root !== op.workspaceRoot) throw new WorkspaceError('workspace changed since preview');

    // Idempotent replay: already applied with matching hash -> return prior result.
    if (op.status === 'applied') {
      const cur = fs.existsSync(absolute) ? fs.readFileSync(absolute) : null;
      if (cur && sha256(cur) === op.proposedHash) return { changeSetId, status: 'applied', path: op.path, resultHash: op.proposedHash, idempotentReplay: true };
      this.ops.update(changeSetId, { status: 'recovery_required', updatedAt: Date.now() });
      throw new WorkspaceError('operation state says applied but target hash differs (recovery required)');
    }
    // If a new file appeared after preview, fail.
    if (!op.baseHash && op.createContent !== null && exists) throw new WorkspaceError('new target appeared after preview (refusing to overwrite)');

    // Acquire shared chatgpt mutation ownership bound to the changeSetId BEFORE any
    // mutation. Fails closed if another owner/unit is active.
    this.owner.acquire('chatgpt', changeSetId);
    this.ops.update(changeSetId, { status: 'applying', updatedAt: Date.now() });
    try {
      // Re-check current base hash for an existing-file edit.
      if (op.baseHash) {
        const cur = fs.readFileSync(absolute);
        if (sha256(cur) !== op.baseHash) { this.ops.update(changeSetId, { status: 'recovery_required', updatedAt: Date.now() }); throw new WorkspaceError('stale file between preview and apply'); }
      }
      const proposed = Buffer.from(op.createContent !== null ? op.createContent : applyReplacements(fs.readFileSync(absolute, 'utf8'), op.replacements), 'utf8');
      const tmp = path.join(path.dirname(absolute), '.edit-' + changeSetId + '.tmp');
      fs.writeFileSync(tmp, proposed);
      fs.renameSync(tmp, absolute);
      const resultHash = sha256(proposed);
      if (resultHash !== op.proposedHash) { this.ops.update(changeSetId, { status: 'recovery_required', updatedAt: Date.now() }); throw new WorkspaceError('result hash does not match previewed proposedHash'); }
      this.ops.update(changeSetId, { status: 'applied', updatedAt: Date.now() });
      this.owner.markUnitState('reconciled');
      this.owner.release();
      return { changeSetId, status: 'applied', path: op.path, resultHash, idempotentReplay: false };
    } catch (e) {
      this.owner.markUnitState('unknown');
      throw e;
    }
  }
}

function applyReplacements(text, replacements) {
  let out = text;
  for (const r of (replacements || [])) out = out.split(r.oldText).join(r.newText);
  return out;
}

function buildDiff(before, after) {
  if (before === after) return '';
  const bl = before.split('\n'); const al = after.split('\n');
  const change = { before: bl.length, after: al.length };
  // Bounded unified-ish diff: show first up-to-80 changed lines.
  let lines = [];
  const max = Math.min(bl.length, al.length);
  for (let i = 0; i < max; i++) if (bl[i] !== al[i]) { lines.push('@@ line ' + (i + 1) + ' @@'); lines.push('- ' + bl[i]); lines.push('+ ' + al[i]); if (lines.length >= 80) break; }
  return { summary: change, body: lines.join('\n') };
}

export { sha256 as computeSha256 };
