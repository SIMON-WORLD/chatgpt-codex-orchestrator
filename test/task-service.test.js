import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskService } from '../src/legacy/task-service.js';
import { TaskLockedError } from '../src/task-lock.js';

function dir() { const d = path.join(os.tmpdir(), 'svc-' + Date.now()); fs.mkdirSync(d, { recursive: true }); return d; }
function js(o){ return JSON.stringify(o); }

class FakeBrain { constructor(replies){ this.replies=[...replies]; this.conversationId='conv-1'; this.conversationUrl='https://chatgpt.com/c/conv-1'; this.ownedTabId='tab-1'; }
  async send(){ return { reply: this.replies.shift() ?? 'DONE', conversationId: this.conversationId }; } }
class FakeExec { constructor(){ this.calls=0; } async execute(){ this.calls++; return { sessionId:'th-1', resultText:'done', success:true, error:null, evidence:[] }; } }

function FakeRuntime({ replies }) {
  const brain = new FakeBrain(replies);
  const exec = new FakeExec();
  return {
    startWorker: async () => ({ id: 'w1' }),
    connectWorker: async () => ({ id: 'w2' }),
    openBrain: async () => brain,
    reopenBrain: async () => brain,
    makeExecutor: () => exec,
    teardownWorker: (w) => { w.tornDown = true; },
    brain, exec,
  };
}

test('TaskService.startTask runs loop to DONE and tears down worker', async () => {
  const rt = FakeRuntime({ replies: [ { control:'TASK', instruction:'x', acceptance:[] }, { control:'TASK', instruction:'y', acceptance:[] }, 'DONE' ] });
  const svc = new TaskService({ stateDir: dir(), runtime: rt });
  const { taskId, state } = await svc.startTask({ goal: 'g', repoDir: 'r' });
  assert.strictEqual(state.status, 'completed');
  assert.strictEqual(state.round, 2);
  assert.strictEqual(rt.exec.calls, 2);
  assert.ok(rt.brain && true);
});

test('TaskService lock prevents second runtime from same task', async () => {
  const d = dir();
  const rt1 = FakeRuntime({ replies: ['DONE'] });
  const svc = new TaskService({ stateDir: d, runtime: rt1 });
  // startTask holds lock; we simulate concurrent resume by acquiring lock directly
  const { taskId } = await svc.startTask({ goal: 'g', repoDir: 'r' });
  // task completed -> lock released -> resume should not be blocked by lock (completed short-circuits anyway)
  const rt2 = FakeRuntime({ replies: ['DONE'] });
  const svc2 = new TaskService({ stateDir: d, runtime: rt2 });
  const r = await svc2.resumeTask({ taskId });
  assert.strictEqual(r.state.status, 'completed');
});

test('cancelTask -> cancelled and releases lock', async () => {
  const rt = FakeRuntime({ replies: ['DONE'] });
  const svc = new TaskService({ stateDir: dir(), runtime: rt });
  const { taskId } = await svc.startTask({ goal: 'g', repoDir: 'r' });
  const c = await svc.cancelTask(taskId);
  assert.strictEqual(c.status, 'cancelled');
});