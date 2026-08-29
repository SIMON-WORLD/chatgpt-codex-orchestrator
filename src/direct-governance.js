// chatgpt-codex-orchestrator: Direct Mode governance (Alpha.4 candidate).
//
// Pure, injectable helpers that bring the existing acceptance / evidence /
// verification capability into the canonical Direct Brain Loop. No worker /
// daemon / nested Codex / external browser / complex recovery. The executor's
// natural-language summary never overrides the acceptance gate.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { normalizeEvidence } from './protocol.js';
import { isPlaceholder } from './atomic-turn.js';

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

// --- Canonical Direct governance state + transition --------------------------
// Carries the machine state needed by the loop (acceptance registry, proof
// ledger snapshot, metrics) and exposes ONE transition function. The natural
// language summary can never bypass the gate.
export function createDirectGovernance({ proofLedger = createProofLedger(), metrics = createDirectMetrics() } = {}) {
  const state = {
    acceptanceRegistry: [],   // [{ id, required, text, status }]
    proofLedger,
    metrics,
    currentStepId: null,
    completedSteps: [],
  };

  function registerAcceptance(acceptance = []) {
    for (const a of acceptance) {
      const id = typeof a === 'string' ? a : (a.id || a.text);
      if (!id) continue;
      const required = typeof a === 'string' ? true : (a.required !== false);
      if (!state.acceptanceRegistry.some((x) => x.id === id)) {
        state.acceptanceRegistry.push({ id, required, text: (typeof a === 'string' ? a : (a.text || a.id || '')), status: 'missing' });
      }
    }
  }

  function applyResultEvidence(evidence = []) {
    for (const e of (evidence || []).map((x) => normalizeEvidence(x))) {
      const reg = state.acceptanceRegistry.find((x) => x.id === e.acceptanceId);
      if (reg) reg.status = e.status;
      else state.acceptanceRegistry.push({ id: e.acceptanceId, required: false, text: e.acceptanceId, status: e.status });
    }
  }

  function gate() {
    return evaluateDirectAcceptanceGate({
      acceptance: state.acceptanceRegistry.map((a) => ({ id: a.id, required: a.required })),
      // A never-evidenced acceptance keeps status 'missing' and is excluded from
      // evidence, so the gate reports it as MISSING (not failed/unknown).
      evidence: state.acceptanceRegistry.filter((a) => a.status !== 'missing').map((a) => ({ acceptanceId: a.id, status: a.status })),
    });
  }

  return {
    state,
    // ONE canonical transition: begin/advance a step, register acceptance, apply
    // RESULT evidence, and compute the gate. Returns structured missing/failed ids.
    transition({ stepId, acceptance = [], result = null }) {
      if (stepId) state.currentStepId = stepId;
      registerAcceptance(acceptance);
      if (result) applyResultEvidence(Array.isArray(result.evidence) ? result.evidence : (result.evidence ? [result.evidence] : []));
      const g = gate();
      return { gate: g, blocked: !g.ok, missing: g.missing, failed: g.failed, stepId: state.currentStepId };
    },
    // Only mark reviewed/completed when the gate passes; never silently advance.
    markStepReviewed({ stepId }) {
      const g = gate();
      if (!g.ok) return { ok: false, blocked: true, missing: g.missing, failed: g.failed, stepId };
      const s = stepId || state.currentStepId;
      if (s && !state.completedSteps.includes(s)) state.completedSteps.push(s);
      state.currentStepId = null;
      return { ok: true, completed: true, stepId: s };
    },
    registerAcceptance,
    gate,
  };
}

// --- 2) Proof ledger (fail closed) -------------------------------------------
function defaultFingerprint(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Deterministic canonical path (repo-relative-ish): forward slashes, no leading ./,
// no duplicate slashes.
export function normalizeRelevantPath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

export function createProofLedger({ computeFingerprint = null, normalizePath = null } = {}) {
  const compute = computeFingerprint || defaultFingerprint;
  const norm = normalizePath || normalizeRelevantPath;
  const proofs = [];

  return {
    record({ acceptanceId, status = 'pass', kind = 'verify', summary = '', verification = null, relevantFiles = [], dependencyFree = false, stepId = null }) {
      const files = (relevantFiles || []).map(norm).filter(Boolean);
      const relevantFingerprints = {};
      let fingerprintsOk = true;
      for (const f of files) {
        try { relevantFingerprints[f] = compute(f); } catch { relevantFingerprints[f] = null; fingerprintsOk = false; }
      }
      // Fail closed: without an explicit dependencyFree contract, a proof is only
      // potentially reusable when it tracks at least one dependency and every
      // dependency fingerprint computed successfully.
      const reusable = dependencyFree === true ? true : (files.length > 0 && fingerprintsOk);
      const proof = { acceptanceId, status, kind, summary, verification, relevantFiles: files, relevantFingerprints, dependencyFree, reusable, stepId, createdAt: new Date().toISOString() };
      const i = proofs.findIndex((p) => p.acceptanceId === acceptanceId);
      if (i >= 0) proofs[i] = proof; else proofs.push(proof);
      return proof;
    },
    get(acceptanceId) { return proofs.find((p) => p.acceptanceId === acceptanceId) || null; },
    all() { return proofs.slice(); },
    count() { return proofs.length; },
    isFresh(acceptanceId, { verification = null } = {}) {
      const p = this.get(acceptanceId);
      if (!p || p.status !== 'pass') return false;
      // Fail closed: no-dependency proof without explicit dependencyFree contract is not reusable.
      if (p.dependencyFree !== true && (!p.relevantFiles || p.relevantFiles.length === 0)) return false;
      // Verification identity must participate if recorded.
      if (p.verification && verification && p.verification !== verification) return false;
      // Fingerprint failure (null) is not fresh; a changed dependency is stale.
      if (p.dependencyFree !== true) {
        for (const f of p.relevantFiles) {
          let cur = null;
          try { cur = compute(f); } catch { cur = null; }
          if (cur === null || p.relevantFingerprints[f] === undefined || cur !== p.relevantFingerprints[f]) return false;
        }
      }
      return true;
    },
    isReusable(acceptanceId, opts) { return this.isFresh(acceptanceId, opts); },
    // Mark proofs stale when a (normalized) changed file intersects relevantFiles.
    invalidateOnChange(changedFiles = []) {
      const changed = new Set((changedFiles || []).map(norm));
      let stale = 0;
      for (const p of proofs) {
        if (p.relevantFiles.some((f) => changed.has(f))) { p.status = 'stale'; stale++; }
      }
      return stale;
    },
  };
}

// --- 3) Verification tiers ---------------------------------------------------
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
    const stale = gate.required.filter((id) => !(proofLedger && proofLedger.isReusable(id)));
    if (stale.length) return { ok: false, reason: `final requires fresh proofs for: ${stale.join(', ')}` };
  }
  if (tier === 'milestone') {
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

// --- 9) Bounded late-reply poll (truthful, identity-preserving) --------------
// Preserves exactly-once send. This is ONLY a bounded read-only late-reply poll:
// it never resends, verifies the expected conversation identity when supplied,
// ignores placeholder / unstable replies, and returns a reply only when it is
// confidently identified (stable across two reads). It does NOT claim to rebind
// the IAB tab — if the conversation identity ever mismatches, it bails (null).
export async function attemptLateReplyRecovery({ readReply, getCount, beforeCount = 0, beforeLast = '', expectedConversationId = null, getConversationId = null, maxSlices = 4, sliceMs = 2000 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < maxSlices; i++) {
    await sleep(sliceMs);
    if (getConversationId) {
      let cid = null;
      try { cid = await getConversationId(); } catch { cid = null; }
      if (expectedConversationId && cid && cid !== expectedConversationId) return null;
    }
    let n = -1; try { n = await getCount(); } catch { n = -1; }
    if (n > 0) {
      const cur = (await readReply(n - 1)) || '';
      if (cur && cur.trim() && cur !== beforeLast && !isPlaceholder(cur)) {
        try { const again = (await readReply(n - 1)) || ''; if (again === cur) return cur; } catch { /* unstable */ }
      }
    }
  }
  return null;
}
