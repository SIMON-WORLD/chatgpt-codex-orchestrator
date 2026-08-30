// chatgpt-codex-orchestrator: Direct Mode governance (Alpha.4 candidate).
//
// Pure, injectable helpers that bring the existing acceptance / evidence /
// verification capability into the canonical Direct Brain Loop. No worker /
// daemon / nested Codex / external browser / complex recovery. The executor's
// natural-language summary never overrides the acceptance gate, and proof reuse
// is wired into the single canonical transition (no separate record/invalidate
// calls required of the agent).

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

// Normalize a structured acceptance item, preserving optional proof metadata
// (relevantFiles / dependencyFree / verificationId). Legacy strings stay compatible.
export function normalizeAcceptanceItem(a) {
  if (typeof a === 'string') return { id: a, required: true, text: a, proof: null };
  const id = a.id || a.text;
  if (!id) return null;
  let proof = null;
  if (a.proof && typeof a.proof === 'object') {
    const p = {
      ...(Array.isArray(a.proof.relevantFiles) ? { relevantFiles: a.proof.relevantFiles.slice() } : {}),
      ...(typeof a.proof.dependencyFree === 'boolean' ? { dependencyFree: a.proof.dependencyFree } : {}),
      ...(typeof a.proof.verificationId === 'string' ? { verificationId: a.proof.verificationId } : {}),
    };
    if (p.relevantFiles || p.dependencyFree || p.verificationId) proof = p;
  }
  return { id, required: a.required !== false, text: a.text || a.id || '', proof };
}

// --- Canonical Direct governance state + transition --------------------------
// Carries the machine state (acceptance registry + proof ledger + metrics) and
// exposes ONE transition. For a RESULT it: registers the acceptance contract,
// invalidates proofs from result.changed, applies evidence, records new passing
// proofs when a reusable proof contract exists, computes the gate, and returns
// structured missing/failed/passed + proof info. Summary never participates.
export function createDirectGovernance({ proofLedger = createProofLedger(), metrics = createDirectMetrics() } = {}) {
  const state = {
    acceptanceRegistry: [],
    proofLedger,
    metrics,
    currentStepId: null,
    completedSteps: [],
  };

  function registerAcceptance(acceptance = []) {
    for (const raw of acceptance) {
      const a = normalizeAcceptanceItem(raw);
      if (!a) continue;
      const ex = state.acceptanceRegistry.find((x) => x.id === a.id);
      if (ex) {
        // reissue with (possibly changed) proof metadata -> update contract deterministically
        ex.required = a.required;
        ex.text = a.text;
        ex.proof = a.proof;
      } else {
        state.acceptanceRegistry.push({ ...a, status: 'missing' });
      }
    }
  }

  function applyResultEvidence(evidence = []) {
    for (const e of (evidence || []).map((x) => normalizeEvidence(x))) {
      const reg = state.acceptanceRegistry.find((x) => x.id === e.acceptanceId);
      if (reg) reg.status = e.status;
      else state.acceptanceRegistry.push({ id: e.acceptanceId, required: false, text: e.acceptanceId, proof: null, status: e.status });
    }
  }

  function gate() {
    return evaluateDirectAcceptanceGate({
      acceptance: state.acceptanceRegistry.map((a) => ({ id: a.id, required: a.required })),
      evidence: state.acceptanceRegistry.filter((a) => a.status !== 'missing').map((a) => ({ acceptanceId: a.id, status: a.status })),
    });
  }

  function currentVerificationId(acceptanceId) {
    const reg = state.acceptanceRegistry.find((x) => x.id === acceptanceId);
    return reg && reg.proof ? (reg.proof.verificationId || null) : null;
  }

  // Record a reusable proof for a currently-passing acceptance that has a proof
  // contract. No proof metadata => current PASS but NOT reusable across later
  // verification boundaries by default.
  function recordPassingProof(e, stepId) {
    const reg = state.acceptanceRegistry.find((x) => x.id === e.acceptanceId);
    if (!reg || !reg.proof) return null;
    const pc = reg.proof;
    const relevant = pc.relevantFiles || [];
    const dependencyFree = pc.dependencyFree === true;
    const verificationId = pc.verificationId || null;
    const prev = state.proofLedger.get(e.acceptanceId);
    if (prev && !state.proofLedger.isReusable(e.acceptanceId, { verificationId })) state.metrics.bump('staleProofCount');
    state.proofLedger.record({ acceptanceId: e.acceptanceId, status: 'pass', kind: e.kind || 'verify', summary: e.summary || e.acceptanceId || '', verificationId, relevantFiles: relevant, dependencyFree, stepId });
    return { acceptanceId: e.acceptanceId };
  }

  return {
    state,
    transition({ stepId, acceptance = [], result = null }) {
      if (stepId) state.currentStepId = stepId;
      // A) register/update acceptance contract
      registerAcceptance(acceptance);
      // B) invalidate existing proofs from result.changed BEFORE recording new proofs
      const changed = Array.isArray(result?.changed) ? result.changed.map(normalizeRelevantPath) : [];
      const invalidated = state.proofLedger.invalidateOnChange(changed);
      if (invalidated > 0) state.metrics.bump('staleProofCount', invalidated);
      // C) normalize/apply RESULT evidence
      const evidence = Array.isArray(result?.evidence) ? result.evidence : (result?.evidence ? [result.evidence] : []);
      applyResultEvidence(evidence);
      // D) record passing proofs (only when a reusable proof contract exists)
      const proofInfo = { recorded: [], stale: [] };
      for (const e of evidence.map((x) => normalizeEvidence(x))) {
        if (e.status !== 'pass') continue;
        const rec = recordPassingProof(e, state.currentStepId);
        if (rec) proofInfo.recorded.push(rec.acceptanceId);
      }
      // E) machine acceptance gate
      const g = gate();
      // F) structured result
      return { gate: g, blocked: !g.ok, missing: g.missing, failed: g.failed, passed: g.passed, proofInfo, stepId: state.currentStepId };
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
    // Verification planning that wires the ledger + metrics: reuse fresh proofs,
    // rerun only what is required, and bump reused/stale/verification metrics.
    planVerification({ tier, requiredAcceptanceIds }) {
      const verificationIds = {};
      for (const id of requiredAcceptanceIds) verificationIds[id] = currentVerificationId(id);
      const plan = planVerification({ tier, requiredAcceptanceIds, proofLedger: state.proofLedger, verificationIds });
      state.metrics.bump('reusedProofCount', plan.reuse.length);
      state.metrics.bump('verificationRuns', plan.needVerification.length);
      return plan;
    },
    registerAcceptance,
    gate,
    snapshot() {
      return {
        acceptanceRegistry: state.acceptanceRegistry,
        proofLedger: state.proofLedger.all(),
        completedSteps: state.completedSteps,
        currentStepId: state.currentStepId,
        gate: gate(),
        metrics: state.metrics.snapshot(),
      };
    },
  };
}

// --- 2) Proof ledger (fail closed, deterministic verificationId) -------------
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
    record({ acceptanceId, status = 'pass', kind = 'verify', summary = '', verificationId = null, relevantFiles = [], dependencyFree = false, stepId = null }) {
      const files = (relevantFiles || []).map(norm).filter(Boolean);
      const relevantFingerprints = {};
      for (const f of files) { try { relevantFingerprints[f] = compute(f); } catch { relevantFingerprints[f] = null; } }
      const proof = { acceptanceId, status, kind, summary, verificationId, relevantFiles: files, relevantFingerprints, dependencyFree, stepId, createdAt: new Date().toISOString() };
      const i = proofs.findIndex((p) => p.acceptanceId === acceptanceId);
      if (i >= 0) proofs[i] = proof; else proofs.push(proof);
      return proof;
    },
    get(acceptanceId) { return proofs.find((p) => p.acceptanceId === acceptanceId) || null; },
    all() { return proofs.slice(); },
    count() { return proofs.length; },
    isFresh(acceptanceId, { verificationId = null } = {}) {
      const p = this.get(acceptanceId);
      if (!p || p.status !== 'pass') return false;
      if (p.dependencyFree !== true && (!p.relevantFiles || p.relevantFiles.length === 0)) return false;
      // Deterministic scalar verification identity: if either side has an id,
      // they must match (missing/changed current id when stored had one => stale).
      if ((p.verificationId || verificationId) && p.verificationId !== verificationId) return false;
      if (p.dependencyFree !== true) {
        for (const f of p.relevantFiles) {
          let cur = null; try { cur = compute(f); } catch { cur = null; }
          if (cur === null || p.relevantFingerprints[f] === undefined || cur !== p.relevantFingerprints[f]) return false;
        }
      }
      return true;
    },
    isReusable(acceptanceId, opts) { return this.isFresh(acceptanceId, opts); },
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
export function planVerification({ tier = 'step', requiredAcceptanceIds = [], proofLedger = null, verificationIds = {} } = {}) {
  const needVerification = [];
  const reuse = [];
  for (const id of requiredAcceptanceIds) {
    if (proofLedger && proofLedger.isReusable(id, { verificationId: verificationIds[id] ?? null })) reuse.push(id);
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
