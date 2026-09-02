import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskService } from '../src/legacy/task-service.js';

function dir() { const d = path.join(os.tmpdir(), 'adv-' + Date.now()); fs.mkdirSync(d, { recursive: true }); return d; }
class B { constructor(replies){ this.replies=[...replies]; this.conversationId='c'; this.conversationUrl='https://chatgpt.com/c/c'; this.ownedTabId='t'; this.sent=0; }
  async send(){ this.sent++; return { reply: (this.replies.shift() ?? 'DONE'), conversationId:'c', conversationUrl:'https://chatgpt.com/c/c' }; } }
class E { constructor(){ this.calls=0; } async execute(){ this.calls++; return { sessionId:'th', resultText:'did', success:true, error:null }; } }
const T = (ins) => ({ control:'TASK', instruction: ins, acceptance: [] });

test('advanceTask is turn-sliced: advances one unit each call, persists, no duplicate codex', async () => {
  const svc = new TaskService({ stateDir: dir(), runtime: {} });
  const brain = new B([ T('create a.js'), 'DONE' ]);
  const ex = new E();
  const { taskId } = await svc.createTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  let r, guard = 0;
  do {
    r = await svc.advanceTask(taskId, { brain, executor: ex, sessionFactory: null });
    guard++;
  } while (r.status === 'running' && guard < 20);
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(ex.calls, 1, 'codex ran exactly once (no duplicate)');
  const reloaded = await svc.mgr.load(taskId);
  assert.strictEqual(reloaded.status, 'completed');
});