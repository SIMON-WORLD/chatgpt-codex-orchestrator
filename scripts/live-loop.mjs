// chatgpt-codex-orchestrator: M2 live Brain <-> Codex executor loop.
// Must run inside the Codex Node REPL (in-app browser runtime). Usage:
//   const { runLiveLoop } = await import('file:///.../scripts/live-loop.mjs')
//   const ev = await runLiveLoop({ repoDir, goal })
//   nodeRepl.write(JSON.stringify(ev, null, 2))
import { InAppBrowserTransport, openBrainSession } from '../src/legacy/iab-transport.js';
import { CodexExecutor } from '../src/legacy/codex-executor.js';
import { LoopController } from '../src/legacy/loop-controller.js';

export async function runLiveLoop({ repoDir, goal, turnOptions = {} }) {
  const transport = new InAppBrowserTransport();
  await transport.connect();
  const beforeTabs = await transport.browser.tabs.list();
  const beforeTabIds = beforeTabs.map((t) => t.id);

  const brain = await openBrainSession(transport, { turnOptions });
  const executor = new CodexExecutor({ repoDir });
  const controller = new LoopController({ brain, executor });

  let result;
  try {
    result = await controller.run(goal);
  } catch (e) {
    result = { done: false, stoppedAt: 'ERROR', error: e.message, log: [] };
  }

  const afterTabs = await transport.browser.tabs.list();
  const afterTabIds = afterTabs.map((t) => t.id);
  const addedTabs = afterTabIds.filter((id) => !beforeTabIds.includes(id));

  return {
    ...result,
    ownedTabId: brain.ownedTabId,
    brainConversationId: brain.conversationId,
    executorSessionId: executor.sessionId,
    singleOwnedTabAdded: addedTabs.length === 1,
    addedTabIds: addedTabs,
    otherTabsUntouched: afterTabIds.filter((id) => beforeTabIds.includes(id)).length === beforeTabIds.length,
  };
}