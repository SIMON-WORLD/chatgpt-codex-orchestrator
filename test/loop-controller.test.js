import { test } from 'node:test';
import assert from 'node:assert';
import { LoopController } from '../src/loop-controller.js';

class FakeBrain {
  constructor(replies) { this.replies = replies; this.conversationId = 'conv-9'; this.ownedTabId = 'tab-9'; this.sent = []; }
  async send(text) { this.sent.push(text); return { reply: this.replies.shift() ?? 'DONE', conversationId: this.conversationId }; }
}
class FakeExecutor {
  constructor() { this.sessionId = 'codex-thread-1'; this.calls = []; }
  async execute(directive) { this.calls.push(directive); return { sessionId: this.sessionId, resultText: 'did: ' + directive, success: true, error: null }; }
}

test('loop: TASK -> RESULT -> REVISE -> RESULT -> DONE, same codex session', async () => {
  const brain = new FakeBrain([
    'TASK: create foo.js',
    'REVISE: please add trim',
    'DONE',
  ]);
  const executor = new FakeExecutor();
  const ctl = new LoopController({ brain, executor, maxTurns: 10 });
  const res = await ctl.run('high level goal');

  assert.strictEqual(res.done, true);
  assert.strictEqual(res.stoppedAt, 'DONE');
  assert.strictEqual(res.turns, 2);
  assert.strictEqual(executor.calls.length, 2);
  assert.strictEqual(executor.calls[0], 'create foo.js');
  assert.strictEqual(executor.calls[1], 'please add trim');
  assert.strictEqual(res.executorSessionId, 'codex-thread-1');
  // ChatGPT got the goal + 2 results, and produced 3 replies
  assert.strictEqual(brain.sent.length, 3);
  assert.ok(brain.sent[0].includes('high level goal'));
  assert.ok(brain.sent[1].includes('Codex result'));
  assert.ok(brain.sent[2].includes('Codex result'));
});

test('loop stops at ASK_USER without exceeding turns', async () => {
  const brain = new FakeBrain(['TASK: do x', 'ASK_USER: which repo?']);
  const executor = new FakeExecutor();
  const ctl = new LoopController({ brain, executor, maxTurns: 10 });
  const res = await ctl.run('goal');
  assert.strictEqual(res.done, false);
  assert.strictEqual(res.stoppedAt, 'ASK_USER');
  assert.strictEqual(res.turns, 1);
});