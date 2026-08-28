import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskManager } from '../src/task-manager.js';

function dir() { const d = path.join(os.tmpdir(), 'ev-' + Date.now()); fs.mkdirSync(d, { recursive: true }); return d; }
class FakeBrain { constructor(replies){ this.replies=[...replies]; this.conversationId='conv-1'; this.conversationUrl='https://chatgpt.com/c/conv-1'; this.ownedTabId='tab-1'; }
  async send(){ return { reply: this.replies.shift() ?? 'DONE', conversationId: this.conversationId }; } }
class FakeExecutor { constructor({evidence=[], success=true}={}){ this.calls=0; this.evidence=evidence; this.success=success; }
  async execute(){ this.calls++; return { sessionId:'th-1', resultText:'did', success:this.success, error:this.success?null:'x', evidence:this.evidence }; } }

const T = (id) => ({ control: 'TASK', instruction: 'do it', acceptance: [{ id, required: true, text: id }] });

test('process success but required acceptance has NO evidence -> DONE rejected', async () => {
  const brain = new FakeBrain([T('a1'), 'DONE']);
  const ex = new FakeExecutor({ evidence: [] }); // success but no evidence
  const mgr = new TaskManager({ stateDir: dir() });
  const { state } = await mgr.startTask({ repoDir: 'r', goal: 'g', brain, executor: ex });
  assert.notStrictEqual(state.status, 'completed');
  assert.strictEqual(state.status, 'awaiting_user');
});

test('explicit test failure -> acceptance=fail -> DONE rejected', async () => {
  const brain = new FakeBrain([T('a1'), 'DONE']);
  const ex = new FakeExecutor({ evidence: [{ acceptanceId: 'a1', status: 'fail', kind: 'test', summary: 'test failed' }] });
  const mgr = new TaskManager({ stateDir: dir() });
  const { state } = await mgr.startTask({ repoDir: 'r', goal: 'g', brain, executor: ex });
  assert.strictEqual(state.status, 'awaiting_user');
  assert.strictEqual(state.acceptanceRegistry.find((a) => a.id === 'a1').status, 'fail');
});

test('evidence=unknown -> DONE rejected', async () => {
  const brain = new FakeBrain([T('a1'), 'DONE']);
  const ex = new FakeExecutor({ evidence: [{ acceptanceId: 'a1', status: 'unknown', kind: 'verify', summary: 'not run' }] });
  const mgr = new TaskManager({ stateDir: dir() });
  const { state } = await mgr.startTask({ repoDir: 'r', goal: 'g', brain, executor: ex });
  assert.strictEqual(state.status, 'awaiting_user');
});

test('all required acceptance have real pass evidence -> DONE accepted', async () => {
  const brain = new FakeBrain([T('a1'), T('a1'), 'DONE']);
  const ex = new FakeExecutor({ evidence: [{ acceptanceId: 'a1', status: 'pass', kind: 'test', summary: 'ok' }] });
  const mgr = new TaskManager({ stateDir: dir() });
  const { state } = await mgr.startTask({ repoDir: 'r', goal: 'g', brain, executor: ex });
  assert.strictEqual(state.status, 'completed');
});