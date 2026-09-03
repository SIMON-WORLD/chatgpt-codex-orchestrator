import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { InAppBrowserTransport, IABUnavailableError } from '../src/legacy/iab-transport.js';
import { createChatGPTBrowserProvider, DEFAULT_DIRECT_CONFIG, DIRECT_MODE_REQUIRES } from '../src/legacy/direct-mode.js';
import { __setMockBrowserState, __getBrowserCallLog } from './fixtures/mock-browser-runtime.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/mock-browser-runtime.mjs', import.meta.url));
const browserClientPath = pathToFileURL(fixturePath).href;
const EXISTING_ID = '6a91e45b-77f0-83ea-82bf-32f887010038';

test('connect() requests the in-app browser (iab) first and exclusively', async () => {
  __setMockBrowserState({ available: true });
  const t = new InAppBrowserTransport({ browserClientPath });
  await t.connect();
  const log = __getBrowserCallLog();
  assert.ok(log.length >= 1);
  assert.deepEqual(log[0], ['get', 'iab']);
  assert.ok(!log.some(([op]) => op === 'getForUrl'), 'external browser fallback must never be used');
});

test('unavailable iab fails with IABUnavailableError and never calls getForUrl', async () => {
  __setMockBrowserState({ available: false });
  const t = new InAppBrowserTransport({ browserClientPath });
  await assert.rejects(() => t.connect(), IABUnavailableError);
  assert.ok(!__getBrowserCallLog().some(([op]) => op === 'getForUrl'), 'must not fall back to getForUrl / external browser');
});

test('null iab (not just a throw) also fails and never calls getForUrl', async () => {
  __setMockBrowserState({ isNull: true });
  const t = new InAppBrowserTransport({ browserClientPath });
  await assert.rejects(() => t.connect(), IABUnavailableError);
  assert.ok(!__getBrowserCallLog().some(([op]) => op === 'getForUrl'));
});

test('default Direct Mode remains ChatGPT IAB + current Codex executor', () => {
  assert.equal(DEFAULT_DIRECT_CONFIG.brainProvider, 'chatgpt');
  assert.equal(DEFAULT_DIRECT_CONFIG.executor, 'current-codex');
  assert.equal(DIRECT_MODE_REQUIRES.nestedCodex, false);
  const p = createChatGPTBrowserProvider();
  assert.ok(p._transport instanceof InAppBrowserTransport, 'provider defaults to an IAB-only transport');
});

test('with IAB available, the provider opens a session on the in-app browser', async () => {
  __setMockBrowserState({ available: true });
  const t = new InAppBrowserTransport({ browserClientPath });
  const provider = createChatGPTBrowserProvider({ transport: t });
  const id = await provider.open({ url: 'https://chatgpt.com/' });
  assert.ok(id.tabId);
  assert.ok(!__getBrowserCallLog().some(([op]) => op === 'getForUrl'));
});

test('existing-conversation title adoption still works with an injected IAB transport', async () => {
  // Injected transport that simulates the IAB + a history finder (no external browser).
  const tabs = [];
  const browser = {
    tabs: {
      async new() {
        const tab = {
          id: 'tab-' + (tabs.length + 1),
          _url: 'https://chatgpt.com/',
          async goto(url) { this._url = url; },
          async url() { return this._url; },
          async close() {},
          playwright: { async evaluate() {}, async waitForTimeout() {}, async waitForLoadState() {}, async locator() { return { count: async () => 0, first: () => ({ innerText: async () => '', fill: async () => {}, press: async () => {} }) }; } },
        };
        tabs.push(tab);
        return tab;
      },
      async get(id) { return tabs.find((x) => x.id === id) || null; },
      async selected() { return null; },
      async list() { return tabs.slice(); },
    },
  };
  const transport = {
    browser,
    async connect() {},
    async closeTab() {},
    async findConversationLinksByTitle() { return [{ id: EXISTING_ID, href: '/c/' + EXISTING_ID }]; },
    async openConversationByHref(tab, href) { tab._url = 'https://chatgpt.com' + href; return tab._url; },
  };
  const provider = createChatGPTBrowserProvider({ transport });
  const id = await provider.adoptConversation({ title: 'agent-credentials-skill \u8bbe\u8ba1' });
  assert.equal(id.conversationId, EXISTING_ID);
  assert.equal(provider.identifyConversation().conversationId, EXISTING_ID);
});
