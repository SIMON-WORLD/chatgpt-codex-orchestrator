// chatgpt-codex-orchestrator: AtomicTurnController (offline-testable core).
// Operates against a PageFacade so the reliable wait / verify / error-classify
// logic can be unit-tested without a live in-app browser (IAB).
//
// A PageFacade exposes:
//   isComposerReady(): Promise<boolean>
//   sendMessage(text): Promise<void>
//   getAssistantCount(): Promise<number>      // -1 = unavailable
//   getAssistantReply(n): Promise<string>     // 0-based n
//   getCurrentUrl(): Promise<string>
// Optionally isComposerIdle(): Promise<boolean>.

export class ComposerTimeoutError extends Error {
  constructor(msg) { super(msg); this.name = 'ComposerTimeoutError'; }
}
export class ReplyTimeoutError extends Error {
  constructor(msg) { super(msg); this.name = 'ReplyTimeoutError'; }
}
export class ComposerUnavailableError extends Error {
  constructor(msg) { super(msg); this.name = 'ComposerUnavailableError'; }
}

export class ConversationMismatchError extends Error {
  constructor(msg) { super(msg); this.name = 'ConversationMismatchError'; }
}
export class TabLostError extends Error {
  constructor(msg) { super(msg); this.name = 'TabLostError'; }
}

export const DEFAULT_TURN_OPTIONS = {
  composerTimeoutMs: 30000,
  replyTimeoutMs: 120000,
  pollIntervalMs: 1000,
  replySettleMs: 2500,
  composerSettleMs: 400,
  replyStableReads: 4,
  // Bounded window to confirm a send actually dispatched after a press/click
  // transport exception (e.g. a false CDP deadline that still delivered the msg).
  dispatchConfirmMs: 6000,
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }


// Common ChatGPT "thinking" placeholders that should not be treated as a reply.
import { isPlaceholder, extractConversationId } from '../text-utils.js';

export { isPlaceholder, extractConversationId };

export class AtomicTurnController {
  constructor(page, options = {}) {
    this.page = page;
    this.options = { ...DEFAULT_TURN_OPTIONS, ...options };
  }

  async waitComposer() {
    const deadline = Date.now() + this.options.composerTimeoutMs;
    while (Date.now() < deadline) {
      let ready = false;
      try { ready = await this.page.isComposerReady(); }
      catch (e) { throw new TabLostError('composer check failed: ' + e.message); }
      if (ready) {
        if (typeof this.page.isComposerIdle === 'function') {
          let idle = false;
          try { idle = await this.page.isComposerIdle(); } catch (e) { idle = false; }
          if (!idle) { await sleep(this.options.pollIntervalMs); continue; }
        }
        await sleep(this.options.composerSettleMs);
        return true;
      }
      await sleep(this.options.pollIntervalMs);
    }
    throw new ComposerTimeoutError('composer not ready within ' + this.options.composerTimeoutMs + 'ms');
  }

  async count() {
    try { return await this.page.getAssistantCount(); }
    catch (e) { throw new TabLostError('assistant count failed: ' + e.message); }
  }
  async replyText(n) {
    try { return (await this.page.getAssistantReply(n)) || ''; }
    catch (e) { throw new TabLostError('assistant reply read failed: ' + e.message); }
  }
  async currentUrl() {
    try { return (await this.page.getCurrentUrl()) || ''; }
    catch (e) { throw new TabLostError('current url failed: ' + e.message); }
  }

  // Send the user message. If the transport press/click throws, it may be a false
  // CDP deadline: the message often still dispatches (composer clears, conversation
  // URL materialises, or the assistant reply begins). Confirm dispatch with BOUNDED
  // evidence; if confirmed, keep waiting for the reply. Never blindly resend (which
  // could duplicate the user message) and never create a second send.
  async _dispatch(text, beforeCount) {
    try {
      await this.page.sendMessage(text);
      return;
    } catch (err) {
      const confirmed = await this._dispatchConfirmed(beforeCount);
      if (!confirmed) throw err;
    }
  }

  // Bounded, non-destructive confirmation that a send actually dispatched. Returns
  // true as soon as ONE reliable signal appears; never resends or re-submits.
  async _dispatchConfirmed(beforeCount) {
    const deadline = Date.now() + this.options.dispatchConfirmMs;
    let sawConversation = false;
    while (Date.now() < deadline) {
      // 1) Composer cleared => the typed message was consumed and dispatched.
      if (typeof this.page.isComposerIdle === 'function') {
        try { if (await this.page.isComposerIdle()) return true; } catch (e) {}
      }
      // 2) First send: a new /c/<id> conversation URL materialises on dispatch.
      try {
        const u = await this.currentUrl();
        if (extractConversationId(u)) sawConversation = true;
      } catch (e) {}
      if (beforeCount === 0 && sawConversation) return true;
      // 3) Assistant response began.
      try {
        const n = await this.count();
        if (n >= 0 && n > beforeCount) return true;
      } catch (e) {}
      await sleep(this.options.pollIntervalMs);
    }
    return false;
  }

  // One atomic turn. Because ChatGPT can replace old messages once a conversation
  // grows, we do NOT rely on count increasing. Instead we detect "the LAST
  // assistant message changed from what it was before the send" and then wait
  // for that reply to become stable (fully streamed) before returning.
  async sendAndRead({ text, nonce, expectedConversationId }) {
    await this.waitComposer();
    const beforeCount = await this.count();
    if (beforeCount < 0) throw new TabLostError('assistant count unavailable before send');
    let beforeLast = '';
    if (beforeCount > 0) beforeLast = await this.replyText(beforeCount - 1);

    await this._dispatch(text, beforeCount);

    const deadline = Date.now() + this.options.replyTimeoutMs;
    let afterCount = beforeCount;
    let reply = '';
    let lastText = '';
    let stableCount = 0;

    while (Date.now() < deadline) {
      await sleep(this.options.pollIntervalMs);
      const n = await this.count();
      if (n < 0) continue;
      afterCount = n;
      if (n > 0) {
        const cur = await this.replyText(n - 1);
        if (cur && cur.trim() && cur !== beforeLast && !isPlaceholder(cur)) {
          if (cur === lastText) stableCount++;
          else { stableCount = 0; lastText = cur; }
          if (stableCount >= this.options.replyStableReads) {
            reply = cur;
            if (!nonce || reply.includes(nonce)) break;
          }
        } else {
          stableCount = 0; lastText = '';
        }
      }
    }

    if (expectedConversationId) {
      const u = await this.currentUrl();
      const currentId = extractConversationId(u);
      if (!currentId || currentId !== expectedConversationId) {
        throw new ConversationMismatchError(
          `conversation changed: expected /c/${expectedConversationId}, got ${u}`);
      }
    }

    if (!reply || !reply.trim()) {
      throw new ReplyTimeoutError('no new assistant reply within ' + this.options.replyTimeoutMs + 'ms');
    }
    if (nonce && !reply.includes(nonce)) {
      throw new ReplyTimeoutError(`reply did not echo nonce within timeout (reply=${reply.slice(0,120)})`);
    }

    return { reply, beforeCount, afterCount };
  }
}
