// chatgpt-codex-orchestrator: CodexWorkerClient - localhost JSON-line client for the
// long-lived Codex worker host. Every authenticated request automatically carries the
// per-process auth token (and taskId when bound) so the worker's auth check always
// passes. The caller never needs runtime monkey-patching. The client also redacts its
// own token from any surfaced result so it never leaks into user-facing logs/results.
import net from 'node:net';

export class CodexWorkerClient {
  constructor({ host = '127.0.0.1', port, token = null, taskId = null } = {}) {
    this.host = host;
    this.port = port;
    this.token = token;
    this.taskId = taskId;
    this.id = 0;
    this.pending = new Map();
    this.buf = '';
    this.sessionId = null;
    this.sock = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, this.host, () => resolve());
      this.sock.on('error', reject);
      this.sock.on('data', (d) => {
        this.buf += d.toString();
        let nl;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          const waiter = this.pending.get(msg.id);
          if (waiter) { this.pending.delete(msg.id); waiter(msg); }
        }
      });
    });
  }

  // The worker host requires req.auth === TOKEN and (when bound) req.taskId for every
  // request. Both are injected automatically: auth is forced to this.token (payload
  // cannot override it) and taskId is added whenever a bound taskId is set.
  request(payload) {
    const id = ++this.id;
    const req = { id, ...payload, auth: this.token };
    if (this.taskId) req.taskId = this.taskId;
    const p = new Promise((resolve) => this.pending.set(id, resolve));
    this.sock.write(JSON.stringify(req) + '\n');
    return p;
  }

  _redact(s) {
    const secret = this.token;
    return secret ? String(s || '').split(secret).join('***') : String(s || '');
  }

  // Run one Codex prompt (new thread or resume). auth/taskId carried automatically;
  // the returned resultText/error have the auth token redacted.
  async execute(prompt) {
    const msg = await this.request({ prompt });
    if (msg && msg.error) return { sessionId: this.sessionId || null, resultText: '', success: false, error: this._redact(msg.error) };
    this.sessionId = msg.sessionId || this.sessionId;
    return { sessionId: this.sessionId, resultText: this._redact(msg.resultText), success: msg.success, error: msg.error ? this._redact(msg.error) : null };
  }

  // Any worker data/state operation (state.save/load/list, log.write, projects.bind/get,
  // lock.acquire/release). auth/taskId are carried automatically by request().
  async callOp(op, payload = {}) {
    const msg = await this.request({ op, ...payload });
    if (msg && msg.error) {
      const e = new Error(this._redact(msg.error));
      e.workerOp = op;
      throw e;
    }
    return msg;
  }

  // Graceful shutdown: ask the worker to close its server, then end the socket.
  async shutdown() {
    let ok = true;
    try { await this.request({ shutdown: true }); } catch (e) { ok = false; }
    try { if (this.sock) this.sock.end(); } catch (e) { ok = false; }
    return ok;
  }
}
