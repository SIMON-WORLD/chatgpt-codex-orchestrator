import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChatGPTBrowserProvider,
  DEFAULT_DIRECT_CONFIG,
  DIRECT_MODE_REQUIRES,
  newDirectTaskState,
  ConversationNotFoundError,
  ConversationAmbiguityError,
  DEFAULT_TAKEOVER_MESSAGE,
} from '../src/legacy/direct-mode.js';
import { ConversationIdentityMismatchError } from '../src/legacy/iab-transport.js';

// --- Mock browser transport (no real browser, no worker, no nested Codex) ---
function makeMockTab({ id, gotoOverrides = {} }) {
  const tab = {
    id,
    _url: 'https://chatgpt.com/',
    _closed: false,
    async goto(url) { tab._url = (gotoOverrides[url] !== undefined) ? gotoOverrides[url] : url; },
    async url() { return tab._url; },
    async close() { tab._closed = true; },
    playwright: {
      async evaluate() {},
      async waitForTimeout() {},
      async waitForLoadState() {},
      async locator() { return { count: async () => 0, first: () => ({ innerText: async () => '', fill: async () => {}, press: async () => {} }), nth: () => ({ innerText: async () => '' }) }; },
    },
  };
  return tab;
}

function makeMockTransport(opts = {}) {
  const { titleMatches = [], hrefToUrl = {}, selectedUrl = null, gotoOverrides = {}, failNoSelected = false } = opts;
  let tabCounter = 0;
  const tabs = [];
  const browser = {
    tabs: {
      async new() { const tab = makeMockTab({ id: 'tab-' + (++tabCounter), gotoOverrides }); tabs.push(tab); return tab; },
      async get(id) { return tabs.find((t) => t.id === id) || null; },
      async selected() {
        if (failNoSelected) throw new Error('no selected IAB tab');
        let tab = tabs.find((t) => t._url === selectedUrl);
        if (!tab && selectedUrl) { tab = makeMockTab({ id: 'tab-sel', gotoOverrides }); tab._url = selectedUrl; tabs.push(tab); }
        return tab || null;
      },
      async list() { return tabs.slice(); },
    },
  };
  const transport = {
    browser,
    _tabs: tabs,
    _tabCounter: () => tabCounter,
    async connect() {},
    async closeTab() {},
    async findConversationLinksByTitle() { return titleMatches; },
    async openConversationByHref(tab, href) { const url = hrefToUrl[href] || `https://chatgpt.com${href}`; tab._url = url; return url; },
  };
  return transport;
}

test('adopt by conversation URL succeeds and binds identity', async () => {
  const t = makeMockTransport({ gotoOverrides: { 'https://chatgpt.com/c/task-abc': 'https://chatgpt.com/c/task-abc' } });
  const p = createChatGPTBrowserProvider({ transport: t });
  const id = await p.adoptConversation({ conversationUrl: 'https://chatgpt.com/c/task-abc' });
  assert.equal(id.conversationId, 'task-abc');
  assert.equal(id.conversationUrl, 'https://chatgpt.com/c/task-abc');
  assert.ok(id.tabId);
  assert.equal(p.identifyConversation().conversationId, 'task-abc');
});

test('adopt by conversation ID validates and binds', async () => {
  const t = makeMockTransport({ gotoOverrides: { 'https://chatgpt.com/c/task-xyz': 'https://chatgpt.com/c/task-xyz' } });
  const p = createChatGPTBrowserProvider({ transport: t });
  const id = await p.adoptConversation({ conversationId: 'task-xyz' });
  assert.equal(id.conversationId, 'task-xyz');
  assert.equal(p.identifyConversation().conversationId, 'task-xyz');
});

test('identity mismatch (requested /c/A but opened /c/B) fails and does not bind', async () => {
  const t = makeMockTransport({ gotoOverrides: { 'https://chatgpt.com/c/task-abc': 'https://chatgpt.com/c/OTHER' } });
  const p = createChatGPTBrowserProvider({ transport: t });
  await assert.rejects(() => p.adoptConversation({ conversationUrl: 'https://chatgpt.com/c/task-abc' }), ConversationIdentityMismatchError);
  assert.equal(p.identifyConversation(), null);
});

test('title unique match opens and captures real /c/<id>, reusing the conversation', async () => {
  const t = makeMockTransport({
    titleMatches: [{ id: 'task-title-1', href: '/c/task-title-1' }],
    hrefToUrl: { '/c/task-title-1': 'https://chatgpt.com/c/task-title-1' },
  });
  const p = createChatGPTBrowserProvider({ transport: t });
  const id = await p.adoptConversation({ title: 'agent-credentials-skill \u8bbe\u8ba1' });
  assert.equal(id.conversationId, 'task-title-1');
  assert.equal(id.conversationUrl, 'https://chatgpt.com/c/task-title-1');
  assert.equal(t._tabCounter(), 1, 'only one tab created; the same conversation is reused');
  assert.equal(p._session.conversationId, 'task-title-1', 'bound BrainSession keeps the same conversation');
  assert.equal(p._session.isBound, true);
});

test('title no match fails without creating a new conversation', async () => {
  const t = makeMockTransport({ titleMatches: [] });
  const p = createChatGPTBrowserProvider({ transport: t });
  await assert.rejects(() => p.adoptConversation({ title: 'no-such-conversation' }), ConversationNotFoundError);
  assert.equal(t._tabCounter(), 1, 'only the search tab was created');
  assert.ok(t._tabs[0]._closed, 'search tab was closed; no new conversation');
  assert.equal(p.identifyConversation(), null);
});

test('duplicate title returns ambiguity / ASK_USER and does not guess', async () => {
  const t = makeMockTransport({ titleMatches: [{ id: 'a', href: '/c/a' }, { id: 'b', href: '/c/b' }] });
  const p = createChatGPTBrowserProvider({ transport: t });
  await assert.rejects(() => p.adoptConversation({ title: 'dup-title' }), ConversationAmbiguityError);
  assert.ok(t._tabs[0]._closed, 'no conversation was opened; does not guess');
  assert.equal(p.identifyConversation(), null);
});

test('adoptCurrent uses the current selected conversation', async () => {
  const t = makeMockTransport({ selectedUrl: 'https://chatgpt.com/c/current-1' });
  const p = createChatGPTBrowserProvider({ transport: t });
  const id = await p.adoptCurrent();
  assert.equal(id.conversationId, 'current-1');
  assert.equal(p.identifyConversation().conversationId, 'current-1');
});

test('title lookup does not require the user to pre-open the target conversation', async () => {
  // selected() throws, proving title lookup never depends on a selected tab.
  const t = makeMockTransport({ titleMatches: [{ id: 'task-title-1', href: '/c/task-title-1' }], hrefToUrl: { '/c/task-title-1': 'https://chatgpt.com/c/task-title-1' }, failNoSelected: true });
  const p = createChatGPTBrowserProvider({ transport: t });
  const id = await p.adoptConversation({ title: 'agent-credentials-skill \u8bbe\u8ba1' });
  assert.equal(id.conversationId, 'task-title-1');
});

test('same conversation reused for RESULT (bound BrainSession, no new conversation)', async () => {
  const t = makeMockTransport({ titleMatches: [{ id: 'task-title-2', href: '/c/task-title-2' }], hrefToUrl: { '/c/task-title-2': 'https://chatgpt.com/c/task-title-2' } });
  const p = createChatGPTBrowserProvider({ transport: t });
  const id = await p.adoptConversation({ title: 'project chat' });
  // identifyConversation returns the same adopted id; a RESULT would use the same session.
  assert.equal(p.identifyConversation().conversationId, 'task-title-2');
  assert.equal(p._session.conversationId, 'task-title-2');
  assert.equal(t._tabCounter(), 1);
});

test('current Codex remains the executor and no worker/nested-Codex dependency', () => {
  assert.equal(newDirectTaskState({ taskId: 't', repoDir: '/r' }).executor, 'current-codex');
  assert.equal(DIRECT_MODE_REQUIRES.workerBootstrap, false);
  assert.equal(DIRECT_MODE_REQUIRES.nestedCodex, false);
  assert.equal(DIRECT_MODE_REQUIRES.readyFile, false);
  assert.equal(DIRECT_MODE_REQUIRES.localhostTcp, false);
  assert.equal(DIRECT_MODE_REQUIRES.authTokenHandshake, false);
  assert.equal(DEFAULT_DIRECT_CONFIG.executor, 'current-codex');
});

test('normal new-conversation mode unchanged; adoptConversation requires an argument', async () => {
  const t = makeMockTransport();
  const p = createChatGPTBrowserProvider({ transport: t });
  assert.equal(typeof p.open, 'function');
  assert.equal(DEFAULT_DIRECT_CONFIG.conversation, 'reuse');
  assert.equal(DEFAULT_DIRECT_CONFIG.brainProvider, 'chatgpt');
  assert.equal(p.identifyConversation(), null, 'before adopt/open there is no conversation');
  await assert.rejects(() => p.adoptConversation({}), /requires conversationUrl, conversationId, or title/);
});

test('takeover message exists and does not dump full history', () => {
  assert.ok(DEFAULT_TAKEOVER_MESSAGE.includes('Continue this existing project conversation.'));
  assert.ok(DEFAULT_TAKEOVER_MESSAGE.includes('ChatGPT now owns PLAN / TASK / REVISE / DONE.'));
  assert.ok(DEFAULT_TAKEOVER_MESSAGE.length < 1600, 'takeover message is compact (contract + governance, no history dump)');
});
