// chatgpt-codex-orchestrator: M2.1 Runtime Host.
// Single entry for a task. It runs in the node REPL (owns the in-app-browser
// BrainSession) and delegates every Codex execution to a long-lived Codex worker
// (normal Node process) over localhost JSON-line sockets. The loop runs to DONE /
// ASK_USER without the agent calling browser/executor per round.
import net from 'node:net';
import { InAppBrowserTransport, openBrainSession } from '../src/iab-transport.js';
import { LoopController } from '../src/loop-controller.js';

export class CodexWorkerClient {
  constructor({ host = '127.0.0.1', port, token = null, taskId = null }) {
    this.host = host; this.port = port;
    this.token = token; this.taskId = taskId;
    this.id = 0; this.pending = new Map(); this.buf = '';
    this.sessionId = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, this.host, () => resolve());
      this.sock.on('error', reject);
      this.sock.on('data', (d) => {
        this.buf += d.toString();
        let nl;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          const waiter = this.pending.get(msg.id);
          if (waiter) { this.pending.delete(msg.id); waiter(msg); }
        }
      });
    });
  }
  request(payload) {
    const id = ++this.id;
    const p = new Promise((resolve) => this.pending.set(id, resolve));
    this.sock.write(JSON.stringify({ id, ...payload }) + '\n');
    return p;
  }
  async execute(prompt) {
    const msg = await this.request({ prompt });
    if (msg.error) return { sessionId: this.sessionId || null, resultText: '', success: false, error: msg.error };
    this.sessionId = msg.sessionId || this.sessionId;
    return { sessionId: this.sessionId, resultText: msg.resultText, success: msg.success, error: msg.error };
  }
  async shutdown() {
    try { await this.request({ shutdown: true }); } catch (e) {}
    try { this.sock.end(); } catch (e) {}
  }
}

// `executor` facade used by LoopController; forwards to the worker.
function workerFacade(worker) {
  return {
    async execute(prompt) { return worker.execute(prompt); },
    get sessionId() { return worker.sessionId; },
  };
}

export async function runRuntimeHost({ repoDir, goal, worker, turnOptions = {} }) {
  await worker.connect();
  const executor = workerFacade(worker);
  const transport = new InAppBrowserTransport();
  const brain = await openBrainSession(transport, { turnOptions });
  const controller = new LoopController({ brain, executor });

  let result;
  try { result = await controller.run(goal); }
  catch (e) { result = { done: false, stoppedAt: 'ERROR', error: e.message, log: [] }; }

  await worker.shutdown();
  return {
    ...result,
    ownedTabId: brain.ownedTabId,
    conversationId: brain.conversationId,
    conversationUrl: brain.conversationUrl,
    executorSessionId: executor.sessionId,
  };
}