// chatgpt-codex-orchestrator: M2.1 Runtime Host (legacy single-shot entry).
// NOTE: The canonical brain-command path is scripts/brain-command-launcher.mjs
// (TaskService + createTask/advanceTask). runRuntimeHost is retained for backward
// compatibility and live-smoke/harness usage only; it is NOT the canonical path.
import { InAppBrowserTransport, openBrainSession } from '../src/iab-transport.js';
import { LoopController } from '../src/loop-controller.js';
import { CodexWorkerClient } from '../src/worker-client.js';

export { CodexWorkerClient };

// `executor` facade used by LoopController; forwards to the worker.
export function workerFacade(worker) {
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
  finally { try { await worker.shutdown(); } catch (e) {} }

  return {
    ...result,
    ownedTabId: brain.ownedTabId,
    conversationId: brain.conversationId,
    conversationUrl: brain.conversationUrl,
    executorSessionId: executor.sessionId,
  };
}
