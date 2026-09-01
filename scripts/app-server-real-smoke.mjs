// scripts/app-server-real-smoke.mjs
// OPTIONAL / GATED real local Codex App Server smoke for M1.
// Launches the installed `codex app-server --listen stdio://`, initializes,
// thread/start with an isolated harmless temp cwd, one harmless read-only turn,
// waits until terminal via bounded polling, thread/read, extracts the expected
// marker SMOKE_OK, then clean shutdown.
//
// Does NOT modify ~/.codex/config.toml. Attempts an isolated CODEX_HOME override
// of the invalid service_tier (or falls back to a command config override).
//
// Run explicitly (NOT part of `npm test`):
//   node scripts/app-server-real-smoke.mjs
// Exit 0 = PASS, 3 = BLOCKED (non-secret env restriction), 1 = FAIL.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { AppServerClient } from '../src/executor/app-server-client.js';

const MARKER = 'SMOKE_OK';
const TURN_TIMEOUT_MS = 40000;

function collectText(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') { if (value.trim()) out.push(value); return out; }
  if (typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const v of value) collectText(v, out); return out; }
  if (typeof value.text === 'string') out.push(value.text);
  if (typeof value.payload === 'string') out.push(value.payload);
  if (typeof value.content === 'string') out.push(value.content);
  for (const k of Object.keys(value)) {
    if (k === 'text' || k === 'payload' || k === 'content') continue;
    collectText(value[k], out);
  }
  return out;
}

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'app-server-smoke-'));
  // Try an isolated CODEX_HOME first; fall back to overriding service_tier via CLI.
  let extraArgs = [];
  const smokeCodexHome = process.env.SMOKE_CODEX_HOME || null;
  const env = { ...process.env };
  if (smokeCodexHome) {
    env.CODEX_HOME = smokeCodexHome;
  } else {
    // Option B: supported command override replacing the invalid service_tier.
    extraArgs = ['-c', 'service_tier="flex"'];
  }

  const client = new AppServerClient({ codexBin: 'codex', listen: 'stdio://', cwd, extraArgs, env });
  try {
    const init = await client.connect();
    process.stdout.write(`initialize ok (userAgent=${init.userAgent})\n`);
    const threadRes = await client.request('thread/start', { cwd });
    const threadId = threadRes && threadRes.thread && threadRes.thread.id;
    if (!threadId) throw new Error('thread/start returned no thread id');
    process.stdout.write(`thread/start ok (threadId=${threadId})\n`);

    const turnRes = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: `Reply with exactly: ${MARKER}`, text_elements: [] }],
    });
    const turnId = turnRes && turnRes.turn && turnRes.turn.id;
    if (!turnId) throw new Error('turn/start returned no turn id');
    process.stdout.write(`turn/start ok (turnId=${turnId})\n`);

    // Bounded polling until the turn reaches a terminal state.
    let terminal = null;
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    let read = null;
    while (Date.now() < deadline) {
      read = await client.request('thread/read', { threadId, includeTurns: true });
      const thread = read && read.thread;
      const turns = thread && Array.isArray(thread.turns) ? thread.turns : [];
      const turn = turns.find((t) => t && t.id === turnId);
      terminal = turn && turn.status;
      if (terminal === 'completed' || terminal === 'failed' || terminal === 'interrupted') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!['completed', 'failed', 'interrupted'].includes(terminal)) {
      throw new Error('turn did not reach a terminal state within timeout');
    }
    process.stdout.write(`turn terminal state=${terminal}\n`);

    const thread = read && read.thread;
    const text = collectText(thread).join('\n');
    const found = text.includes(MARKER);
    process.stdout.write(found ? `observed marker ${MARKER}\n` : `MARKER NOT FOUND in thread result\n`);

    await client.close();
    if (found && terminal === 'completed') {
      process.stdout.write('SMOKE PASS\n');
      process.exit(0);
    }
    process.stdout.write(terminal === 'completed' ? `SMOKE FAIL: terminal completed but marker ${MARKER} not observed\n` : `SMOKE FAIL: terminal=${terminal}\n`);
    process.exit(1);
  } catch (e) {
    const msg = String(e && e.message || e);
    process.stdout.write(`SMOKE BLOCKED/FAIL: ${msg}\n`);
    if (/auth|login|credential|token|401|403|not signed|experimental|config.toml|unknown variant|failed to load configuration|service_tier|requires authentication|not authenticated/i.test(msg)) {
      process.stderr.write(`REAL_APP_SERVER_SMOKE=BLOCKED\n`);
      process.exit(3);
    }
    process.stderr.write(`REAL_APP_SERVER_SMOKE=FAIL\n`);
    process.exit(1);
  } finally {
    try { await client.close(); } catch {}
  }
}

main();
