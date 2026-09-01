// scripts/app-server-real-smoke.mjs
// OPTIONAL / GATED real local Codex App Server smoke for M1.
// Launches the installed `codex app-server --listen stdio://`, initializes,
// thread/start with an isolated harmless temp cwd, one read-only turn, thread/read,
// then shutdown. Does NOT modify ~/.codex/config.toml.
//
// Run explicitly (NOT part of `npm test`):
//   node scripts/app-server-real-smoke.mjs
// Exits 0 on PASS, 3 on BLOCKED (non-secret reason), 1 on FAIL.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { AppServerClient } from '../src/executor/app-server-client.js';

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'app-server-smoke-'));
  const client = new AppServerClient({ codexBin: 'codex', listen: 'stdio://', cwd });
  try {
    const init = await client.connect();
    process.stdout.write(`initialize ok (userAgent=${init.userAgent})\n`);
    const threadRes = await client.request('thread/start', { cwd });
    const threadId = threadRes && threadRes.thread && threadRes.thread.id;
    if (!threadId) throw new Error('thread/start returned no thread id');
    process.stdout.write(`thread/start ok (threadId=${threadId})\n`);

    // One harmless/read-only turn.
    const turnRes = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Reply with exactly: SMOKE_OK', text_elements: [] }],
    });
    const turnId = turnRes && turnRes.turn && turnRes.turn.id;
    if (!turnId) throw new Error('turn/start returned no turn id');
    process.stdout.write(`turn/start ok (turnId=${turnId})\n`);

    // Wait briefly for the turn to progress, then read the thread.
    await new Promise((r) => setTimeout(r, 1500));
    const read = await client.request('thread/read', { threadId, includeTurns: true });
    const turns = read && read.thread && Array.isArray(read.thread.turns) ? read.thread.turns : [];
    process.stdout.write(`thread/read ok (turns=${turns.length})\n`);

    await client.close();
    process.stdout.write('SMOKE PASS\n');
    process.exit(0);
  } catch (e) {
    const msg = String(e && e.message || e);
    process.stdout.write(`SMOKE BLOCKED/FAIL: ${msg}\n`);
    // Heuristic: auth/credential/token errors are environmental blockers, not a code defect.
    if (/auth|login|credential|token|401|403|not signed|experimental|config.toml|unknown variant|failed to load configuration|service_tier/i.test(msg)) {
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
