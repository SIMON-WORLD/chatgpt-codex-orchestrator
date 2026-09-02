// chatgpt-codex-orchestrator: CodexExecutor - runs Codex tasks in one persistent thread.
// It drives the real Codex CLI (via node <codex.js>) with `exec` (new thread) and
// `exec resume <session_id>` (continue the same thread). The model/provider/token
// are read from ~/.codex/config.toml at runtime (not hardcoded).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
const DEFAULT_CODEX_JS = path.join(
  os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');

export function loadCodexConfig(configPath = path.join(DEFAULT_CODEX_HOME, 'config.toml')) {
  const text = fs.readFileSync(configPath, 'utf8');
  const lines = text.split(/\r?\n/);
  let model = null, modelProvider = null;
  let currentSection = null;
  const providers = {};
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('[')) { currentSection = t.slice(1, -1).trim(); continue; }
    const indented = raw !== t;
    if (!indented && currentSection === null) {
      const m = /^(\w+)\s*=\s*"([^"]*)"\s*$/.exec(t);
      if (m) { if (m[1] === 'model') model = m[2]; if (m[1] === 'model_provider') modelProvider = m[2]; }
      continue;
    }
    if (currentSection && currentSection.startsWith('model_providers.')) {
      const key = currentSection.slice('model_providers.'.length);
      const m = /^(\w+)\s*=\s*"?([^"]*)"?\s*$/.exec(t);
      if (m) {
        if (!providers[key]) providers[key] = {};
        if (m[1] === 'name') providers[key].name = m[2];
        if (m[1] === 'base_url') providers[key].baseUrl = m[2];
        if (m[1] === 'wire_api') providers[key].wireApi = m[2];
        if (m[1] === 'experimental_bearer_token') providers[key].bearerToken = m[2];
      }
    }
  }
  return { model, modelProvider, providers };
}

function parseJsonL(stdout) {
  const events = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch (e) { /* non-JSON scrollback */ }
  }
  return events;
}

function nodeExecutable() {
  return (typeof process !== 'undefined' && process.execPath) ? process.execPath : 'node';
}

function redact(s, secret) {
  let out = String(s || '');
  if (secret) out = out.split(secret).join('***');
  return out;
}

export function defaultSpawn(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: opts.cwd });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ stdout, stderr, code: -1, error: e.message }));
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

export class CodexExecutor {
  constructor({ repoDir, configPath, codexJs = DEFAULT_CODEX_JS, spawnFn = null, sandbox = 'workspace-write', ignoreRules = false, bypassSandbox = false } = {}) {
    this.repoDir = repoDir;
    this.cfg = loadCodexConfig(configPath);
    this.codexJs = codexJs;
    this.spawnFn = spawnFn || ((args, opts) => defaultSpawn(args, opts));
    this.sandbox = sandbox;
    this.ignoreRules = ignoreRules;
    this.bypassSandbox = bypassSandbox;
    this.sessionId = null;
  }

  _providerLiteral() {
    const p = this.cfg.providers[this.cfg.modelProvider];
    if (!p) throw new Error(`model provider not found in config: ${this.cfg.modelProvider}`);
    return `name="${p.name}", base_url="${p.baseUrl}", wire_api="${p.wireApi}", requires_openai_auth=true, experimental_bearer_token="${p.bearerToken}"`;
  }

  buildArgs(prompt) {
    const cc = [
      '-c', `model="${this.cfg.model}"`,
      '-c', `model_provider="${this.cfg.modelProvider}"`,
      '-c', `model_providers.${this.cfg.modelProvider}={ ${this._providerLiteral()} }`,
    ];
    // `-s` is only valid on `codex exec` (new thread). `resume` carries the
    // sandbox recorded in the session, so we never pass `-s` on resume.
    if (this.sessionId) {
      const args = ['exec', 'resume', '--json', ...cc];
      if (this.bypassSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
      if (this.ignoreRules) args.push('--ignore-rules');
      args.push(this.sessionId, prompt);
      return args;
    }
    const args = ['exec', '--json', '-C', this.repoDir, ...cc];
    if (this.bypassSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-s', this.sandbox);
    if (this.ignoreRules) args.push('--ignore-rules');
    args.push(prompt);
    return args;
  }

  async execute(prompt) {
    const args = this.buildArgs(prompt);
    const { stdout, stderr, code } = await this.spawnFn([nodeExecutable(), this.codexJs, ...args], { cwd: this.repoDir });

    const events = parseJsonL(stdout);
    let threadId = null, resultText = '', failedMsg = null;
    for (const ev of events) {
      if (ev.type === 'thread.started') threadId = ev.thread_id || threadId;
      if (ev.type === 'item.completed' && ev.item) {
        if (ev.item.type === 'agent_message') resultText = ev.item.text || resultText;
        if (ev.item.type === 'error') failedMsg = ev.item.message || failedMsg;
      }
      if (ev.type === 'turn.failed') failedMsg = (ev.error && ev.error.message) || failedMsg || 'turn.failed';
    }
    if (threadId) this.sessionId = threadId;

    const result = (resultText || '').trim();
    const success = code === 0 && Boolean(result) && !/Authentication|Unauthorized|not found/i.test(result);
    const secret = this.cfg.providers[this.cfg.modelProvider]?.bearerToken;

    return {
      sessionId: this.sessionId,
      resultText: redact(result, secret),
      exitCode: code,
      success,
      error: success ? null : redact((code !== 0 ? (failedMsg || stderr.trim() || 'codex exited non-zero') : `no reply (code=${code})`), secret),
    };
  }
}