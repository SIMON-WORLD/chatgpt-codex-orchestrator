// chatgpt-codex-orchestrator: Direct Brain Loop (canonical default path).
//
// The default `$brain-command` production path is the DIRECT Brain Loop:
//
//   User -> current Codex agent -> Codex built-in browser -> ChatGPT Brain
//        -> current Codex agent executes TASK
//        -> compact RESULT back to the same ChatGPT conversation
//        -> REVISE / TASK / DONE
//        -> PUBLISH -> publication transaction -> external readback -> terminal DONE
//
// It does NOT start a second Codex executor, does NOT start a worker daemon,
// does NOT require a ready file, a localhost TCP handshake, or an auth token,
// and does NOT block waiting for one REPL invocation to complete the whole task.
// The current Codex agent is the executor; ChatGPT is the Brain.
//
// It also supports adopting an EXISTING ChatGPT history conversation as the Brain
// (adoptConversation by conversationUrl / conversationId / title, plus adoptCurrent).
// No new conversation is created when an existing conversation is adopted; the
// same conversation is reused for the whole loop.
//
// The long-lived worker/runtime path (brain-command-launcher / brain-command-worker /
// TaskService / TaskManager / worker-client / durable recovery machinery) is
// retained as LEGACY / EXPERIMENTAL and is NOT on the canonical startup path.

import { InAppBrowserTransport, openBrainSession, openBrainSessionExisting, createTabFacade, BrainSession, captureCurrentConversation, ConversationIdentityMismatchError } from './iab-transport.js';
import { extractConversationId } from './atomic-turn.js';
import { createDirectGovernance } from './direct-governance.js';

// Thin BrainProvider contract (reserved for future providers; only ChatGPT is
// canonical in this Batch):
//   interface BrainProvider {
//     open({ url })            -> { conversationId, conversationUrl, tabId }
//     send(message)           -> { reply, conversationId, conversationUrl }
//     identifyConversation()  -> { conversationId, conversationUrl, tabId } | null
//     resume({ tabId, conversationId, conversationUrl }) -> BrainProvider
//     adoptConversation({ conversationUrl?, conversationId?, title? }) -> identity
//     adoptCurrent() -> identity
//   }
export const BRAIN_PROVIDERS = ['chatgpt'];

export const DEFAULT_DIRECT_CONFIG = {
  brainProvider: 'chatgpt',       // only canonical provider
  executor: 'current-codex',      // the current Codex agent is the executor
  conversation: 'reuse',          // reuse one dedicated ChatGPT conversation
  publishPolicy: 'auto',
};

// Direct Mode is browser-first: it uses the Codex built-in browser, never the
// detached worker / nested-Codex runtime.
export const DIRECT_MODE_REQUIRES = {
  workerBootstrap: false,
  readyFile: false,
  nestedCodex: false,
  localhostTcp: false,
  authTokenHandshake: false,
  trustedReplLongLoop: false,
  processShim: false,
};

// Short takeover message sent to an adopted existing conversation. We do NOT dump
// the full history because the conversation already owns it.
export const DEFAULT_TAKEOVER_MESSAGE = [
  'Continue this existing project conversation.',
  'ChatGPT now owns PLAN / TASK / REVISE / DONE.',
  'The current Codex conversation is the executor.',
  'Use the existing conversation context; do not restart completed work from zero.',
  'Ask Codex only for missing current repository facts.',
  'DEFAULT EXECUTION CONTRACT (established once; do not repeat these defaults inside every TASK unless an exception/override is needed):',
  '- ChatGPT owns PLAN / architecture / review / DONE.',
  '- Codex stays within Brain-approved scope; may run normal edit/debug/test iterations inside one milestone TASK.',
  '- Mandatory verification applies; protect secrets; fail closed on ambiguity.',
  '- Codex returns compact RESULT evidence.',
  '- No force push or rewrite of published history; publish only after PUBLISH + publication gate; DONE is terminal.',
  'Governance: PLAN comprehensively once, then prefer milestone-sized TASKs that combine coherent implementation work that can be executed and reviewed together; return to the Brain only at meaningful review/decision boundaries. REVISE remains available whenever evidence fails.',
  'Bootstrap evidence (read-only): repoDir, currentBranch, HEAD, git status --short summary, origin/main divergence.',
  'Lifecycle: PUBLISH (publication transaction + external observable readback) precedes terminal DONE; DONE is terminal and no further control is valid.',
  'Provide the next control for continuing the project.',
].join('\n');

export class ConversationNotFoundError extends Error {
  constructor(title) { super(`no ChatGPT conversation found with title "${title}"`); this.name = 'ConversationNotFoundError'; this.title = title; }
}

export class ConversationAmbiguityError extends Error {
  constructor(title, count) { super(`multiple (${count}) ChatGPT conversations match title "${title}"; not guessing`); this.name = 'ConversationAmbiguityError'; this.title = title; this.count = count; }
}

async function adoptByUrlOrId({ transport, conversationUrl = null, conversationId = null }) {
  await transport.connect();
  const wantUrl = conversationUrl || (conversationId ? `https://chatgpt.com/c/${conversationId}` : null);
  const wantId = conversationId || extractConversationId(wantUrl || '');
  if (!wantUrl) throw new Error('adoptConversation by URL/ID requires conversationUrl or conversationId');
  const tab = await transport.browser.tabs.new();
  try {
    await tab.goto(wantUrl);
    await tab.playwright.waitForLoadState('domcontentloaded').catch(() => {});
    await tab.playwright.waitForTimeout(4000);
    const actualUrl = await tab.url();
    const actualId = extractConversationId(actualUrl);
    if (!actualId) throw new ConversationIdentityMismatchError(`opened ${actualUrl} but found no /c/<id>`);
    if (wantId && actualId !== wantId) throw new ConversationIdentityMismatchError(`requested /c/${wantId} but opened ${actualUrl}`);
    const facade = createTabFacade(tab);
    const brain = new BrainSession({ transport, tab, facade, conversationId: actualId, conversationUrl: actualUrl });
    return { tabId: tab.id, conversationId: actualId, conversationUrl: actualUrl, brain };
  } catch (e) {
    try { await tab.close(); } catch (_) {}
    throw e;
  }
}

async function adoptByTitle({ transport, title, url = 'https://chatgpt.com/' }) {
  await transport.connect();
  const tab = await transport.browser.tabs.new();
  try {
    await tab.goto(url);
    await tab.playwright.waitForLoadState('domcontentloaded').catch(() => {});
    await tab.playwright.waitForTimeout(3000);
    // Use the transport-level history finder (real DOM on the live transport; a
    // mock in tests). Never falls back to a fleeting nth-child / UI index.
    const matches = await transport.findConversationLinksByTitle(tab, title);
    if (!matches || matches.length === 0) throw new ConversationNotFoundError(title);
    if (matches.length > 1) throw new ConversationAmbiguityError(title, matches.length);
    const actualUrl = await transport.openConversationByHref(tab, matches[0].href);
    const actualId = extractConversationId(actualUrl);
    if (!actualId) throw new ConversationIdentityMismatchError(`opened conversation but found no /c/<id> in ${actualUrl}`);
    const facade = createTabFacade(tab);
    const brain = new BrainSession({ transport, tab, facade, conversationId: actualId, conversationUrl: actualUrl });
    return { tabId: tab.id, conversationId: actualId, conversationUrl: actualUrl, conversationTitle: title, brain };
  } catch (e) {
    try { await tab.close(); } catch (_) {}
    throw e;
  }
}

// ChatGPTBrowserProvider: wraps the Codex built-in browser (IAB) and reuses one
// dedicated (or existing) ChatGPT conversation. Implements the BrainProvider contract.
export function createChatGPTBrowserProvider({ transport = null, turnOptions = {} } = {}) {
  const t = transport || new InAppBrowserTransport();
  let session = null;
  let identity = null;

  async function open({ url = 'https://chatgpt.com/', ...rest } = {}) {
    await t.connect();
    session = await openBrainSession(t, { url, turnOptions });
    identity = { conversationId: session.conversationId, conversationUrl: session.conversationUrl, tabId: session.ownedTabId };
    return identity;
  }

  async function send(message, { nonce } = {}) {
    if (!session) throw new Error('no Brain session; call open / adoptConversation / adoptCurrent first');
    const r = await session.send(message, { nonce });
    identity = { conversationId: r.conversationId, conversationUrl: r.conversationUrl, tabId: r.ownedTabId };
    return r;
  }

  function identifyConversation() {
    return identity ? { conversationId: identity.conversationId, conversationUrl: identity.conversationUrl, tabId: identity.tabId } : null;
  }

  async function resume({ tabId, conversationId, conversationUrl }) {
    await t.connect();
    session = await openBrainSessionExisting(t, { tabId, conversationId, conversationUrl, turnOptions });
    identity = { conversationId, conversationUrl, tabId: session.ownedTabId };
    return identity;
  }

  // Adopt an EXISTING ChatGPT conversation (no new conversation is created).
  async function adoptConversation({ conversationUrl = null, conversationId = null, title = null } = {}) {
    await t.connect();
    let res;
    if (conversationUrl || conversationId) {
      res = await adoptByUrlOrId({ transport: t, conversationUrl, conversationId });
    } else if (title) {
      res = await adoptByTitle({ transport: t, title });
    } else {
      throw new Error('adoptConversation requires conversationUrl, conversationId, or title');
    }
    session = res.brain;
    identity = { conversationId: res.conversationId, conversationUrl: res.conversationUrl, tabId: res.tabId };
    return identity;
  }

  // Adopt the user's *current* selected IAB conversation (explicit opt-in only).
  async function adoptCurrent() {
    await t.connect();
    const res = await captureCurrentConversation(t);
    session = res.brain;
    identity = { conversationId: res.conversationId, conversationUrl: res.conversationUrl, tabId: res.tabId };
    return identity;
  }

  return {
    provider: 'chatgpt',
    open,
    send,
    identifyConversation,
    resume,
    adoptConversation,
    adoptCurrent,
    _transport: t,
    get _session() { return session; },
    get _identity() { return identity; },
  };
}

// Minimal Direct Task State (PHASE 6) -- only the information that has value.
// Does NOT carry daemon locks, no complex crash recovery.
export function newDirectTaskState({ taskId, repoDir, brainProvider = DEFAULT_DIRECT_CONFIG.brainProvider, executor = DEFAULT_DIRECT_CONFIG.executor, conversationId = null, conversationUrl = null, conversationTitle = null, publishPolicy = DEFAULT_DIRECT_CONFIG.publishPolicy } = {}) {
  return {
    schemaVersion: 1,
    taskId,
    repoDir,
    brainProvider,
    executor,
    conversationId,
    conversationUrl,
    conversationTitle,
    plan: null,
    currentStepId: null,
    completedSteps: [],
    evidenceLedger: [],
    publishPolicy,
    governance: createDirectGovernance(),
    startedAt: new Date().toISOString(),
  };
}

// PUBLISH authorizes publication; DONE never authorizes publishing. A new
// control is only passed to publication via PUBLISH, and a terminal DONE only
// accepts an already-verified final state.
export function evaluatePublicationGate({ brainControl, acceptanceGateOk = true, identityPreflightOk = true, workingTreeScopeOk = true } = {}) {
  if (brainControl !== 'PUBLISH') return { ok: false, reason: `brain control is ${String(brainControl)}; only PUBLISH may start publication` };
  if (!acceptanceGateOk) return { ok: false, reason: 'final acceptance gate not passed' };
  if (!identityPreflightOk) return { ok: false, reason: 'publish identity preflight not passed' };
  if (!workingTreeScopeOk) return { ok: false, reason: 'working tree has unrelated changes' };
  return { ok: true, reason: 'publication gate passed' };
}

// DONE is terminal. It is only valid after the publication transaction completed
// with external observable evidence AND final verification passed. DONE itself
// never starts publication.
export function evaluateDoneGate({ publicationReady = false, finalVerificationOk = true, workingTreeScopeOk = true } = {}) {
  if (!publicationReady) return { ok: false, reason: 'publication not ready (need PUBLISH -> transaction -> external readback)' };
  if (!finalVerificationOk) return { ok: false, reason: 'final verification not passed' };
  if (!workingTreeScopeOk) return { ok: false, reason: 'working tree has unrelated changes' };
  return { ok: true, reason: 'terminal DONE gate passed' };
}

// Convenience: forbid publishing for the known non-publish states.
export function isPublishForbiddenState(state) {
  return ['REVISE', 'ASK_USER', 'failure', 'recovery_required'].includes(String(state));
}