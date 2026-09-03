import { test } from 'node:test';
import assert from 'node:assert';
import {
  AtomicTurnController,
  ComposerTimeoutError,
  ReplyTimeoutError,
  ConversationMismatchError,
  TabLostError,
  extractConversationId,
} from '../src/legacy/atomic-turn.js';

const CONV = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const URL = 'https://chatgpt.com/c/' + CONV;
const FAST = { pollIntervalMs: 4, replySettleMs: 4, composerSettleMs: 4, composerTimeoutMs: 800, replyTimeoutMs: 1200 };

class FakePage {
  constructor(opts = {}) {
    this.composerReadyAfter = opts.composerReadyAfter ?? 3;
    this.replyAfter = opts.replyAfter ?? 2;
    this.replyText = opts.replyText ?? '';
    this.assistantCountAtStart = opts.assistantCountAtStart ?? 0;
    this.currentUrl = opts.currentUrl ?? URL;
    this.urlAfterReply = opts.urlAfterReply ?? null;
    this.countThrows = opts.countThrows ?? false;
    this.replyThrows = opts.replyThrows ?? false;
    this.composerThrows = opts.composerThrows ?? false;
    this.composerChecks = 0;
    this.countChecks = 0;
    this.assistantCount = this.assistantCountAtStart;
    this.pending = false;
    this.sent = 0;
  }
  async isComposerReady() { this.composerChecks++; if (this.composerThrows) throw new Error('composer exploded'); return this.composerChecks >= this.composerReadyAfter; }
  async sendMessage() { this.sent++; this.pending = true; }
  async getAssistantCount() {
    this.countChecks++;
    if (this.countThrows) throw new Error('tab gone');
    if (this.pending && this.countChecks >= this.replyAfter + 1) this.assistantCount = this.assistantCountAtStart + 1;
    return this.assistantCount;
  }
  async getAssistantReply() { if (this.replyThrows) throw new Error('reply gone'); return this.replyText; }
  async getCurrentUrl() { return this.urlAfterReply || this.currentUrl; }
}

test('extractConversationId parses /c/<id>', () => {
  assert.strictEqual(extractConversationId(URL), CONV);
  assert.strictEqual(extractConversationId('https://chatgpt.com/c/abc123'), 'abc123');
  assert.strictEqual(extractConversationId('https://chatgpt.com/'), null);
  assert.strictEqual(extractConversationId(null), null);
});

test('happy path: composer waits, reply arrives, nonce echoed, counts increment', async () => {
  const nonce = 'NONCE_abc';
  const page = new FakePage({ composerReadyAfter: 3, replyAfter: 2, replyText: nonce, assistantCountAtStart: 0 });
  const ctl = new AtomicTurnController(page, FAST);
  const res = await ctl.sendAndRead({ text: 'hello', nonce, expectedConversationId: CONV });
  assert.strictEqual(res.beforeCount, 0);
  assert.strictEqual(res.afterCount, 1);
  assert.strictEqual(res.reply, nonce);
  assert.ok(page.composerChecks >= 3, 'composer was polled before ready');
});

test('composer timeout -> ComposerTimeoutError', async () => {
  const page = new FakePage({ composerReadyAfter: 100000 });
  const ctl = new AtomicTurnController(page, FAST);
  await assert.rejects(() => ctl.sendAndRead({ text: 'x', nonce: 'n' }), ComposerTimeoutError);
});

test('reply timeout (count never increments) -> ReplyTimeoutError', async () => {
  const page = new FakePage({ replyAfter: 100000, replyText: 'x' });
  const ctl = new AtomicTurnController(page, FAST);
  await assert.rejects(() => ctl.sendAndRead({ text: 'x', nonce: 'n', expectedConversationId: CONV }), ReplyTimeoutError);
});

test('conversation identity mismatch -> ConversationMismatchError', async () => {
  const nonce = 'NONCE_zzz';
  const page = new FakePage({ composerReadyAfter: 2, replyAfter: 1, replyText: nonce, urlAfterReply: 'https://chatgpt.com/c/DIFFERENT' });
  const ctl = new AtomicTurnController(page, FAST);
  await assert.rejects(() => ctl.sendAndRead({ text: 'x', nonce, expectedConversationId: CONV }), ConversationMismatchError);
});

test('owned tab lost (assistant count throws) -> TabLostError', async () => {
  const page = new FakePage({ countThrows: true });
  const ctl = new AtomicTurnController(page, FAST);
  await assert.rejects(() => ctl.sendAndRead({ text: 'x', nonce: 'n' }), TabLostError);
});

test('nonce not echoed -> ReplyTimeoutError', async () => {
  const page = new FakePage({ composerReadyAfter: 2, replyAfter: 1, replyText: 'hello no nonce' });
  const ctl = new AtomicTurnController(page, FAST);
  await assert.rejects(() => ctl.sendAndRead({ text: 'x', nonce: 'NONCE_missing', expectedConversationId: CONV }), ReplyTimeoutError);
});