// chatgpt-codex-orchestrator: IAB false-press-timeout (idempotent send) tests.
// Verifies an AtomicTurnController that a press/click transport error does not abort
// the turn when bounded dispatch evidence confirms the message already dispatched,
// and that we never double-send.
import { test } from 'node:test';
import assert from 'node:assert';
import { AtomicTurnController } from '../src/legacy/atomic-turn.js';

const CONV = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CONV_URL = 'https://chatgpt.com/c/' + CONV;
const FAST = {
  pollIntervalMs: 4, replySettleMs: 4, composerSettleMs: 4,
  composerTimeoutMs: 800, replyTimeoutMs: 800, dispatchConfirmMs: 300, replyStableReads: 2,
};

// Models the live ChatGPT page. The composer starts empty (idle). sendMessage fills it
// and presses Enter; a press may throw a false CDP deadline. If the message actually
// dispatched (`dispatchAfterThrow`), `dispatched` becomes true and the assistant reply
// begins; otherwise it stays silent. Composer-clear is a separate signal so the
// conversation-URL confirmation path can be exercised independently.
class Page {
  constructor(o = {}) {
    this.sendThrows = !!o.sendThrows;
    this.dispatchAfterThrow = !!o.dispatchAfterThrow;
    this.composerClears = o.composerClears ?? true;   // whether dispatch clears the composer
    this.replyText = o.replyText || '';
    this.assistantCountAtStart = o.assistantCountAtStart ?? 0;
    this.replyAfter = o.replyAfter ?? 2;
    this.currentUrl = o.currentUrl || 'https://chatgpt.com/';
    this.urlAfterReply = o.urlAfterReply || null;
    this.composerEmpty = true;   // empty/ready before the send
    this.dispatched = false;
    this.assistantCount = this.assistantCountAtStart;
    this.countChecks = 0;
    this.sendCount = 0;
  }
  async isComposerReady() { return true; }
  async isComposerIdle() { return this.composerEmpty; }
  async sendMessage() {
    this.sendCount++;
    this.composerEmpty = false;          // fill the composer
    if (this.sendThrows) {
      if (this.dispatchAfterThrow) {
        // The press errored but the message actually dispatched (false CDP deadline).
        this.dispatched = true;
        this.composerEmpty = this.composerClears;
        this.urlAfterReply = this.urlAfterReply || CONV_URL;
      }
      throw new Error('CDP operation exceeded its deadline before command dispatch (press)');
    }
    this.dispatched = true;
    this.composerEmpty = this.composerClears;
  }
  async getAssistantCount() {
    this.countChecks++;
    if (this.dispatched && this.countChecks >= this.replyAfter + 1) this.assistantCount = this.assistantCountAtStart + 1;
    return this.assistantCount;
  }
  async getAssistantReply() { return this.replyText; }
  async getCurrentUrl() { return this.urlAfterReply || this.currentUrl; }
}

test('normal send: message dispatches, reply returned, send once', async () => {
  const nonce = 'NONCE_ok';
  const page = new Page({ replyText: nonce, assistantCountAtStart: 0, replyAfter: 2, currentUrl: CONV_URL });
  const ctl = new AtomicTurnController(page, FAST);
  const res = await ctl.sendAndRead({ text: 'hello', nonce, expectedConversationId: CONV });
  assert.strictEqual(res.reply, nonce);
  assert.strictEqual(res.beforeCount, 0);
  assert.strictEqual(page.sendCount, 1);
});

test('press throws but dispatch confirmed (composer cleared) => continue, reply returned, send once', async () => {
  const nonce = 'NONCE_flaky';
  const page = new Page({ sendThrows: true, dispatchAfterThrow: true, composerClears: true, replyText: nonce, assistantCountAtStart: 0, replyAfter: 2, currentUrl: CONV_URL });
  const ctl = new AtomicTurnController(page, FAST);
  const res = await ctl.sendAndRead({ text: 'hello', nonce, expectedConversationId: CONV });
  assert.strictEqual(res.reply, nonce);
  assert.strictEqual(res.beforeCount, 0);
  assert.strictEqual(page.sendCount, 1);
});

test('press throws and dispatch NOT confirmed => surfaces original send error (no double send)', async () => {
  const page = new Page({ sendThrows: true, dispatchAfterThrow: false, replyText: 'x', assistantCountAtStart: 0 });
  const ctl = new AtomicTurnController(page, FAST);
  await assert.rejects(() => ctl.sendAndRead({ text: 'hello', nonce: 'n' }), /CDP operation exceeded its deadline/);
  assert.strictEqual(page.sendCount, 1); // never resends
});

test('ambiguous send error with no dispatch evidence => the original error is surfaced (not a reply timeout)', async () => {
  const page = new Page({ sendThrows: true, dispatchAfterThrow: false, replyText: 'n', assistantCountAtStart: 0 });
  const ctl = new AtomicTurnController(page, { ...FAST, dispatchConfirmMs: 40 });
  await assert.rejects(() => ctl.sendAndRead({ text: 'hello', nonce: 'n' }), (e) => /CDP operation exceeded its deadline/.test(e.message));
});

test('press throws, dispatch confirmed via conversation URL materialisation on first send', async () => {
  const nonce = 'NONCE_url';
  const page = new Page({
    sendThrows: true, dispatchAfterThrow: true, composerClears: false, // composer stays non-empty
    replyText: nonce, assistantCountAtStart: 0, replyAfter: 2,
    currentUrl: 'https://chatgpt.com/', urlAfterReply: CONV_URL,
  });
  const ctl = new AtomicTurnController(page, FAST);
  const res = await ctl.sendAndRead({ text: 'hello', nonce, expectedConversationId: CONV });
  assert.strictEqual(res.reply, nonce);
  assert.strictEqual(page.sendCount, 1);
});

