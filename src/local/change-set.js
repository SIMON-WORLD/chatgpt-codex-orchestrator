// chatgpt-codex-orchestrator: bounded Direct Local change-set engine (v0.2 M3).
// Two-phase through a single primitive: preview (in-memory) and apply (atomic write
// after acquiring chatgpt mutation ownership). Base-hash stale-write protection,
// durable operation state, idempotent replay, and conservative ownership lifecycle
// (pre-mutation failures reconcile+release; post-mutation-start failures leave
// owner unknown + recovery_required, no silent release).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceError } from './workspace.js';
import { isBlockedMutationPath } from './sensitive.js';

export const EDIT_BOUNDS = {
  maxExistingBytes: 256 * 1024,
  maxNewBytes: 64 * 1024,
  maxReplacements: 16,
  maxReplacementOccurrences: 16,
  maxExpectedOccurrences: 16,
  maxReplacementBytes: 32 * 1024,
  maxTimeoutMs: 120000,
};

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function isBinary(buf) { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) if (buf[i] === 0) return true; return false; }

function validateTimeout(value, def) {
  if (value === undefined || value === null) return def;
  if (!Number.isInteger(value) || value <= 0 || value > EDIT_BOUNDS.maxTimeoutMs) throw new WorkspaceError('verify timeoutMs must be a positive integer <= ' + EDIT_BOUNDS.maxTimeoutMs);
  return value;
}

export class ChangeSetService {
  constructor({ workspaceRegistry, operationState, mutationOwner }) {
    this.registry = workspaceRegistry;
    this.ops = operationState;
    this.owner = mutationOwner;
  }
  _requireOwner() { if (!this.owner) throw new WorkspaceError('shared mutation owner is required for Direct Local mutation'); }

  _computePlanForPreview(change, absolute, exists) {
    const { path: relPath, baseHash = null, replacements = [], createContent = null } = change;
    const forCreate = createContent !== null;
    if (forCreate) {
      if (exists) throw new WorkspaceError('create target must not already exist');
      if (baseHash !== null && baseHash !== undefined) throw new WorkspaceError('create requires baseHash to be null');
      if (replacements && replacements.length) throw new WorkspaceError('create cannot be combined with replacements');
      const buf = Buffer.from(createContent, 'utf8');
      if (buf.length > EDIT_BOUNDS.maxNewBytes) throw new WorkspaceError('new file exceeds size bound');
      if (isBinary(buf)) throw new WorkspaceError('binary not supported');
      return { existing: null, proposed: buf, baseHash: null, createContent, replacements: [] };
    }
    if (!exists) throw new WorkspaceError('target does not exist and no createContent supplied');
    if (createContent !== null && createContent !== undefined) throw new WorkspaceError('existing-file edit cannot supply createContent');
    if (!baseHash) throw new WorkspaceError('editing an existing file requires baseHash');
    const st = fs.statSync(absolute);
    if (st.size > EDIT_BOUNDS.maxExistingBytes) throw new WorkspaceError('file exceeds editable size bound');
    const existing = fs.readFileSync(absolute);
    if (isBinary(existing)) throw new WorkspaceError('binary file not editable');
    if (sha256(existing) !== baseHash) throw new WorkspaceError('baseHash mismatch (stale file)');

    let content = existing.toString('utf8');
    if (replacements && replacements.length) {
      if (replacements.length > EDIT_BOUNDS.maxReplacements) throw new WorkspaceError('too many replacement specs');
      let totalOccurrences = 0;
      let totalBytes = 0;
      for (const r of replacements) {
        if (!r || typeof r.oldText !== 'string') throw new WorkspaceError('bad replacement');
        if (!r.oldText) throw new WorkspaceError('oldText must be non-empty');
        if (typeof r.newText !== 'string') throw new WorkspaceError('replacement newText must be a string');
        const expected = r.expectedOccurrences === undefined ? 1 : r.expectedOccurrences;
        if (!Number.isInteger(expected) || expected <= 0 || expected > EDIT_BOUNDS.maxExpectedOccurrences) throw new WorkspaceError('expectedOccurrences must be a positive integer <= ' + EDIT_BOUNDS.maxExpectedOccurrences);
        const count = content.split(r.oldText).length - 1;
        if (count !== expected) throw new WorkspaceError(`expectedOccurrences mismatch (${count} found)`);
        totalOccurrences += count;
        totalBytes += Buffer.byteLength(r.newText, 'utf8') * count;
      }
      if (totalOccurrences > EDIT_BOUNDS.maxReplacements) throw new WorkspaceError('total actual replacements exceeds bound');
      if (totalBytes > EDIT_BOUNDS.maxReplacementBytes) throw new WorkspaceError('replacement text budget exceeds bound');
      for (const r of replacements) content = content.split(r.oldText).join(r.newText);
    }
    const proposed = Buffer.from(content, 'utf8');
    if (proposed.length > EDIT_BOUNDS.maxExistingBytes) throw new WorkspaceError('proposed file exceeds 256 KiB bound');
    return { existing, proposed, baseHash, createContent: null, replacements };
  }

  async preview({ workspaceId, change }) {
    this._requireOwner();
    if (!change || typeof change !== 'object') throw new WorkspaceError('edit requires a change object');
    const relPath = change.path;
    const createProvided = change.createContent !== undefined && change.createContent !== null;
    const writeResolved = this.registry.resolveWritable(workspaceId, relPath, { forCreate: createProvided });
    const { workspace, absolute, exists } = writeResolved;
    if (isBlockedMutationPath(path.relative(workspace.root, absolute))) throw new WorkspaceError('edit blocked: high-risk/internal/generated path');
    const plan = this._computePlanForPreview(change, absolute, exists);
    const proposedHash = sha256(plan.proposed);
    const changeSetId = crypto.randomUUID();
    const diff = buildDiff(plan.existing ? plan.existing.toString('utf8') : '', plan.proposed.toString('utf8'));
    this.ops.save(changeSetId, {
      changeSetId, workspaceRoot: workspace.root, path: relPath, baseHash: plan.baseHash, proposedHash,
      createContent: plan.createContent !== null ? plan.createContent : null, replacements: plan.replacements,
      mutationUnitId: changeSetId, status: 'previewed', diff, createdAt: Date.now(), updatedAt: Date.now(),
    });
    return { changeSetId, path: relPath, baseHash: plan.baseHash, proposedHash, diff, bounds: EDIT_BOUNDS, exists };
  }

  async apply({ workspaceId, changeSetId }) {
    this._requireOwner();
    const op = this.ops.load(changeSetId);
    if (!op) throw new WorkspaceError(`unknown changeSetId: ${changeSetId}`);
    if (op.status !== 'previewed') {
      if (op.status === 'applied') {
        const { workspace, absolute } = this.registry.resolveWritable(workspaceId, op.path, { forCreate: op.createContent !== null });
        if (op.workspaceRoot && workspace.root !== op.workspaceRoot) throw new WorkspaceError('workspace changed since preview');
        const cur = fs.existsSync(absolute) ? fs.readFileSync(absolute) : null;
        if (cur && sha256(cur) === op.proposedHash) return { changeSetId, status: 'applied', path: op.path, resultHash: op.proposedHash, idempotentReplay: true, diff: op.diff || null };
        this.ops.update(changeSetId, { status: 'recovery_required', updatedAt: Date.now() });
        throw new WorkspaceError('operation state says applied but target hash differs (recovery required)');
      }
      throw new WorkspaceError('recovery_required changeSet cannot be reapplied; re-preview first');
    }
    const { workspace, absolute, exists } = this.registry.resolveWritable(workspaceId, op.path, { forCreate: op.createContent !== null });
    if (op.workspaceRoot && workspace.root !== op.workspaceRoot) throw new WorkspaceError('workspace changed since preview');

    let mutationStarted = false;
    let tempFile = null;
    try {
      // Acquire chatgpt ownership (unit = changeSetId) BEFORE any mutation.
      this.owner.acquire('chatgpt', changeSetId);
      this.ops.update(changeSetId, { status: 'applying', updatedAt: Date.now() });
      // Stale / new-target checks BEFORE any write.
      if (op.createContent !== null) {
        if (exists) { this.ops.update(changeSetId, { status: 'previewed', updatedAt: Date.now() }); this.owner.markUnitState('reconciled'); this.owner.release(); throw new WorkspaceError('new target appeared after preview (refusing to overwrite)'); }
      } else {
        const cur = fs.readFileSync(absolute);
        if (sha256(cur) !== op.baseHash) { this.ops.update(changeSetId, { status: 'previewed', updatedAt: Date.now() }); this.owner.markUnitState('reconciled'); this.owner.release(); throw new WorkspaceError('stale file between preview and apply'); }
      }
      // Mutation begins: write temp atomically.
      mutationStarted = true;
      const dir = path.dirname(absolute);
      tempFile = path.join(dir, '.edit-' + changeSetId + '-' + process.pid + '.tmp');
      const proposed = op.createContent !== null ? Buffer.from(op.createContent, 'utf8') : Buffer.from(applyReplacements(fs.readFileSync(absolute, 'utf8'), op.replacements), 'utf8');
      fs.writeFileSync(tempFile, proposed);
      preserveMode(absolute, tempFile);
      fs.renameSync(tempFile, absolute);
      tempFile = null;
      const resultHash = sha256(proposed);
      if (resultHash !== op.proposedHash) { this.ops.update(changeSetId, { status: 'recovery_required', updatedAt: Date.now() }); throw new WorkspaceError('result hash does not match previewed proposedHash'); }
      this.ops.update(changeSetId, { status: 'applied', updatedAt: Date.now() });
      this.owner.markUnitState('reconciled');
      this.owner.release();
      return { changeSetId, status: 'applied', path: op.path, resultHash, idempotentReplay: false, diff: op.diff || null };
    } catch (e) {
      if (mutationStarted) {
        this.ops.update(changeSetId, { status: 'recovery_required', updatedAt: Date.now() });
        this.owner.markUnitState('unknown');
      } else if (this.owner.owner === 'chatgpt') {
        this.ops.update(changeSetId, { status: 'previewed', updatedAt: Date.now() });
        this.owner.markUnitState('reconciled');
        try { this.owner.release(); } catch {}
      }
      if (tempFile && fs.existsSync(tempFile)) { try { fs.rmSync(tempFile, { force: true }); } catch {} }
      throw e;
    }
  }
}

function applyReplacements(text, replacements) {
  let out = text;
  for (const r of (replacements || [])) out = out.split(r.oldText).join(r.newText);
  return out;
}

function preserveMode(absolute, tempFile) {
  try {
    const st = fs.statSync(absolute);
    if (st.mode & 0o111) fs.chmodSync(tempFile, st.mode);
  } catch {}
}

function buildDiff(before, after) {
  if (before === after) return '';
  const bl = before.split('\n'); const al = after.split('\n');
  let lines = [];
  const max = Math.min(bl.length, al.length);
  for (let i = 0; i < max; i++) if (bl[i] !== al[i]) { lines.push('@@ line ' + (i + 1) + ' @@'); lines.push('- ' + bl[i]); lines.push('+ ' + al[i]); if (lines.length >= 80) break; }
  return { summary: { before: bl.length, after: al.length }, body: lines.join('\n') };
}

export { sha256 as computeSha256 };
