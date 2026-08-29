// chatgpt-codex-orchestrator: Direct Brain Loop (canonical default path).
//
// The default `$brain-command` production path is the DIRECT Brain Loop:
//
//   User -> current Codex agent -> Codex built-in browser -> ChatGPT Brain
//        -> current Codex agent executes TASK
//        -> compact RESULT back to the same ChatGPT conversation
//        -> REVISE / TASK / DONE
//        -> publish on DONE
//
// It does NOT start a second Codex executor, does NOT start a worker daemon,
// does NOT require a ready file, a localhost TCP handshake, or an auth token,
// and does NOT block waiting for one REPL invocation to complete the whole task.
// The current Codex agent is the executor; ChatGPT is the Brain.
//
// The long-lived worker/runtime path (brain-command-launcher / brain-command-worker /
// TaskService / TaskManager / worker-client / durable recovery machinery) is
// retained as LEGACY / EXPERIMENTAL and is NOT on the canonical startup path.

import { InAppBrowserTransport, openBrainSession, openBrainSessionExisting } from './iab-transport.js';

// Thin BrainProvider contract (reserved for future providers; only ChatGPT is
// canonical in this Batch):
//   interface BrainProvider {
//     open({ url })            -> { conversationId, conversationUrl, tabId }
//     send(message)           -> { reply, conversationId, conversationUrl }
//     identifyConversation()  -> { conversationId, conversationUrl, tabId } | null
//     resume({ tabId, conversationId, conversationUrl }) -> BrainProvider
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

// ChatGPTBrowserProvider: wraps the Codex built-in browser (IAB) and reuses one
// dedicated ChatGPT conversation. Implements the BrainProvider contract.
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

  async function send(message) {
    const r = await session.send(message);
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

  return { provider: 'chatgpt', open, send, identifyConversation, resume, _transport: t, _session: session };
}

// Minimal Direct Task State (PHASE 6) -- only the information that has value.
// Does NOT carry daemon locks, no complex crash recovery.
export function newDirectTaskState({ taskId, repoDir, brainProvider = DEFAULT_DIRECT_CONFIG.brainProvider, executor = DEFAULT_DIRECT_CONFIG.executor, conversationId = null, conversationUrl = null, publishPolicy = DEFAULT_DIRECT_CONFIG.publishPolicy } = {}) {
  return {
    schemaVersion: 1,
    taskId,
    repoDir,
    brainProvider,
    executor,
    conversationId,
    conversationUrl,
    plan: null,
    currentStepId: null,
    completedSteps: [],
    evidenceLedger: [],
    publishPolicy,
    startedAt: new Date().toISOString(),
  };
}

// DONE publish gate. Publish only when:
//   - Brain returned DONE
//   - the task is completed
//   - mandatory verification passed
//   - working tree has no unrelated changes
// Never publish on REVISE / ASK_USER / failure / recovery_required.
export function evaluatePublishGate({ brainControl, taskStatus = 'completed', mandatoryVerificationOk = true, workingTreeScopeOk = true } = {}) {
  if (brainControl !== 'DONE') return { ok: false, reason: `brain control is ${String(brainControl)}; only DONE may publish` };
  if (taskStatus !== 'completed') return { ok: false, reason: `task status is ${String(taskStatus)}; only completed may publish` };
  if (!mandatoryVerificationOk) return { ok: false, reason: 'mandatory verification not passed' };
  if (!workingTreeScopeOk) return { ok: false, reason: 'working tree has unrelated changes' };
  return { ok: true, reason: 'publish gate passed' };
}

// Convenience: forbid publishing for the known non-publish states.
export function isPublishForbiddenState(state) {
  return ['REVISE', 'ASK_USER', 'failure', 'recovery_required'].includes(String(state));
}