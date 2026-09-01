// chatgpt-codex-orchestrator: low-level Codex App Server JSON-RPC client (v0.2 M1).
// Spawns `codex app-server --listen stdio://` and speaks newline-delimited JSON-RPC.
// Protocol authority: `codex app-server generate-ts` (codex-cli 0.146.0).
//
// Framing (newline-delimited JSON objects):
//   - client request:   { id, method, params }
//   - server response:  { id, result } | { id, error }
//   - server notification: { method, params }            (no id)
//   - server request (approval): { id, method, params }  (must be answered)

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const DEFAULT_APP_SERVER_LISTEN = 'stdio://';
export const DEFAULT_CODEX_BIN = 'codex';
export const DEFAULT_CLIENT_NAME = 'chatgpt-codex-orchestrator';
export const DEFAULT_CLIENT_VERSION = '0.2.0';

let idCounter = 0;
function nextId() { return ++idCounter; }

export class AppServerClient {
  constructor({
    codexBin = DEFAULT_CODEX_BIN,
    listen = DEFAULT_APP_SERVER_LISTEN,
    spawnArgs = null,
    name = DEFAULT_CLIENT_NAME,
    version = DEFAULT_CLIENT_VERSION,
    cwd = (typeof process !== 'undefined' ? process.cwd() : undefined),
    env = null,
  } = {}) {
    this.codexBin = codexBin;
    this.listen = listen;
    this.spawnArgs = spawnArgs; // override full argv (e.g. tests: [fixturePath])
    this.name = name;
    this.version = version;
    this.cwd = cwd;
    this.env = env || undefined;
    this.child = null;
    this._rl = null;
    this.pending = new Map();       // id -> { resolve, reject, timer }
    this.notificationHandlers = new Set();
    this.serverRequestHandlers = new Set();
    this._stderr = '';
    this.exited = false;
    this._connected = false;
  }

  get stderrTail() { return this._stderr.slice(-2000); }
  get isRunning() { return !this.exited && !!this.child && this.child.exitCode === null; }

  _spawn() {
    if (this.spawnArgs) {
      this.child = spawn(this.codexBin, this.spawnArgs, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: this.env });
    } else {
      this.child = spawn(this.codexBin, ['app-server', '--listen', this.listen, '--stdio'], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: this.env });
    }
    this._rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this._rl.on('line', (line) => this._onLine(line));
    this.child.stdout.on('error', () => {});
    this.child.stderr.on('data', (d) => { this._stderr += String(d); });
    this.child.on('close', (code, signal) => {
      this.exited = true;
      this._failAllPending(`app-server exited (code=${code}, signal=${signal})`);
    });
    this.child.on('error', (err) => {
      this.exited = true;
      this._failAllPending('app-server spawn error: ' + err.message);
    });
  }

  _onLine(line) {
    if (!line || !line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // Response to one of our client requests.
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const key = String(msg.id);
      const p = this.pending.get(key);
      if (p) {
        this.pending.delete(key);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error('app-server error: ' + JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }

    // Server-initiated request (approval) with an id + method.
    if (msg.id != null && msg.method) {
      for (const h of this.serverRequestHandlers) { try { h(msg); } catch {} }
      return;
    }

    // Server notification (method, no id).
    if (msg.method) {
      for (const h of this.notificationHandlers) { try { h(msg); } catch {} }
      return;
    }
  }

  _failAllPending(reason) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }

  _send(obj) {
    if (this.exited || !this.child || this.child.exitCode !== null) throw new Error('app-server is not running');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params = {}, { timeoutMs = 120000 } = {}) {
    const id = nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      try {
        this._send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(e);
      }
    });
  }

  async connect() {
    if (this._connected && this.isRunning) return this;
    this._spawn();
    const init = await this.request('initialize', {
      clientInfo: { name: this.name, title: 'chatgpt-codex-orchestrator', version: this.version },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, { timeoutMs: 60000 });
    this._connected = true;
    return init;
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler) {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  // Answer a server-initiated request (approval) by id.
  respondRequest(id, result) {
    this._send({ id, result });
  }

  async close() {
    const child = this.child;
    if (child && !this.exited && child.exitCode === null) {
      try { child.stdin.end(); } catch {}
      await new Promise((res) => {
        const t = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} res(); }, 1500);
        child.once('close', () => { clearTimeout(t); res(); });
      });
    }
    if (this._rl) { try { this._rl.close(); } catch {} }
    this._connected = false;
  }
}
