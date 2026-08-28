import { test } from 'node:test';
import assert from 'node:assert';
import { captureCurrentConversation, reopenConversationFromBinding, ConversationIdentityMismatchError } from '../src/iab-transport.js';

function fakeTab(id, url) {
  let u = url;
  return { id, url: async () => u, goto: async (x) => { u = x; }, playwright: { waitForLoadState: async () => {}, waitForTimeout: async () => {}, locator: () => ({ count: async () => 1, innerText: async () => 'x' }) } };
}
function fakeTransport(selected, openTabs) {
  const tabs = { selected: async () => selected, list: async () => openTabs, get: async (id) => openTabs.find(t => t.id === id) || null, new: async () => { const t = fakeTab('new', `https://chatgpt.com/c/XYZ`); openTabs.push(t); return t; } };
  return { connect: async () => {}, browser: { tabs } };
}

test('captureCurrentConversation reads selected /c/id and freezes identity', async () => {
  const tab = fakeTab('7', 'https://chatgpt.com/c/abc-123');
  const cap = await captureCurrentConversation(fakeTransport(tab, []));
  assert.strictEqual(cap.tabId, '7');
  assert.strictEqual(cap.conversationId, 'abc-123');
  assert.strictEqual(cap.conversationUrl, 'https://chatgpt.com/c/abc-123');
});

test('captureCurrentConversation fails if selected is not a conversation', async () => {
  const tab = fakeTab('8', 'https://chatgpt.com/');
  await assert.rejects(() => captureCurrentConversation(fakeTransport(tab, [])), ConversationIdentityMismatchError);
});

test('reopenConversationFromBinding reuses original tab (A)', async () => {
  const tab = fakeTab('7', 'https://chatgpt.com/c/abc-123');
  const r = await reopenConversationFromBinding(fakeTransport(null, [tab]), { conversationId: 'abc-123', conversationUrl: 'https://chatgpt.com/c/abc-123', ownedTabId: '7' });
  assert.strictEqual(r.tabId, '7');
});

test('reopen finds same conv in open tabs when original lost (B/C)', async () => {
  const tab = fakeTab('9', 'https://chatgpt.com/c/abc-123');
  const r = await reopenConversationFromBinding(fakeTransport(null, [tab]), { conversationId: 'abc-123', conversationUrl: 'https://chatgpt.com/c/abc-123', ownedTabId: 'lost' });
  assert.strictEqual(r.tabId, '9');
});

test('reopen opens saved url and validates id (D); mismatch is a hard error (E)', async () => {
  const openTabs = [];
  const t = fakeTransport(null, openTabs);
  // force the newly opened tab to have a different id to test mismatch
  t.browser.tabs.new = async () => { const tt = { id: 'recovery', url: async () => 'https://chatgpt.com/c/DIFFERENT', goto: async () => {}, playwright: { waitForLoadState: async () => {}, waitForTimeout: async () => {}, locator: () => ({ count: async () => 1, innerText: async () => 'x' }) } }; openTabs.push(tt); return tt; };
  await assert.rejects(() => reopenConversationFromBinding(t, { conversationId: 'abc-123', conversationUrl: 'https://chatgpt.com/c/abc-123', ownedTabId: 'lost' }), ConversationIdentityMismatchError);
});