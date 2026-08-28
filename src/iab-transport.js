// chatgpt-codex-orchestrator: InAppBrowserTransport + BrainSession.
// Default transport = the Codex in-app browser (iab).
// One BrainSession owns exactly one tab and one ChatGPT conversation (/c/<id>).
// It never touches the user's other IAB tabs; it creates its own owned tab.
import { AtomicTurnController, extractConversationId } from './atomic-turn.js';

const DEFAULT_BROWSER_CLIENT_PATH =
  'file:///C:/Users/Administrator/.codex/plugins/cache/openai-bundled/chrome/26.820.71523/scripts/browser-client.mjs';

export class InAppBrowserTransport {
  constructor({ browserClientPath } = {}) {
    this.browserClientPath = browserClientPath || DEFAULT_BROWSER_CLIENT_PATH;
    this.agent = null;
    this.browser = null;
  }

  async connect() {
    if (this.agent) return this;
    const { setupBrowserRuntime } = await import(this.browserClientPath);
    this.agent = await setupBrowserRuntime();
    try {
      this.browser = await this.agent.browsers.get('iab');
    } catch (e) {
      this.browser = await this.agent.browsers.getForUrl('https://chatgpt.com/');
    }
    if (!this.browser) throw new Error('no browser available: could not get the Codex in-app browser');
    return this;
  }

  // Create our OWN tab (an "owned tab"). Does not touch existing tabs.
  async createSessionTab({ url = 'https://chatgpt.com/' } = {}) {
    await this.connect();
    const tab = await this.browser.tabs.new();
    const facade = createTabFacade(tab);
    await tab.goto(url);
    await tab.playwright.waitForLoadState('domcontentloaded').catch(() => {});
    return { tab, facade };
  }

  async closeTab(tab) {
    if (!tab) return;
    try { await tab.close(); } catch (e) { /* best effort */ }
  }
}

// Wraps a Playwright tab into a PageFacade consumed by AtomicTurnController.
export function createTabFacade(tab) {
  const w = tab.playwright;
  return {
    async isComposerReady() {
      try { return (await w.locator('[contenteditable="true"]').count()) > 0; }
      catch (e) { return false; }
    },
    async isComposerIdle() {
      try {
        const editor = w.locator('[contenteditable="true"]').first();
        const txt = (await editor.innerText()) || '';
        return txt.trim() === '';
      } catch (e) { return false; }
    },
    async sendMessage(text) {
      const editor = w.locator('[contenteditable="true"]').first();
      await editor.fill('');
      await w.waitForTimeout(200);
      await editor.fill(text);
      await w.waitForTimeout(400);
      // Confirm the text actually landed (React re-render safety) before submitting.
      let cur = '';
      try { cur = await editor.innerText(); } catch (e) { cur = ''; }
      if (!cur.includes(text.slice(0, 20))) {
        await editor.fill(text);
        await w.waitForTimeout(400);
      }
      await editor.press('Enter');
    },
    async getAssistantCount() {
      try { return await w.locator('[data-message-author-role="assistant"]').count(); }
      catch (e) { return -1; }
    },
    async getAssistantReply(n) {
      try { return (await w.locator('[data-message-author-role="assistant"]').nth(n).innerText()).trim(); }
      catch (e) { return ''; }
    },
    async getCurrentUrl() {
      try { return await tab.url(); }
      catch (e) { return ''; }
    },
  };
}

export class BrainSession {
  constructor({ transport, tab, facade, conversationId = null, conversationUrl = null, turnOptions = {} }) {
    this.transport = transport;
    this.tab = tab;
    this.facade = facade;
    this.ownedTabId = tab.id;
    this.conversationId = conversationId;
    this.conversationUrl = conversationUrl;
    this.atomic = new AtomicTurnController(facade, turnOptions);
  }

  get isBound() { return Boolean(this.conversationId); }

  // Send one message and read the new turn's reply. First send captures the real
  // /c/<conversation-id>; every later send verifies it did not change.
  async send(text, { nonce } = {}) {
    const expectedConversationId = this.conversationId || null;
    const res = await this.atomic.sendAndRead({ text, nonce, expectedConversationId });

    if (!this.conversationId) {
      const url = await this.facade.getCurrentUrl();
      const id = extractConversationId(url);
      this.conversationUrl = url || null;
      this.conversationId = id || null;
    } else {
      const url = await this.facade.getCurrentUrl();
      if (url) this.conversationUrl = url;
    }

    return {
      reply: res.reply,
      beforeCount: res.beforeCount,
      afterCount: res.afterCount,
      ownedTabId: this.ownedTabId,
      conversationId: this.conversationId,
      conversationUrl: this.conversationUrl,
    };
  }

  async close() { await this.transport.closeTab(this.tab); }
}

// Convenience: connect + create an owned tab + return a bound BrainSession.
export async function openBrainSession(transport, { url = 'https://chatgpt.com/', turnOptions = {} } = {}) {
  await transport.connect();
  const { tab, facade } = await transport.createSessionTab({ url });
  return new BrainSession({ transport, tab, facade, turnOptions });
}

// Re-attach to an existing owned tab (by id) and rebuild a BrainSession bound to a
// known conversation. Used across REPL calls so the loop keeps ONE conversation.
export async function openBrainSessionExisting(transport, { tabId, conversationId = null, conversationUrl = null, turnOptions = {} } = {}) {
  await transport.connect();
  const tab = await transport.browser.tabs.get(tabId);
  const facade = createTabFacade(tab);
  return new BrainSession({ transport, tab, facade, conversationId, conversationUrl, turnOptions });
}

// Adopt the user's CURRENT IAB conversation (no new conversation). Reads the selected
// tab URL, extracts /c/<conversationId>, and binds a BrainSession to it (not a new tab).
export async function openCurrentConversation(transport) {
  await transport.connect();
  let tab;
  try { tab = await transport.browser.tabs.selected(); }
  catch (e) { throw new Error('no selected IAB tab: ' + e.message); }
  if (!tab) throw new Error('no selected IAB tab');
  const url = await tab.url().catch(() => '');
  const id = extractConversationId(url);
  if (!id) throw new Error('current tab is not a ChatGPT conversation: ' + url);
  const facade = createTabFacade(tab);
  return new BrainSession({ transport, tab, facade, conversationId: id, conversationUrl: url });
}

export class ConversationIdentityMismatchError extends Error {
  constructor(msg) { super(msg); this.name = 'ConversationIdentityMismatchError'; }
}

// Adopt: capture the REAL conversation identity of the selected IAB tab, and freeze it.
// Does NOT create a new conversation. Throws if the selected tab is not a /c/<id>.
export async function captureCurrentConversation(transport) {
  await transport.connect();
  let tab;
  try { tab = await transport.browser.tabs.selected(); }
  catch (e) { throw new ConversationIdentityMismatchError('no selected IAB tab: ' + e.message); }
  if (!tab) throw new ConversationIdentityMismatchError('no selected IAB tab');
  const url = await tab.url().catch(() => '');
  const id = extractConversationId(url);
  if (!id) throw new ConversationIdentityMismatchError('current tab is not a ChatGPT conversation: ' + url);
  const facade = createTabFacade(tab);
  const brain = new BrainSession({ transport, tab, facade, conversationId: id, conversationUrl: url });
  return { tabId: tab.id, conversationId: id, conversationUrl: url, brain };
}

// Find a tab already open on a given conversationId.
async function findTabByConversation(transport, conversationId) {
  const tabs = await transport.browser.tabs.list().catch(() => []);
  for (const t of tabs) {
    try {
      const tab = await transport.browser.tabs.get(t.id);
      const u = await tab.url();
      if (extractConversationId(u) === conversationId) return tab;
    } catch (e) {}
  }
  return null;
}

// Re-open / rebind a brain to the SAME conversation from persisted state (A..E).
// Never follows tabs.selected(); only re-binds to the persisted conversationId.
export async function reopenConversationFromBinding(transport, state) {
  await transport.connect();
  const wantedId = state.conversationId;
  const wantedUrl = state.conversationUrl;
  let tab = null, url = '';

  // A) original tab still alive + same conversation
  if (state.ownedTabId) {
    try {
      tab = await transport.browser.tabs.get(state.ownedTabId);
      url = await tab.url();
      if (extractConversationId(url) === wantedId) return bindBrain(transport, tab, state);
    } catch (e) { /* tab lost */ }
  }
  // B/C) search open tabs for the same conversationId
  tab = await findTabByConversation(transport, wantedId);
  if (tab) { url = await tab.url(); return bindBrain(transport, tab, state); }
  // D) open the saved conversationUrl and validate actual id
  tab = await transport.browser.tabs.new();
  await tab.goto(wantedUrl);
  await tab.playwright.waitForLoadState('domcontentloaded').catch(() => {});
  await tab.playwright.waitForTimeout(4000);
  url = await tab.url();
  const actualId = extractConversationId(url);
  if (actualId !== wantedId) {
    try { await tab.close(); } catch (e) {}
    throw new ConversationIdentityMismatchError(`requested /c/${wantedId} but opened ${url}`);
  }
  // E) mismatch would have failed above; mark this as orchestrator-owned recovery tab
  const res = bindBrain(transport, tab, state);
  res.recoveryTab = true;
  return res;
}

function bindBrain(transport, tab, state) {
  const facade = createTabFacade(tab);
  const brain = new BrainSession({ transport, tab, facade, conversationId: state.conversationId, conversationUrl: state.conversationUrl });
  return { tabId: tab.id, conversationId: state.conversationId, conversationUrl: state.conversationUrl, brain };
}