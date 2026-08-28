import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexExecutor, loadCodexConfig } from '../src/codex-executor.js';

function tempConfig() {
  const cfg = [
    'model = "deepseek-v4-flash-vision-exp"',
    'model_provider = "openai-chat-completions"',
    '[model_providers.openai-chat-completions]',
    'name = "deepseek"',
    'base_url = "http://127.0.0.1:19100/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'experimental_bearer_token = "sk-testsecret"',
    '',
  ].join('\n');
  const p = path.join(os.tmpdir(), 'codex-executor-test-' + Date.now() + '.toml');
  fs.writeFileSync(p, cfg, 'utf8');
  return p;
}

test('loadCodexConfig parses model / provider / bearer token', () => {
  const p = tempConfig();
  try {
    const c = loadCodexConfig(p);
    assert.strictEqual(c.model, 'deepseek-v4-flash-vision-exp');
    assert.strictEqual(c.modelProvider, 'openai-chat-completions');
    assert.strictEqual(c.providers['openai-chat-completions'].name, 'deepseek');
    assert.strictEqual(c.providers['openai-chat-completions'].baseUrl, 'http://127.0.0.1:19100/v1');
    assert.strictEqual(c.providers['openai-chat-completions'].bearerToken, 'sk-testsecret');
  } finally { fs.rmSync(p, { force: true }); }
});

test('buildArgs new vs resume', () => {
  const p = tempConfig();
  try {
    const ex = new CodexExecutor({ repoDir: 'C:\\repo', configPath: p });
    const a1 = ex.buildArgs('create foo.js');
    assert.strictEqual(a1[0], 'exec');
    assert.ok(a1.includes('-C') && a1.includes(undefined ? '' : 'C:\\repo') === false ? true : true);
    // For new session args[1] should be --json and contain -C
    assert.ok(a1.includes('--json'));
    const cIdx = a1.indexOf('-C');
    assert.ok(cIdx >= 0 && a1[cIdx + 1] === 'C:\\repo');

    ex.sessionId = '01ab-thread';
    const a2 = ex.buildArgs('fix foo');
    assert.strictEqual(a2[0], 'exec');
    assert.strictEqual(a2[1], 'resume');
    assert.ok(a2.includes('01ab-thread'));
    assert.ok(!a2.includes('-C'), 'resume must not pass -C');
  } finally { fs.rmSync(p, { force: true }); }
});

test('execute parses JSONL: new thread + agent_message', async () => {
  const p = tempConfig();
  try {
    const ex = new CodexExecutor({ repoDir: 'C:\\repo', configPath: p });
    const jsonl = [
      { type: 'thread.started', thread_id: '01ab-1' },
      { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata not found' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Created foo.js, tests pass' } },
      { type: 'turn.completed' },
    ].map((o) => JSON.stringify(o)).join('\n');
    ex.spawnFn = async (args) => ({ stdout: jsonl, stderr: '', code: 0 });
    const r = await ex.execute('create foo.js');
    assert.strictEqual(r.sessionId, '01ab-1');
    assert.strictEqual(r.resultText, 'Created foo.js, tests pass');
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.error, null);
    // resume on next call
    ex.spawnFn = async () => ({ stdout: JSON.stringify({ type: 'thread.started', thread_id: '01ab-1' }) + '\n' + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fixed' } }), stderr: '', code: 0 });
    const r2 = await ex.execute('fix foo');
    assert.strictEqual(r2.sessionId, '01ab-1');
  } finally { fs.rmSync(p, { force: true }); }
});