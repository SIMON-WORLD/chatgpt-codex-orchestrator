// LEGACY / EXPERIMENTAL RUNTIME: this module is NOT on the canonical Direct Brain Loop\n// path. The default \\-command\ uses the current Codex agent + built-in browser\n// (see src/direct-mode.js). Retained for compatibility/experimental use only.\n// chatgpt-codex-orchestrator: long-lived Codex worker host (data owner).
// Runs in an ORDINARY Node process (started by the environment), so it can write the
// user-level data root. It owns ALL persistent runtime data: tasks, logs, projects,
// locks, runtime. The node REPL / IAB side talks to it over localhost IPC and never
// needs write access to the data root. Per-process random token + taskId auth.
//
// startWorkerHost() is the reusable worker bootstrap used by the brain-command worker
// entrypoint (scripts/brain-command-worker.mjs). When run directly this module parses
// argv and starts a worker the same way (backward compatible).
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSecret, redactObject } from '../src/safety.js';
import { runtimePaths } from '../src/runtime-paths.js';
import { CodexExecutor } from '../src/codex-executor.js';

function handleData(RUNTIME, op, req) {
  try {
    if (op === 'state.save') { const f = path.join(RUNTIME.tasks, req.state.taskId + '.json'); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(req.state), 'utf8'); fs.renameSync(tmp, f); return { ok: true }; }
    if (op === 'state.load') { const f = path.join(RUNTIME.tasks, req.taskId + '.json'); if (!fs.existsSync(f)) return { state: null }; return { state: JSON.parse(fs.readFileSync(f, 'utf8')) }; }
    if (op === 'state.list') { try { return { tasks: fs.readdirSync(RUNTIME.tasks).filter(x => x.endsWith('.json')).map(x => x.replace(/\.json$/, '')) }; } catch (e) { return { tasks: [] }; } }
    if (op === 'log.write') { fs.appendFileSync(path.join(RUNTIME.logs, (req.taskId || 'task') + '.jsonl'), JSON.stringify(redactObject(req.entry)) + '\n', 'utf8'); return { ok: true }; }
    if (op === 'projects.bind') { const k = String(req.repoDir || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 120); fs.writeFileSync(path.join(RUNTIME.projects, k + '.json'), JSON.stringify(req.rec), 'utf8'); return { ok: true }; }
    if (op === 'projects.get') { const k = String(req.repoDir || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 120); const f = path.join(RUNTIME.projects, k + '.json'); return { rec: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null }; }
    if (op === 'lock.acquire') {
      const f = path.join(RUNTIME.locks, req.taskId + '.lock');
      const staleMs = 5 * 60 * 1000;
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
      const write = () => { const fd = fs.openSync(f, 'wx'); fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ownerId: req.ownerId || 'w', taskId: req.taskId }), 'utf8'); fs.closeSync(fd); };
      try { write(); return { ok: true }; }
      catch (e) {
        if (e.code === 'EEXIST') {
          try {
            const ex = JSON.parse(fs.readFileSync(f, 'utf8'));
            const age = Date.now() - new Date(ex.at || 0).getTime();
            const ownerAlive = alive(ex.pid);
            if (!ownerAlive && age > staleMs) {
              fs.rmSync(f, { force: true });
              write();
              try { fs.appendFileSync(path.join(RUNTIME.logs, req.taskId + '.jsonl'), JSON.stringify({ type: 'lock.reclaim', taskId: req.taskId, at: new Date().toISOString() }) + '\n', 'utf8'); } catch (e2) {}
              return { ok: true, reclaimed: true };
            }
            return { ok: false, error: 'task locked' };
          } catch (e2) { return { ok: false, error: 'task locked' }; }
        }
        return { ok: false, error: e.message };
      }
    }
    if (op === 'lock.release') { try { fs.rmSync(path.join(RUNTIME.locks, req.taskId + '.lock'), { force: true }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } }
    return { ok: false, error: 'unknown op ' + op };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function startWorkerHost({
  repoDir, dataRoot, readyFile = null, port = 0, host = '127.0.0.1',
  token = null, taskId = null, bypassSandbox = false, session = null,
} = {}) {
  if (!repoDir) throw new Error('startWorkerHost requires repoDir');
  const RUNTIME = runtimePaths(dataRoot);
  for (const k of Object.keys(RUNTIME)) fs.mkdirSync(RUNTIME[k], { recursive: true });

  const ex = new CodexExecutor({ repoDir, bypassSandbox });
  if (session) ex.sessionId = session;
  const TOKEN = token || createSecret();
  const boundTaskId = taskId || null;

  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let req; try { req = JSON.parse(line); } catch { sock.write(JSON.stringify({ id: null, error: 'bad json' }) + '\n'); continue; }
        if (req.shutdown) { if (req.auth !== TOKEN) { sock.write(JSON.stringify({ id: req.id, error: 'auth token mismatch' }) + '\n'); continue; } sock.write(JSON.stringify({ id: req.id, ok: true }) + '\n'); server.close(); return; }
        if (req.auth !== TOKEN) { sock.write(JSON.stringify({ id: req.id, error: 'auth token mismatch' }) + '\n'); continue; }
        if (boundTaskId && req.taskId !== boundTaskId) { sock.write(JSON.stringify({ id: req.id, error: 'task identity mismatch' }) + '\n'); continue; }
        if (req.op) { sock.write(JSON.stringify({ id: req.id, ...handleData(RUNTIME, req.op, req) }) + '\n'); continue; }
        ex.execute(req.prompt).then((res) => {
          sock.write(JSON.stringify({ id: req.id, sessionId: res.sessionId, resultText: res.resultText, success: res.success, error: res.error }) + '\n');
        }).catch((e) => { sock.write(JSON.stringify({ id: req.id, error: e.message }) + '\n'); });
      }
    });
    sock.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const a = server.address();
      const info = { ready: true, host, port: a.port, token: TOKEN, dataRoot: RUNTIME.dataRoot };
      if (readyFile) { try { fs.writeFileSync(readyFile, JSON.stringify(info), 'utf8'); } catch (e) {} }
      resolve({
        port: a.port, host, token: TOKEN, dataRoot: RUNTIME.dataRoot, info, server,
        shutdown: () => new Promise((r) => { try { server.close(() => r()); } catch (e) { r(); } }),
      });
    });
  });
}

// --- Direct invocation (backward compatible) -----------------------------------
function arg(n){ const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i+1] : null; }
const has = (n) => process.argv.includes(n);
const isMain = typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  // Clear the Codex Desktop app env that makes a descendant codex attempt an in-process
  // app-server client (denied by the node REPL sandbox); point TMP/TEMP at a writable dir.
  for (const k of ['CODEX_INTERNAL_ORIGINATOR_OVERRIDE','CODEX_APP_TOOLS_PIPE_PATH','CODEX_SESSION_ID','CODEX_THREAD_ID','CODEX_MCP_NODE_PATH','CODEX_PERSIST_TEST','CODEX_PERSIST_TEST2']) {
    delete process.env[k];
  }
  try { process.env.TMP = os.tmpdir(); process.env.TEMP = os.tmpdir(); } catch (e) {}

  const repoDir = arg('--repo');
  const host = arg('--host') || '127.0.0.1';
  const port = Number(arg('--port') || '0');
  if (!repoDir) { console.error(JSON.stringify({ error: 'missing --repo' })); process.exit(2); }
  const dataRoot = arg('--data-root') || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'chatgpt-codex-orchestrator') : path.join(os.homedir(), '.chatgpt-codex-orchestrator'));

  startWorkerHost({ repoDir, dataRoot, readyFile: arg('--ready-file'), port, host, taskId: arg('--taskId'), bypassSandbox: has('--bypass'), session: arg('--session') })
    .then(({ info }) => { console.log(JSON.stringify(info)); })
    .catch((e) => { console.error(JSON.stringify({ error: e.message })); process.exit(1); });
}
