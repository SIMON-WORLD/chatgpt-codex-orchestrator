// test/executor/fixtures/fake-app-server.mjs
// Deterministic fake Codex App Server for M1 protocol tests.
// Speaks newline-delimited JSON-RPC over stdio using the same protocol shape as
// `codex app-server` (codex-cli 0.146.0, `codex app-server generate-ts`).
//
// State is persisted to a JSON file (FAKE_APP_SERVER_STATE_DIR) so that a
// simulated process-death + respawn can recover the same thread/turn identities,
// mirroring the real App Server's disk-backed threads.
//
// Env flags:
//   FAKE_APP_SERVER_APPROVAL=1  -> emit one item/commandExecution/requestApproval
//   FAKE_APP_SERVER_DIE_MS=N    -> simulate unexpected process death after N ms
//   FAKE_APP_SERVER_FAIL_TURN_START=1 -> make turn/start fail
//   FAKE_APP_SERVER_TURN_FAIL=1       -> completed turn reports status=failed
//   FAKE_APP_SERVER_REQUIRE_SANDBOX=1 -> thread/start requires a sandbox param
//   FAKE_APP_SERVER_NO_CONFIRM_INTERRUPT=1 -> interrupt does not confirm terminal
//   FAKE_APP_SERVER_STATE_DIR=dir      -> where thread/turn state is persisted

import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const threads = new Map();   // threadId -> thread
const turns = new Map();     // turnId -> turn
const serverRequests = new Map(); // requestId -> { method, resolved }
let approvalRequested = false;
let approvalResolved = false;

const EMIT_APPROVAL = process.env.FAKE_APP_SERVER_APPROVAL === '1';
const EMIT_APPROVAL_NONBINARY = process.env.FAKE_APP_SERVER_APPROVAL_NONBINARY === '1';
const DIE_MS = process.env.FAKE_APP_SERVER_DIE_MS ? Number(process.env.FAKE_APP_SERVER_DIE_MS) : null;
const FAIL_TURN_START = process.env.FAKE_APP_SERVER_FAIL_TURN_START === '1';
const SLOW_TURN = process.env.FAKE_APP_SERVER_SLOW_TURN === '1';
const STATE_DIR = process.env.FAKE_APP_SERVER_STATE_DIR || os.tmpdir();
const STATE_FILE = path.join(STATE_DIR, 'fake-app-server-state.json');

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ threads: [...threads.values()], turns: [...turns.values()], approvalRequested, approvalResolved }), 'utf8');
  } catch (e) { /* ignore */ }
}
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      for (const t of (data.threads || [])) threads.set(t.id, t);
      for (const t of (data.turns || [])) turns.set(t.id, t);
      approvalRequested = data.approvalRequested === true;
      approvalResolved = data.approvalResolved === true;
    }
  } catch (e) { /* ignore */ }
}
loadState();

function respond(id, result) { process.stdout.write(JSON.stringify({ id, result }) + '\n'); }
function respondError(id, error) { process.stdout.write(JSON.stringify({ id, error }) + '\n'); }
function notify(method, params) { process.stdout.write(JSON.stringify({ method, params }) + '\n'); }

function fakeThread(id) {
  return {
    id, extra: null, sessionId: id, forkedFromId: null, parentThreadId: null,
    preview: '', ephemeral: false, isPinned: false, historyMode: 'full',
    modelProvider: 'openai', createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000), recencyAt: null, status: 'idle',
    path: null, cwd: process.cwd(), cliVersion: '0.146.0-fake', source: 'app-server',
    canAcceptDirectInput: true, threadSource: null, agentNickname: null,
    agentRole: null, gitInfo: null, name: null, turns: [],
  };
}

function fakeTurn(id, status, items = [], extra = {}) {
  return {
    id, items, itemsView: { loadedItems: items.length, hasMore: false },
    status, error: null, startedAt: extra.startedAt ?? 0,
    completedAt: extra.completedAt ?? null, durationMs: null,
  };
}

function currentTurns() { return [...turns.values()].filter(Boolean); }

function threadWithTurns(threadId) {
  const thread = threads.get(threadId);
  const allTurns = currentTurns();
  return {
    ...thread,
    status: allTurns.some((t) => t.status === 'inProgress') ? 'running' : 'idle',
    turns: allTurns,
  };
}

function maybeEmitApproval(threadId, turnId) {
  if ((!EMIT_APPROVAL && !EMIT_APPROVAL_NONBINARY) || approvalRequested) return;
  approvalRequested = true;
  approvalResolved = false;
  const reqId = 'req-approval-1';
  const method = EMIT_APPROVAL_NONBINARY ? 'item/permissions/requestApproval' : 'item/commandExecution/requestApproval';
  serverRequests.set(reqId, { method, resolved: false });
  const params = EMIT_APPROVAL_NONBINARY
    ? { threadId, turnId, itemId: 'item-1', startedAtMs: Date.now(), cwd: process.cwd(), reason: 'fake non-binary approval', permissions: { oauth: null } }
    : { threadId, turnId, itemId: 'item-1', startedAtMs: Date.now(), approvalId: 'cb-1', reason: 'fake approval', command: 'echo hi', cwd: process.cwd(), commandActions: [], availableDecisions: ['accept', 'acceptForSession', 'decline'] };
  process.stdout.write(JSON.stringify({ id: reqId, method, params }) + '\n');
}

function maybeReEmitApproval(threadId, turnId) {
  if (!approvalRequested || approvalResolved) return;
  const method = EMIT_APPROVAL_NONBINARY ? 'item/permissions/requestApproval' : 'item/commandExecution/requestApproval';
  serverRequests.set('req-approval-1', { method, resolved: false });
  const params = EMIT_APPROVAL_NONBINARY
    ? { threadId, turnId, itemId: 'item-1', startedAtMs: Date.now(), cwd: process.cwd(), reason: 'fake non-binary approval', permissions: { oauth: null } }
    : { threadId, turnId, itemId: 'item-1', startedAtMs: Date.now(), approvalId: 'cb-1', reason: 'fake approval', command: 'echo hi', cwd: process.cwd(), commandActions: [], availableDecisions: ['accept', 'acceptForSession', 'decline'] };
  process.stdout.write(JSON.stringify({ id: 'req-approval-1', method, params }) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;

  if (id != null && (msg.result !== undefined || msg.error !== undefined)) {
    const sr = serverRequests.get(String(id));
    if (sr) { sr.resolved = true; approvalResolved = true; saveState(); }
    return;
  }

  switch (method) {
    case 'initialize':
      return respond(id, { userAgent: 'fake-app-server', codexHome: process.cwd(), platformFamily: 'unix', platformOs: 'linux' });

    case 'thread/start': {
      const threadId = 'thread-' + (threads.size + 1);
      const thread = fakeThread(threadId); if (process.env.FAKE_APP_SERVER_REQUIRE_SANDBOX === '1' && !(params && params.sandbox)) return respondError(id, { code: -32000, message: 'sandbox required' }); thread.sandbox = (params && params.sandbox) || null;
      threads.set(threadId, thread);
      saveState();
      return respond(id, {
        thread,
        model: 'fake', modelProvider: 'openai', serviceTier: null,
        cwd: (params && params.cwd) || process.cwd(),
        runtimeWorkspaceRoots: [], instructionSources: [],
        approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandbox: (thread && thread.sandbox) || 'workspace-write', activePermissionProfile: null,
        reasoningEffort: null, multiAgentMode: 'explicitRequestOnly',
      });
    }

    case 'thread/resume': {
      const threadId = params && params.threadId;
      const thread = threads.get(threadId);
      if (!thread) return respondError(id, { code: -32601, message: `thread not found: ${threadId}` });
      const activeTurn = currentTurns().find((t) => t.status === 'inProgress' || t.status === 'interrupted');
      maybeReEmitApproval(threadId, activeTurn ? activeTurn.id : null);
      return respond(id, {
        thread: threadWithTurns(threadId),
        model: 'fake', modelProvider: 'openai', serviceTier: null,
        cwd: thread.cwd, runtimeWorkspaceRoots: [], instructionSources: [],
        approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandbox: (thread && thread.sandbox) || 'workspace-write', activePermissionProfile: null,
        reasoningEffort: null, multiAgentMode: 'explicitRequestOnly',
        initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null,
      });
    }

    case 'turn/start': {
      if (FAIL_TURN_START) return respondError(id, { code: -32000, message: 'fake turn/start failure' });
      const threadId = params && params.threadId;
      const thread = threads.get(threadId);
      if (!thread) return respondError(id, { code: -32601, message: `thread not found: ${threadId}` });
      const turnId = 'turn-' + (turns.size + 1);
      const turn = fakeTurn(turnId, 'inProgress', []);
      turns.set(turnId, turn);
      saveState();
      notify('turn/started', { threadId, turn });
      setTimeout(() => {
        const curStatus = turns.get(turnId) && turns.get(turnId).status;
        if (curStatus === 'interrupted' || curStatus === 'completed' || curStatus === 'failed') { saveState(); return; }
        const done = fakeTurn(turnId, (process.env.FAKE_APP_SERVER_TURN_FAIL === '1' ? 'failed' : 'completed'), [
          { id: 'item-user', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'USER_INPUT_MARKER' }] },
          { id: 'item-userout', type: 'message', role: 'user', content: [{ type: 'output_text', text: 'USER_OUTPUT_TEXT_MARKER' }] },
          { id: 'item-reason', type: 'reasoning', summary: [], content: [{ type: 'text', text: 'REASONING_MARKER' }], encrypted_content: null },
          { id: 'item-fc', type: 'function_call', name: 'bash', arguments: '{"cmd":"FUNCTION_CALL_MARKER"}', call_id: 'c1' },
          { id: 'item-fco', type: 'function_call_output', call_id: 'c1', output: { type: 'text', text: 'TOOL_OUTPUT_MARKER' } },
          { id: 'item-tool', type: 'custom_tool_call', call_id: 'c1', name: 'tool', input: '{"x":"TOOL_INPUT_MARKER"}' },
          { id: 'item-toolout', type: 'custom_tool_call_output', call_id: 'c1', output: { type: 'text', text: 'TOOL_OUTPUT_MARKER' } },
          { id: 'item-sim', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ASSISTANT_OUTPUT_TEXT_MARKER' }] },
          { id: 'item-am', type: 'agent_message', author: 'assistant', recipient: 'user', content: [{ type: 'input_text', text: 'TASK_DONE_MARKER' }] },
        ], { startedAt: 0, completedAt: Date.now() });
        turns.set(turnId, done);
        saveState();
        notify('turn/completed', { threadId, turn: done });
      }, SLOW_TURN ? 2000 : 10);
      maybeEmitApproval(threadId, turnId);
      return respond(id, { turn });
    }

    case 'thread/read': {
      const threadId = params && params.threadId;
      const thread = threads.get(threadId);
      if (!thread) return respondError(id, { code: -32601, message: `thread not found: ${threadId}` });
      return respond(id, { thread: threadWithTurns(threadId) });
    }

    case 'turn/interrupt': {
      const { threadId, turnId } = params || {};
      const t = turns.get(turnId);
      if (!t) return respondError(id, { code: -32602, message: `turn not found: ${turnId}` });
      if (process.env.FAKE_APP_SERVER_NO_CONFIRM_INTERRUPT === '1') { saveState(); return respond(id, {}); }
      const it = fakeTurn(turnId, 'interrupted', t.items || [], { startedAt: t.startedAt || 0, completedAt: Date.now() });
      turns.set(turnId, it);
      saveState();
      notify('turn/completed', { threadId, turn: it });
      return respond(id, {});
    }

    default:
      return respondError(id, { code: -32601, message: `method not found: ${method}` });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => { if (!line.trim()) return; try { handle(JSON.parse(line)); } catch (e) { /* ignore */ } });
rl.on('close', () => process.exit(0));

if (DIE_MS !== null) setTimeout(() => process.exit(0), DIE_MS);

// keep alive until stdin closes
setTimeout(() => {}, 1 << 30);
