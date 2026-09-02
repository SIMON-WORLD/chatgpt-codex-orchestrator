import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskService } from '../src/legacy/task-service.js';

function dir() { const d = path.join(os.tmpdir(), 'svc2-' + Date.now()); fs.mkdirSync(d, { recursive: true }); return d; }

class FakeBrain { constructor(replies){ this.replies=[...replies]; this.conversationId='conv-9'; this.conversationUrl='https://chatgpt.com/c/conv-9'; this.ownedTabId='tab-9'; }
  async send(){ return { reply: this.replies.shift() ?? 'DONE', conversationId: this.conversationId }; } }
class FakeExec { async execute(){ return { sessionId:'th-1', resultText:'done', success:true, error:null, evidence:[] }; } }

test("startTask conversation:'current' uses adoptBrain, 'new' uses openBrain", async () => {
  const d = dir();
  let openCount = 0, adoptCount = 0;
  const runtime = {
    startWorker: async () => ({ id: 'w' }),
    openBrain: async () => { openCount++; return new FakeBrain([{control:'TASK',instruction:'x',acceptance:[]},'DONE']); },
    adoptBrain: async () => { adoptCount++; return new FakeBrain([{control:'TASK',instruction:'y',acceptance:[]},'DONE']); },
    makeExecutor: () => new FakeExec(),
    teardownWorker: () => {},
  };
  const svc = new TaskService({ stateDir: d, runtime });
  await svc.startTask({ goal: 'g', repoDir: 'r', conversation: 'current' });
  assert.strictEqual(adoptCount, 1);
  assert.strictEqual(openCount, 0);
  await svc.startTask({ goal: 'g', repoDir: 'r', conversation: 'new' });
  assert.strictEqual(openCount, 1);
  // adoptConversation alias -> current
  await svc.adoptConversation({ goal: 'g', repoDir: 'r' });
  assert.strictEqual(adoptCount, 2);
});