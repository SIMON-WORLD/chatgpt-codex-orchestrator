// chatgpt-codex-orchestrator: doctor / self-check (Batch D3 expansion).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeRepoDir, detectBypass } from './safety.js';

export const DEFAULT_CODEX_JS = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js';
function nodeBin() { return (typeof process !== 'undefined' && process.execPath) ? process.execPath : 'node'; }

export function doctorStatic({ codexJs = DEFAULT_CODEX_JS, stateDir, repoDir }) {
  const out = [];
  try { const ok = fs.existsSync(codexJs); out.push({ check: 'codex-js-discoverable', status: ok ? 'PASS' : 'FAIL', reason: ok ? codexJs : 'codex.js not found' }); }
  catch (e) { out.push({ check: 'codex-js-discoverable', status: 'FAIL', reason: e.message }); }
  try { const v = execFileSync(nodeBin(), [codexJs, '--version'], { encoding: 'utf8', timeout: 10000 }).trim(); out.push({ check: 'codex-version', status: v ? 'PASS' : 'WARN', reason: v }); }
  catch (e) { out.push({ check: 'codex-version', status: 'WARN', reason: 'cannot read version: ' + e.message }); }
  try { fs.mkdirSync(stateDir, { recursive: true }); fs.accessSync(stateDir, fs.constants.W_OK); out.push({ check: 'stateDir-writable', status: 'PASS', reason: stateDir }); }
  catch (e) { out.push({ check: 'stateDir-writable', status: 'FAIL', reason: e.message }); }
  try { const abs = normalizeRepoDir(repoDir); const ok = fs.existsSync(abs); out.push({ check: 'repoDir-legal', status: ok ? 'PASS' : 'FAIL', reason: abs + ' exists=' + ok }); }
  catch (e) { out.push({ check: 'repoDir-legal', status: 'FAIL', reason: e.message }); }
  const b = detectBypass({}); out.push({ check: 'dangerous-bypass', status: b.needsBypass ? 'WARN' : 'PASS', reason: b.note });
  return out;
}

export async function doctorLiveIo({ agent }) {
  const out = [];
  try {
    const browser = await agent.browsers.get('iab');
    out.push({ check: 'iab-available', status: browser ? 'PASS' : 'FAIL', reason: browser ? 'iab obtained' : 'no iab' });
    if (browser) {
      const tab = await browser.tabs.new();
      await tab.goto('https://chatgpt.com/');
      await tab.playwright.waitForLoadState('domcontentloaded').catch(() => {});
      await tab.playwright.waitForTimeout(4000);
      const w = tab.playwright;
      const composer = await w.locator('[contenteditable="true"]').count();
      const body = await w.locator('body').innerText().catch(() => '');
      const loggedIn = !/log\s*in|sign\s*in/i.test(body || '');
      out.push({ check: 'chatgpt-composer', status: composer > 0 && loggedIn ? 'PASS' : 'FAIL', reason: 'composer=' + composer + ' loggedIn=' + loggedIn });
      await tab.close().catch(() => {});
    }
  } catch (e) { out.push({ check: 'iab-available', status: 'FAIL', reason: e.message }); }
  return out;
}

export function doctorGit({ repoDir }) {
  try { execFileSync('git', ['-C', repoDir, 'rev-parse', '--git-dir'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore','pipe','ignore'] }); return { check: 'git-available', status: 'PASS', reason: 'git works in ' + repoDir }; }
  catch (e) { return { check: 'git-available', status: 'FAIL', reason: 'git error: ' + e.message }; }
}

export async function doctorContext({ repoDir }) {
  try { const { PacketContextProvider } = await import('./context-provider.js'); const p = new PacketContextProvider({ repoDir, git: false }); const pk = p.buildPacket(); return { check: 'context-provider', status: 'PASS', reason: 'packet files=' + pk.fileSnippets.length }; }
  catch (e) { return { check: 'context-provider', status: 'FAIL', reason: e.message }; }
}

export async function doctorIpc() {
  try {
    const net = await import('node:net');
    const ns = net.createServer ? net : (net.default || {});
    const createServer = ns.createServer;
    if (!createServer) return { check: 'localhost-ipc', status: 'WARN', reason: 'node:net.createServer unavailable' };
    return await new Promise((resolve) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve({ check: 'localhost-ipc', status: 'PASS', reason: 'bound 127.0.0.1:' + p })); });
      srv.on('error', (e) => resolve({ check: 'localhost-ipc', status: 'FAIL', reason: e.message }));
    });
  } catch (e) { return { check: 'localhost-ipc', status: 'WARN', reason: e.message }; }
}

export async function doctorProviderConfig({ configPath }) {
  try {
    const fs = await import('node:fs'); const ff = fs.default || fs;
    const txt = ff.readFileSync(configPath, 'utf8');
    const ok = /model_provider\s*=/.test(txt) && /\[model_providers\./.test(txt);
    return { check: 'provider-config', status: ok ? 'PASS' : 'WARN', reason: ok ? 'model_provider present' : 'no custom model_provider block' };
  } catch (e) { return { check: 'provider-config', status: 'WARN', reason: 'cannot read config: ' + e.message }; }
}

export function doctorCompat() {
  return [
    { check: 'compat: worker-from-env', status: 'WARN', reason: 'node REPL sandbox forbids descendant codex; worker must be started by the environment (exec_command).' },
    { check: 'compat: bearer-on-argv', status: 'WARN', reason: 'local governor passes bearer token on codex child argv; redacted in logs/state.' },
  ];
}

export function formatDoctor(checks) {
  return checks.map((c) => c.status.padEnd(5) + ' ' + c.check + ' :: ' + c.reason).join('\n');
}