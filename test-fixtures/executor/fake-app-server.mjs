// test/executor/fixtures/fake-app-server.mjs
// Deterministic fake Codex App Server for M1 protocol tests.
// Speaks newline-delimited JSON-RPC over stdio using the same protocol shape as
// `codex app-server` (codex-cli 0.146.0, `codex app-server generate-ts`).
//
// Env flags:
//   FAKE_APP_SERVER_APPROVAL=1  -> emit one item/commandExecution/requestApproval
//   FAKE_APP_SERVER_DIE_MS=N    -> simulate unexpected process death after N ms

import { createInterface } from 'node:readline';

const threads = new Map();   // threadId -> thread
const turns = new Map();     // turnId -> turn
let approvalRequested = false;

const EMIT_APPROVAL = process.env.FAKE_APP_SERVER_APPROVAL === '1';
const DIE_MS = process.env.FAKE_APP_SERVER_DIE_MS ? Number(process.env.FAKE_APP_SERVER_DIE_MS) : null;

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

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return respond(id, { userAgent: 'fake-app-server', codexHome: process.cwd(), platformFamily: 'unix', platformOs: 'linux' });

    case 'thread/start': {
      const threadId = 'thread-' + (threads.size + 1);
      const thread = fakeThread(threadId);
      threads.set(threadId, thread);
      return respond(id, {
        thread,
        model: 'fake', modelProvider: 'openai', serviceTier: null,
        cwd: (params && params.cwd) || process.cwd(),
        runtimeWorkspaceRoots: [], instructionSources: [],
        approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandbox: 'workspace-write', activePermissionProfile: null,
        reasoningEffort: null, multiAgentMode: 'explicitRequestOnly',
      });
    }

    case 'turn/start': {
      const threadId = params && params.threadId;
      const thread = threads.get(threadId);
      if (!thread) return respondError(id, { code: -32601, message: `thread not found: ${threadId}` });
      const turnId = 'turn-' + (turns.size + 1);
      const turn = fakeTurn(turnId, 'inProgress', []);
      turns.set(turnId, turn);
      notify('turn/started', { threadId, turn });
      setTimeout(() => {
        const done = fakeTurn(turnId, 'completed', [{ id: 'item-1', type: 'agent_message', payload: 'task done' }], { startedAt: 0, completedAt: Date.now() });
        turns.set(turnId, done);
        notify('turn/completed', { threadId, turn: done });
      }, 10);
      if (EMIT_APPROVAL && !approvalRequested) {
        approvalRequested = true;
        const reqId = 'req-approval-1';
        process.stdout.write(JSON.stringify({
          id: reqId, method: 'item/commandExecution/requestApproval',
          params: {
            threadId, turnId, itemId: 'item-1', startedAtMs: Date.now(),
            reason: 'fake approval', command: 'echo hi', cwd: process.cwd(),
            commandActions: [], availableDecisions: ['approve', 'deny'],
          },
        }) + '\n');
      }
      return respond(id, { turn });
    }

    case 'thread/read': {
      const threadId = params && params.threadId;
      const thread = threads.get(threadId);
      if (!thread) return respondError(id, { code: -32601, message: `thread not found: ${threadId}` });
      const allTurns = [...turns.entries()].map(([, t]) => t).filter(Boolean);
      const threadWithTurns = {
        ...thread,
        status: allTurns.some((t) => t.status === 'inProgress') ? 'running' : 'idle',
        turns: params.includeTurns ? allTurns : [],
      };
      return respond(id, { thread: threadWithTurns });
    }

    case 'turn/interrupt': {
      const { threadId, turnId } = params || {};
      const t = turns.get(turnId);
      if (!t) return respondError(id, { code: -32602, message: `turn not found: ${turnId}` });
      const it = fakeTurn(turnId, 'interrupted', t.items || [], { startedAt: t.startedAt || 0, completedAt: Date.now() });
      turns.set(turnId, it);
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
