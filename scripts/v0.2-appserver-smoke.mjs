// chatgpt-codex-orchestrator: REAL App Server smoke (M5 Phase C).
// Sets up an isolated user-level CODEX_HOME runtime profile for the orchestrator
// (never touches ~/.codex/config.toml), then drives the real Codex App Server:
//   initialize -> thread/start -> turn/start -> wait terminal -> thread/read
//   -> extract assistant result -> contains REAL_CODEX_SMOKE_OK -> clean shutdown
// Output: REAL_APP_SERVER_SMOKE=PASS or a precise non-sensitive root cause.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { AppServerClient } from '../src/executor/app-server-client.js';
import { AppServerExecutor } from '../src/executor/app-server-executor.js';

const NODE_BIN = process.execPath;
const CODEX_JS = process.env.CODEX_JS || 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function setupCodexProfile(dataRoot) {
  const home = path.join(dataRoot, 'codex-profile');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  // A minimal, valid config. `service_tier` is left at its default (no invalid value),
  // and we do NOT copy any credential into the repo.
  const config = [
    '# orchestrator v0.2 isolated Codex runtime profile',
    'model_provider = "openai"',
    'model = "gpt-5.4"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
  ].join('\n');
  fs.writeFileSync(path.join(home, 'config.toml'), config, 'utf8');
  return home;
}

async function main() {
  const dataRoot = process.env.V02_SMOKE_DATA_ROOT || path.join(os.tmpdir(), 'v02-codesmoke-' + Date.now());
  fs.mkdirSync(dataRoot, { recursive: true });
  const profileHome = setupCodexProfile(dataRoot);

  // Real Codex: spawn node <codex.js> app-server --listen stdio://, in the isolated CODEX_HOME.
  const client = new AppServerClient({
    codexBin: NODE_BIN,
    spawnArgs: [CODEX_JS, 'app-server', '--listen', 'stdio://'],
    env: { ...process.env, CODEX_HOME: profileHome },
    cwd: dataRoot,
  });
  const executor = new AppServerExecutor({ dataRoot, client, cwd: dataRoot });

  try {
    const started = await executor.start({
      prompt: 'Reply with exactly the marker REAL_CODEX_SMOKE_OK and nothing else.',
      cwd: dataRoot,
      workspaceRoot: dataRoot,
      workspaceId: 'smoke',
    });
    // Poll for the terminal result.
    let got = null;
    let state = null;
    for (let i = 0; i < 200; i++) {
      const g = await executor.get({ jobId: started.jobId });
      got = g.result;
      state = g.state;
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
    // Gather a precise, non-sensitive root cause.
    const stderrTail = client.stderrTail;
    if (!got) {
      const reason = (state && state === 'recovery_required') ? 'turn did not reach a completable terminal (recovery_required)' : 'no assistant result extracted';
      const detail = stderrTail ? ('stderr=' + stderrTail.slice(-240)) : '';
      process.stdout.write('REAL_APP_SERVER_SMOKE=FAIL\n');
      process.stdout.write('state=' + state + ' reason=' + reason + ' ' + detail + '\n');
    } else {
      const cause = /authenticat|auth|invalid key|UnknownIssuer|certificate|network|proxy/i.test(got + stderrTail) ? 'authentication/certificate/network' : 'model did not return the expected marker';
      process.stdout.write('REAL_APP_SERVER_SMOKE=FAIL\n');
      process.stdout.write('state=' + state + ' result=' + (got || '').slice(0, 160) + ' cause=' + cause + '\n');
    }
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
