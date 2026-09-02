// chatgpt-codex-orchestrator: REAL App Server smoke (M5 Phase C / r1).
// Sets up an isolated user-level CODEX_HOME runtime profile for the orchestrator
// (never touches ~/.codex/config.toml), then drives the real Codex App Server:
//   initialize -> thread/start -> turn/start -> wait terminal -> thread/read
//   -> extract assistant result -> contains REAL_CODEX_SMOKE_OK -> clean shutdown
// Codex binary/argv is discovered (no hard-coded user path); model comes from
// CODEX_MODEL or the Codex default (no fixed model in source).
// Output: REAL_APP_SERVER_SMOKE=PASS or a precise non-sensitive root cause.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { AppServerClient } from '../src/executor/app-server-client.js';
import { AppServerExecutor } from '../src/executor/app-server-executor.js';
import { discoverCodexAppServer } from '../src/transport/codex.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function setupCodexProfile(dataRoot, model) {
  const home = path.join(dataRoot, 'codex-profile');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const lines = [
    '# orchestrator v0.2 isolated Codex runtime profile',
    'model_provider = "openai"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
  ];
  // Model is configurable; omit to use the Codex default.
  if (model) lines.push(`model = "${model}"`);
  fs.writeFileSync(path.join(home, 'config.toml'), lines.join('\n'), 'utf8');
  return home;
}

async function main() {
  const dataRoot = process.env.V02_SMOKE_DATA_ROOT || path.join(os.tmpdir(), 'v02-codesmoke-' + Date.now());
  fs.mkdirSync(dataRoot, { recursive: true });
  const model = process.env.CODEX_MODEL || null;
  const profileHome = setupCodexProfile(dataRoot, model);

  const codex = discoverCodexAppServer();
  const client = new AppServerClient({
    codexBin: codex.bin,
    spawnArgs: codex.argv,
    env: { ...process.env, CODEX_HOME: profileHome },
    cwd: dataRoot,
  });
  const executor = new AppServerExecutor({ dataRoot, client, cwd: dataRoot });

  let reason = null;
  try {
    const started = await executor.start({
      prompt: 'Reply with exactly the marker REAL_CODEX_SMOKE_OK and nothing else.',
      cwd: dataRoot,
      workspaceRoot: dataRoot,
      workspaceId: 'smoke',
    });
    let got = null, state = null;
    for (let i = 0; i < 240; i++) {
      const g = await executor.get({ jobId: started.jobId });
      got = g.result; state = g.state;
      if (got && got.includes('REAL_CODEX_SMOKE_OK')) break;
      if (['completed', 'failed', 'recovery_required'].includes(state) && got) break;
      await sleep(500);
    }
    if (got && got.includes('REAL_CODEX_SMOKE_OK')) {
      process.stdout.write('REAL_APP_SERVER_SMOKE=PASS\n');
      process.stdout.write('state=' + state + ' result=' + (got || '').slice(0, 160) + '\n');
      await executor.shutdown();
      process.exit(0);
    }
    const stderrTail = client.stderrTail;
    reason = !got ? (state === 'recovery_required' ? 'turn did not reach a completable terminal (recovery_required)' : 'no assistant result extracted') : 'model did not return the expected marker';
    const detail = /stream disconnected|UnknownIssuer|certificate|network|proxy|auth|invalid key/i.test((got || '') + stderrTail) ? 'codex_runtime_cannot_reach_model_endpoint (network/TLS/proxy)' : stderrTail.slice(-200);
    process.stdout.write('REAL_APP_SERVER_SMOKE=FAIL\n');
    process.stdout.write('state=' + state + ' reason=' + reason + ' detail=' + detail + '\n');
    await executor.shutdown();
    process.exit(1);
  } catch (e) {
    process.stdout.write('REAL_APP_SERVER_SMOKE=FAIL\n');
    process.stdout.write('error=' + String(e.message || e).slice(0, 240) + '\n');
    try { await executor.shutdown(); } catch {}
    process.exit(1);
  }
}

main();
