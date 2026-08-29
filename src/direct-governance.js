// chatgpt-codex-orchestrator: Direct Mode governance (Alpha.4 candidate).
//
// Pure, injectable helpers that bring the existing acceptance / evidence /
// verification capability into the canonical Direct Brain Loop. No worker /
// daemon / nested Codex / external browser / complex recovery. The executor's
// natural-language summary never overrides the acceptance gate.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { normalizeEvidence } from './protocol.js';

// --- 1) Acceptance gate ------------------------------------------------------
// A TASK / milestone is only "passing" when EVERY required acceptanceId has an
// evidence item whose status === 'pass'. Unknown / missing evidence is NOT pass.
export function evaluateDirectAcceptanceGate({ acceptance = [], evidence = [] } = {}) {
  const req = (acceptance || []).map((a) => (typeof a === 'string' ? { id: a, required: true } : { id: a.id, required: a.required !== false }));
  const evById = {};
  for (const e of (evidence || []).map((x) => normalizeEvidence(x))) evById[e.acceptanceId] = e;
  const missing = [];
  const failed = [];
  const passed = [];
  const required = req.filter((a) => a.required).map((a) => a.id);
  for (const a of req) {
    if (!a.required) continue;
    const e = evById[a.id];
    if (!e) missing.push(a.id);
    else if (e.status === 'pass') passed.push(a.id);
    else failed.push(a.id);
  }
  const allPass = required.every((id) => evById[id] && evById[id].status === 'pass');
  return { ok: allPass, missing, failed, passed, required };
}

// --- 2) Proof ledger ---------------------------------------------------------
function defaultFingerprint(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function createProofLedger({ computeFingerprint = null } = {}) {
  const compute = computeFingerprint || defaultFingerprint;
  const proofs = [];

  return {
    record({ acceptanceId, status = 'pass', kind = 'verify', summary = '', verification = null, relevantFiles = [], stepId = null }) {
      const relevantFingerprints = {};
      for (const f of relevantFiles) { try { relevantFingerprints[f] = compute(f); } catch { relevantFingerprints[f] = null; } }
      const proof = { acceptanceId, status, kind, summary, verification, relevantFiles, relevantFingerprints, stepId, createdAt: new Date().toISOString() };
      const i = proofs.findIndex((p) => p.acceptanceId === acceptanceId);
      if (i >= 0) proofs[i] = proof; else proofs.push(proof);
      return proof;
    },
    get(acceptanceId) { return proofs.find((p) => p.acceptanceId === acceptanceId) || null; },
    all() { return proofs.slice(); },
    count() { return proofs.length; },
    // Fresh only when a pass proof exists AND every relevant dependency is
    // byte-for-byte unchanged (current fingerprint equals the recorded one).
    isFresh(acceptanceId) {
      const p = this.get(acceptanceId);
      if (!p || p.status !== 'pass') return false;
      for (const f of p.relevantFiles) {
        let cur = null; try { cur = compute(f); } catch { cur = null; }
        if (cur !== p.relevantFingerprints[f]) return false;
      }
      return true;
    },
    isReusable(acceptanceId) { return this.isFresh(acceptanceId); },
    // Mark proofs stale when a changed file intersects their relevantFiles.
    invalidateOnChange(changedFiles = []) {
      const changed = new Set(changedFiles);
      let stale = 0;
      for (const p of proofs) {
        if (p.relevantFiles.some((f) => changed.has(f))) { p.status = 'stale'; stale++; }
      }
      return stale;
    },
  };
}

// --- 3) Verification tiers ---------------------------------------------------
// Decide which required acceptance IDs need (re)verification before a boundary.
// STEP: targeted/syntax. MILESTONE: milestone gate + reusable fresh proofs.
// FINAL: all required proofs must be fresh/pass. Do NOT blindly rerun a fresh proof.
export function planVerification({ tier = 'step', requiredAcceptanceIds = [], proofLedger = null } = {}) {
  const needVerification = [];
  const reuse = [];
  for (const id of requiredAcceptanceIds) {
    if (proofLedger && proofLedger.isReusable(id)) reuse.push(id);
    else needVerification.push(id);
  }
  return { tier, needVerification, reuse };
}

export function verifyTierPrecondition({ tier, gate, proofLedger } = {}) {
  if (!gate) return { ok: false, reason: 'no acceptance gate result' };
  if (tier === 'final') {
    // FINAL requires every required acceptance proof to be fresh/pass.
    const stale = gate.required.filter((id) => !(proofLedger && proofLedger.isReusable(id)));
    if (stale.length) return { ok: false, reason: `final requires fresh proofs for: ${stale.join(', ')}` };
  }
  if (tier === 'milestone') {
    // MILESTONE requires the gate to pass.
    if (!gate.ok) return { ok: false, reason: `milestone gate failed: missing=${gate.missing.join(',')} failed=${gate.failed.join(',')}` };
  }
  return { ok: true };
}

// --- 10) Bootstrap evidence --------------------------------------------------
export function buildBootstrapEvidence({ repoDir, gitRun } = {}) {
  if (!gitRun) return { repoDir, currentBranch: null, HEAD: null, gitStatusSummary: '', originMainDivergence: null };
  const run = (args) => { try { return String(gitRun(args) || '').trim(); } catch { return ''; } };
  const rawRun = (args) => { try { return String(gitRun(args) || ''); } catch { return ''; } };
  const divergence = run(['rev-list', '--left-right', '--count', 'origin/main...HEAD']);
  return {
    repoDir,
    currentBranch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    HEAD: run(['rev-parse', 'HEAD']),
    gitStatusSummary: rawRun(['status', '--short']).trimEnd(),
    originMainDivergence: divergence || null,
  };
}

// --- 11) Metrics -------------------------------------------------------------
export function createDirectMetrics() {
  const keys = {
    duration: 0, timeToFirstBrainControl: null, brainTurns: 0, taskCount: 0, reviseCount: 0,
    replanCount: 0, askUserCount: 0, publishCount: 0, replyTimeoutCount: 0, browserRecoveryCount: 0,
    conversationSwitchCount: 0, reusedProofCount: 0, staleProofCount: 0, verificationRuns: 0, publishRetryCount: 0,
  };
  const data = { startedAt: Date.now(), ...keys };
  return {
    data,
    bump(field, n = 1) { if (field in data && field !== 'startedAt') data[field] += n; },
    set(field, v) { if (field in data) data[field] = v; },
    snapshot() { return { ...data, duration: Date.now() - data.startedAt }; },
  };
}

// --- 9) Bounded late-reply recovery -----------------------------------------
// Preserves exactly-once send. On a reply timeout, do NOT resend: keep the same
// conversation, and use short bounded read-only polling slices to detect a late
// reply. Returns the late reply text, or null if it never arrived (permanent).
export async function attemptLateReplyRecovery({ readReply, getCount, beforeCount, beforeLast, maxSlices = 4, sliceMs = 2000 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < maxSlices; i++) {
    await sleep(sliceMs);
    let n = -1; try { n = await getCount(); } catch { n = -1; }
    if (n > 0) {
      const cur = (await readReply(n - 1)) || '';
      if (cur && cur.trim() && cur !== beforeLast) return cur;
    }
  }
  return null;
}
