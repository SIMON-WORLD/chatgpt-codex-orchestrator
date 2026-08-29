// chatgpt-codex-orchestrator: InAppBrowserTransport + BrainSession.
// Default transport = the Codex in-app browser (iab).
// One BrainSession owns exactly one tab and one ChatGPT conversation (/c/<id>).
// It never touches the user's other IAB tabs; it creates its own owned tab.
import { AtomicTurnController, extractConversationId, ComposerUnavailableError } from './atomic-turn.js';

const DEFAULT_BROWSER_CLIENT_PATH =
  'file:///C:/Users/Administrator/.codex/plugins/cache/openai-bundled/chrome/26.820.71523/scripts/browser-client.mjs';

export class IABUnavailableError extends Error {
  constructor(msg) { super(msg); this.name = 'IABUnavailableError'; }
}

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
    // Canonical brain-command Direct Mode uses the Codex in-app browser (iab) ONLY.
    // There is no fallback to getForUrl / Edge / Chrome / any external browser.
    let browser = null;
    try {
      browser = await this.agent.browsers.get('iab');
    } catch (e) {
      browser = null;
    }
    if (!browser) {
      throw new IABUnavailableError('Codex in-app browser (iab) is unavailable; brain-command Direct Mode requires the IAB and will NOT fall back to an external browser (Edge/Chrome)');
    }
    this.browser = browser;
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

  // Find ChatGPT history conversation links whose accessible label matches `title`.
  // Uses accessible name / text / ARIA and stable `a[href*="/c/"]` selectors, never a
  // fragile fixed nth-child. Returns [{ id, href }].
  async findConversationLinksByTitle(tab, title) {
    return (await tab.playwright.evaluate((target) => {
      const t = String(target || '').trim().toLowerCase();
      const anchors = Array.from(document.querySelectorAll('a[href*="/c/"]'));
      const seen = new Set();
      const out = [];
      for (const a of anchors) {
        const label = (a.getAttribute('aria-label') || a.textContent || '').trim();
        if (label.toLowerCase() === t) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/\/c\/([a-zA-Z0-9-]+)/);
          if (m && !seen.has(m[1])) { seen.add(m[1]); out.push({ id: m[1], href }); }
        }
      }
      return out;
    }, title));
  }

  // Open a found ChatGPT history conversation by clicking its link, then return the
  // resulting page URL (used by adoptByTitle to capture the real /c/<id>).
  async openConversationByHref(tab, href) {
    await tab.playwright.evaluate((h) => {
      const a = Array.from(document.querySelectorAll('a[href*="/c/"]')).find((x) => (x.getAttribute('href') || '') === h);
      if (a) a.click();
    }, href);
    await tab.playwright.waitForLoadState('domcontentloaded').catch(() => {});
    await tab.playwright.waitForTimeout(4000);
    return await tab.url();
  }

  async closeTab(tab) {
    if (!tab) return;
    try { await tab.close(); } catch (e) { /* best effort */ }
  }
}

// Locate the REAL ChatGPT composer (the prompt textarea) — never a historical
// user/assistant editable block. Returns a Playwright locator for exactly one
// confident composer, or null (fail closed) when it is ambiguous / not uniquely
// found. Relies on the stable structural id (#prompt-textarea) and an optional
// composer-scoped fallback; it never guesses with a bare [contenteditable].first().
async function resolveComposer(w) {
  try {
    const byId = w.locator('#prompt-textarea');
    const n = await byId.count();
    if (n === 1) {
      const insideMsg = await byId.evaluate((el) => !!el.closest('[data-message-author-role]')).catch(() => false);
      if (!insideMsg) return byId;
    }
    const scoped = w.locator('[data-testid*="composer"] [contenteditable="true"]');
    const sn = await scoped.count();
    if (sn === 1) {
      const insideMsg = await scoped.evaluate((el) => !!el.closest('[data-message-author-role]')).catch(() => false);
      if (!insideMsg) return scoped;
    }
    return null;
  } catch {
    return null;
  }
}

// Wraps a Playwright tab into a PageFacade consumed by AtomicTurnController.
export function createTabFacade(tab) {
  const w = tab.playwright;
  return {
    async isComposerReady() {
      return !!(await resolveComposer(w));
    },
    async isComposerIdle() {
      const c = await resolveComposer(w);
      if (!c) return false; // fail closed: no confident composer => not idle
      try {
        const txt = (await c.innerText()) || '';
        return txt.trim() === '';
      } catch (e) { return false; }
    },
    async sendMessage(text) {
      const c = await resolveComposer(w);
      if (!c) {
        throw new ComposerUnavailableError('ChatGPT composer not uniquely found; refusing to target a historical editable block');
      }
      await c.fill('');
      await w.waitForTimeout(200);
      await c.fill(text);
      await w.waitForTimeout(400);
      let cur = '';
      try { cur = await c.innerText(); } catch (e) { cur = ''; }
      if (!cur.includes(text.slice(0, 20))) {
        await c.fill(text);
        await w.waitForTimeout(400);
      }
      await c.press('Enter');
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