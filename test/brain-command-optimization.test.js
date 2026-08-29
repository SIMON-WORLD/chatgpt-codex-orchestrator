import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTabFacade } from '../src/iab-transport.js';
import { ComposerUnavailableError } from '../src/atomic-turn.js';
import { createChatGPTBrowserProvider, DEFAULT_DIRECT_CONFIG, DIRECT_MODE_REQUIRES, DEFAULT_TAKEOVER_MESSAGE } from '../src/direct-mode.js';
import { configureGitIdentity, checkPublishIdentity, PUBLISH_POLICY_DEFAULTS, isPostDoneModificationAllowed } from '../src/publish-policy.js';
import { InAppBrowserTransport } from '../src/iab-transport.js';
import { __setMockBrowserState, __getBrowserCallLog } from './fixtures/mock-browser-runtime.mjs';

const skillPath = fileURLToPath(new URL('../skills/brain-command/SKILL.md', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/mock-browser-runtime.mjs', import.meta.url));
const browserClientPath = pathToFileURL(fixturePath).href;

// --- Mock page allowing a composer (#prompt-textarea) and a scoped fallback ----
function makeLoc(role, countVal, insideVal, events) {
  return {
    async count() { return countVal; },
    // evaluate runs the inside-message check symbolically: returns whether the
    // identified element lives inside a [data-message-author-role] block.
    async evaluate() { return insideVal; },
    async fill(text) { events.filled.push({ role, text }); },
    async press(key) { events.pressed.push({ role, key }); },
    async innerText() { return role === 'composer' ? 'hello world' : 'historical-content'; },
  };
}

function makeMockPage({ composerCount = 1, composerInside = false, scopedCount = 0, scopedInside = false } = {}) {
  const events = { filled: [], pressed: [] };
  const composer = makeLoc('composer', composerCount, composerInside, events);
  const scoped = makeLoc('scoped', scopedCount, scopedInside, events);
  const w = {
    async waitForTimeout() {},
    locator(sel) {
      if (sel === '#prompt-textarea') return composer;
      if (sel === '[data-testid*="composer"] [contenteditable="true"]') return scoped;
      return makeLoc('other', 0, false, events);
    },
  };
  return { w, events };
}

test('sendMessage targets only the real composer, not a historical editable block', async () => {
  // Page has a real composer AND a scoped fallback; a historical editable block
  // would be another [contenteditable] elsewhere. Sending must touch only the composer.
  const { w, events } = makeMockPage({ composerCount: 1, composerInside: false, scopedCount: 1, scopedInside: false });
  const facade = createTabFacade({ id: 't', playwright: w });
  await facade.sendMessage('hello world');
  assert.ok(events.filled.some((e) => e.role === 'composer' && e.text === 'hello world'));
  assert.ok(!events.filled.some((e) => e.role !== 'composer'), 'must not fill any non-composer editable');
  assert.equal(events.pressed[0].role, 'composer');
});

test('ambiguous composer (multiple candidates) fails closed', async () => {
  const { w, events } = makeMockPage({ composerCount: 2 });
  const facade = createTabFacade({ id: 't', playwright: w });
  assert.equal(await facade.isComposerReady(), false);
  await assert.rejects(() => facade.sendMessage('hi'), ComposerUnavailableError);
  assert.equal(events.filled.length, 0, 'no fill when composer is ambiguous');
});

test('no composer found fails closed (never guesses)', async () => {
  const { w, events } = makeMockPage({ composerCount: 0 });
  const facade = createTabFacade({ id: 't', playwright: w });
  assert.equal(await facade.isComposerReady(), false);
  await assert.rejects(() => facade.sendMessage('hi'), ComposerUnavailableError);
  assert.equal(events.filled.length, 0);
});

test('composer inside a historical message is rejected (fail closed)', async () => {
  const { w, events } = makeMockPage({ composerCount: 1, composerInside: true });
  const facade = createTabFacade({ id: 't', playwright: w });
  assert.equal(await facade.isComposerReady(), false);
  await assert.rejects(() => facade.sendMessage('hi'), ComposerUnavailableError);
  assert.equal(events.filled.length, 0);
});

test('milestone-sized governance language is present in skill + takeover message', () => {
  const skill = fs.readFileSync(skillPath, 'utf8');
  assert.match(skill, /milestone-sized/i);
  assert.match(skill, /PLAN comprehensively once/i);
  assert.match(skill, /review\/decision boundaries/i);
  assert.match(DEFAULT_TAKEOVER_MESSAGE, /milestone-sized TASKs/i);
  assert.match(DEFAULT_TAKEOVER_MESSAGE, /REVISE remains available whenever evidence fails/i);
});

test('configureGitIdentity sets repo-local identity when configured', () => {
  const calls = [];
  const run = (args) => { calls.push(args); return Buffer.from(''); };
  const res = configureGitIdentity({ repoDir: '/x', name: 'SIMON-WORLD', email: '252317962+SIMON-WORLD@users.noreply.github.com', run });
  assert.equal(res.configured, true);
  assert.deepEqual(calls[0], ['config', 'user.name', 'SIMON-WORLD']);
  assert.deepEqual(calls[1], ['config', 'user.email', '252317962+SIMON-WORLD@users.noreply.github.com']);
});

test('configureGitIdentity is a no-op when no identity configured', () => {
  const calls = [];
  const run = (args) => { calls.push(args); return Buffer.from(''); };
  const res = configureGitIdentity({ repoDir: '/x', run });
  assert.equal(res.configured, false);
  assert.equal(calls.length, 0);
});

test('checkPublishIdentity verifies author matches expected identity', () => {
  let stored = {};
  const run = (args) => {
    if (args[0] === 'config' && args[1] === 'user.name' && args.length === 3) { stored.name = args[2]; return Buffer.from(''); }
    if (args[0] === 'config' && args[1] === 'user.email' && args.length === 3) { stored.email = args[2]; return Buffer.from(''); }
    if (args[0] === 'config' && args[1] === 'user.name') return Buffer.from(stored.name || '');
    if (args[0] === 'config' && args[1] === 'user.email') return Buffer.from(stored.email || '');
    return Buffer.from('');
  };
  const res = checkPublishIdentity({ repoDir: '/x', name: 'SIMON-WORLD', email: 'noreply', run });
  assert.equal(res.ok, true);
  assert.equal(res.applied.configured, true);
});

test('publish policy defaults: no force-push, no history rewrite, post-DONE boundary', () => {
  assert.equal(PUBLISH_POLICY_DEFAULTS.forcePush, false);
  assert.equal(PUBLISH_POLICY_DEFAULTS.rewriteHistory, false);
  assert.equal(PUBLISH_POLICY_DEFAULTS.requireFastForward, true);
  assert.equal(isPostDoneModificationAllowed({ changesTargetRepoOutcome: false }), true);
  assert.equal(isPostDoneModificationAllowed({ changesTargetRepoOutcome: true }), false);
});

test('legacy Direct Mode behavior unchanged', () => {
  assert.equal(DEFAULT_DIRECT_CONFIG.brainProvider, 'chatgpt');
  assert.equal(DEFAULT_DIRECT_CONFIG.executor, 'current-codex');
  assert.equal(DIRECT_MODE_REQUIRES.workerBootstrap, false);
  assert.equal(DIRECT_MODE_REQUIRES.nestedCodex, false);
});

test('existing-conversation adoption still works with an injected IAB transport', async () => {
  const tabs = [];
  const browser = {
    tabs: {
      async new() {
        const tab = { id: 'tab-1', _url: 'https://chatgpt.com/', async goto(u) { this._url = u; }, async url() { return this._url; }, async close() {}, playwright: { async evaluate() {}, async waitForTimeout() {}, async waitForLoadState() {}, async locator() { return { count: async () => 0, first: () => ({ innerText: async () => '', fill: async () => {}, press: async () => {} }) }; } } };
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
    async findConversationLinksByTitle() { return [{ id: '6a91e45b-77f0-83ea-82bf-32f887010038', href: '/c/6a91e45b-77f0-83ea-82bf-32f887010038' }]; },
    async openConversationByHref(tab, href) { tab._url = 'https://chatgpt.com' + href; return tab._url; },
  };
  const provider = createChatGPTBrowserProvider({ transport });
  const id = await provider.adoptConversation({ title: 'agent-credentials-skill \u8bbe\u8ba1' });
  assert.equal(id.conversationId, '6a91e45b-77f0-83ea-82bf-32f887010038');
});

test('IAB-only unchanged: connect requests iab, never getForUrl', async () => {
  __setMockBrowserState({ available: true });
  const t = new InAppBrowserTransport({ browserClientPath });
  await t.connect();
  assert.deepEqual(__getBrowserCallLog()[0], ['get', 'iab']);
  assert.ok(!__getBrowserCallLog().some(([op]) => op === 'getForUrl'));
});
