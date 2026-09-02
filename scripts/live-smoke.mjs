// chatgpt-codex-orchestrator: live 3-nonce Proof-of-Transport smoke (M1).
// Must be driven inside the node REPL (the Codex in-app browser runtime), e.g.:
//   import { runLiveSmoke } from 'file:///.../scripts/live-smoke.mjs'
//   const ev = await runLiveSmoke()
//   nodeRepl.write(JSON.stringify(ev, null, 2))
import { InAppBrowserTransport, openBrainSession } from '../src/legacy/iab-transport.js';

function nonce(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
}

export async function runLiveSmoke() {
  const transport = new InAppBrowserTransport();

  // Record pre-existing IAB tabs so we can prove we only add our owned tab.
  await transport.connect();
  const beforeTabs = await transport.browser.tabs.list();
  const beforeTabIds = beforeTabs.map((t) => t.id);

  const session = await openBrainSession(transport);
  const rounds = [];
  let failed = null;

  try {
    for (let i = 1; i <= 3; i++) {
      const n = nonce('ORCHESTRATOR_SMOKE');
      const res = await session.send(
        `${n}\n\nThis is a transport test. Reply by quoting exactly this token as the first thing: ${n}`,
        { nonce: n }
      );
      rounds.push({
        round: i,
        ...res,
        nonce: n,
        nonceEchoed: res.reply.includes(n),
      });
    }
  } catch (e) {
    failed = { name: e.name, message: e.message };
  }

  const afterTabs = await transport.browser.tabs.list();
  const afterTabIds = afterTabs.map((t) => t.id);
  const addedTabs = afterTabIds.filter((id) => !beforeTabIds.includes(id));

  const ownedTabIds = rounds.map((r) => r.ownedTabId);
  const convIds = rounds.map((r) => r.conversationId);
  const counts = rounds.map((r) => r.afterCount);

  const evidence = {
    browserType: 'iab',
    rounds,
    ownedTabIdStable: new Set(ownedTabIds).size === 1 && ownedTabIds.length === 3,
    conversationIdStable: new Set(convIds).size === 1 && convIds.length === 3,
    assistantCountIncrements: counts.every((c, idx) => (idx === 0 ? true : c === counts[idx - 1] + 1)),
    eachRoundIsNewReply: rounds.every((r) => r.afterCount === r.beforeCount + 1),
    allNoncesEchoed: rounds.every((r) => r.nonceEchoed),
    singleOwnedTabAdded: addedTabs.length === 1,
    addedTabIds: addedTabs,
    otherTabsUntouched: afterTabIds.filter((id) => beforeTabIds.includes(id)).length === beforeTabIds.length,
    failed,
  };

  if (failed) {
    await session.close().catch(() => {});
  }

  return evidence;
}