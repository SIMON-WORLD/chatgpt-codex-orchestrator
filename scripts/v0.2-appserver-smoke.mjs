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
  const userHome = process.env.USER_CODEX_HOME || path.join(os.homedir(), '.codex');
  // Copy the user's auth.json into the isolated profile (user-local credential, never in repo/report).
  let copiedAuth = false;
  const userAuth = path.join(userHome, 'auth.json');
  if (fs.existsSync(userAuth)) { fs.copyFileSync(userAuth, path.join(home, 'auth.json')); copiedAuth = true; }
  // Build a MINIMAL config reusing the user's local model provider + bearer token (if any)
  // so the App Server routes to the reachable local endpoint instead of api.openai.com.
  const lines = ['model_provider = "openai-chat-completions"', 'approval_policy = "never"', 'sandbox_mode = "read-only"'];
  if (model) lines.push('model = "' + model + '"');
  let baseUrl = 'http://127.0.0.1:19100/v1';
  let token = null;
  const userConfig = path.join(userHome, 'config.toml');
  if (fs.existsSync(userConfig)) {
    const raw = fs.readFileSync(userConfig, 'utf8');
    const bu = raw.match(/base_url\s*=\s*"([^"]+)"/);
    if (bu) baseUrl = bu[1];
    const tk = raw.match(/experimental_bearer_token\s*=\s*"([^"]+)"/);
    if (tk) token = tk[1];
  }
  lines.push('[model_providers.openai-chat-completions]');
  lines.push('name = "deepseek"');
  lines.push('base_url = "' + baseUrl + '"');
  lines.push('wire_api = "responses"');
  lines.push('requires_openai_auth = true');
  if (token) lines.push('experimental_bearer_token = "' + token + '"');
  fs.writeFileSync(path.join(home, 'config.toml'), lines.join('\n') + '\n', 'utf8');
  return { home, copiedAuth };
}

async function main() {
  const dataRoot = process.env.V02_SMOKE_DATA_ROOT || path.join(os.tmpdir(), 'v02-codesmoke-' + Date.now());
  fs.mkdirSync(dataRoot, { recursive: true });
  const model = process.env.CODEX_MODEL || null;
  const profile = setupCodexProfile(dataRoot, model);
  const profileHome = profile.home;
  process.stdout.write('codex_profile_auth=' + (profile.copiedAuth ? 'copied' : 'absent') + '\n');

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
