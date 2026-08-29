// chatgpt-codex-orchestrator: CodexWorkerClient auth & lifecycle tests.
// Uses a fake net server that mirrors the worker host's auth/taskId checks.
import { test } from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import { CodexWorkerClient } from '../src/worker-client.js';

const TOKEN = 'secret-token-abc123';

function startFakeWorker({ token = TOKEN, boundTaskId = null, echoTokenInResult = false, seen = {} } = {}) {
  let closedResolve; const closedPromise = new Promise((r) => { closedResolve = r; });
  const server = net.createServer((sock) => {
    let buf = '';
    seen.auths = [];
    sock.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let req; try { req = JSON.parse(line); } catch { continue; }
        seen.auths.push(req.auth);
        seen.taskIds = seen.taskIds || []; seen.taskIds.push(req.taskId ?? null);
        if (req.shutdown) {
          if (req.auth !== token) { sock.write(JSON.stringify({ id: req.id, error: 'auth token mismatch' }) + '\n'); continue; }
          sock.write(JSON.stringify({ id: req.id, ok: true }) + '\n');
          server.close();
          closedResolve();
          return;
        }
        if (req.auth !== token) { sock.write(JSON.stringify({ id: req.id, error: 'auth token mismatch' }) + '\n'); continue; }
        if (boundTaskId && req.taskId !== boundTaskId) { sock.write(JSON.stringify({ id: req.id, error: 'task identity mismatch' }) + '\n'); continue; }
        if (req.prompt !== undefined) {
          const resultText = echoTokenInResult ? ('result ' + token + ' done') : ('result done');
          sock.write(JSON.stringify({ id: req.id, sessionId: 'th-1', resultText, success: true, error: null }) + '\n');
          continue;
        }
        if (req.op === 'state.load') { sock.write(JSON.stringify({ id: req.id, state: { taskId: req.taskId } }) + '\n'); continue; }
        sock.write(JSON.stringify({ id: req.id, ok: true }) + '\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, server, closedPromise, seen, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('correct token succeeds on execute', async () => {
  const fw = await startFakeWorker();
  const c = new CodexWorkerClient({ host: '127.0.0.1', port: fw.port, token: TOKEN });
  await c.connect();
  const res = await c.execute('do it');
  assert.ok(res.success);
  assert.strictEqual(res.resultText, 'result done');
  assert.strictEqual(res.sessionId, 'th-1');
  assert.deepStrictEqual(fw.seen.auths, [TOKEN]);
  await c.shutdown();
  await fw.close();
});

test('wrong/missing token fails with auth mismatch and is surfaced as error', async () => {
  const fw = await startFakeWorker();
  const c = new CodexWorkerClient({ host: '127.0.0.1', port: fw.port, token: 'WRONG' });
  await c.connect();
  const res = await c.execute('do it');
  assert.strictEqual(res.success, false);
  assert.ok(res.error.includes('auth token mismatch'));
  await c.shutdown();
  await fw.close();
});

test('taskId is propagated on every request when bound', async () => {
  const fw = await startFakeWorker({ boundTaskId: 'task-99' });
  const c = new CodexWorkerClient({ host: '127.0.0.1', port: fw.port, token: TOKEN, taskId: 'task-99' });
  await c.connect();
  await c.execute('do it');
  assert.ok(fw.seen.taskIds.every((t) => t === 'task-99'));
  await c.shutdown();
  await fw.close();
});

test('bound worker rejects a mismatched taskId', async () => {
  const fw = await startFakeWorker({ boundTaskId: 'task-99' });
  const c = new CodexWorkerClient({ host: '127.0.0.1', port: fw.port, token: TOKEN, taskId: 'task-1' });
  await c.connect();
  const res = await c.execute('do it');
  assert.strictEqual(res.success, false);
  assert.ok(res.error.includes('task identity mismatch'));
  await c.shutdown();
  await fw.close();
});

test('shutdown succeeds and the worker server exits', async () => {
  const fw = await startFakeWorker();
  const c = new CodexWorkerClient({ host: '127.0.0.1', port: fw.port, token: TOKEN });
  await c.connect();
  const ok = await c.shutdown();
  assert.strictEqual(ok, true);
  await fw.closedPromise;
});

test('auth token is never emitted in surfaced result (client redacts)', async () => {
  const fw = await startFakeWorker({ echoTokenInResult: true });
  const c = new CodexWorkerClient({ host: '127.0.0.1', port: fw.port, token: TOKEN });
  await c.connect();
  const res = await c.execute('do it');
  assert.ok(!res.resultText.includes(TOKEN));
  assert.ok(res.resultText.includes('***'));
  await c.shutdown();
  await fw.close();
});

test('callOp state.load carries auth and returns state', async () => {
  const fw = await startFakeWorker();
  const c = new CodexWorkerClient({ host: '127.0.0.1', port: fw.port, token: TOKEN, taskId: 'task-7' });
  await c.connect();
  const r = await c.callOp('state.load', { taskId: 'task-7' });
  assert.deepStrictEqual(r.state, { taskId: 'task-7' });
  assert.deepStrictEqual(fw.seen.auths, [TOKEN]);
  assert.ok(fw.seen.taskIds.includes('task-7'));
  await c.shutdown();
  await fw.close();
});
