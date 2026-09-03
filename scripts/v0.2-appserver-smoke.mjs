// chatgpt-codex-orchestrator: REAL App Server smoke (M5 final).
// Credential-safe: does NOT copy the user auth.json and does NOT write any bearer token
// into the temp config.toml. It discovers the user's current (cc-switch) provider, runs a
// minimal read-only Responses protocol probe, then drives the real App Server using an
// isolated CODEX_HOME profile whose provider reads the credential from a process-only env
// var (V02_CODEX_PROVIDER_TOKEN). Credential never enters argv/report/repo/temp config;
// temp CODEX_HOME is deleted on exit.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { AppServerClient } from '../src/executor/app-server-client.js';
import { AppServerExecutor } from '../src/executor/app-server-executor.js';
import { discoverCodexAppServer } from '../src/transport/codex.js';
import { discoverProvider, prepareIsolatedCodexHome, injectProviderTokenEnv, probeResponsesCompatibility } from '../src/transport/codex-profile.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  let dataRoot = null;
  try {
    const provider = discoverProvider();
    process.stdout.write('provider_id=' + provider.providerId + ' base_url=' + provider.baseUrl + ' model=' + provider.model + ' bearer_present=' + provider.hasToken + '\n');

    const probe = await probeResponsesCompatibility(provider);
    process.stdout.write('CC_SWITCH_RESPONSES_PROTOCOL=' + (probe.ok ? 'PASS' : 'FAIL') + '\n');
    if (probe.events) process.stdout.write('protocol_events=' + [...new Set(probe.events)].slice(0, 14).join(',') + '\n');
    if (!probe.ok) {
      process.stdout.write('blocker_classification=provider_protocol_incompatible\nreason=' + (probe.reason || '') + '\n');
      process.exit(1);
    }
    if (!provider.token) { process.stdout.write('REAL_APP_SERVER_SMOKE=FAIL\nreason=provider credential not present in user config\n'); process.exit(1); }

    dataRoot = process.env.V02_SMOKE_DATA_ROOT || path.join(os.tmpdir(), 'v02-codesmoke-' + Date.now());
    const { home } = prepareIsolatedCodexHome(provider, dataRoot, { model: process.env.CODEX_MODEL || null });
    const env = { ...process.env, CODEX_HOME: home };
    injectProviderTokenEnv(provider);
    if (provider.token) env.V02_CODEX_PROVIDER_TOKEN = provider.token;

    const codex = discoverCodexAppServer();
    const client = new AppServerClient({ codexBin: codex.bin, spawnArgs: codex.argv, env, cwd: dataRoot });
    const executor = new AppServerExecutor({ dataRoot, client, cwd: dataRoot });
    try {
      const started = await executor.start({ prompt: 'Reply with exactly the marker REAL_CODEX_SMOKE_OK and nothing else.', cwd: dataRoot, accessMode: 'read_only', workspaceRoot: dataRoot, workspaceId: 'smoke' });
      process.stdout.write('effectiveVerified=' + started.effectiveVerified + ' effectiveSandbox=' + started.effectiveSandbox + ' effectiveApprovalPolicy=' + started.effectiveApprovalPolicy + '\n');
      if (started.effectiveVerified !== true || started.effectiveSandbox !== 'read-only') { await executor.shutdown(); process.stdout.write('REAL_APP_SERVER_SMOKE=FAIL\nreason=effective permission not verified as read-only\n'); process.exitCode = 1; return; }
      let got = null, state = null;
      for (let i = 0; i < 240; i++) {
        const g = await executor.get({ jobId: started.jobId }); got = g.result; state = g.state;
        if (got && got.includes('REAL_CODEX_SMOKE_OK')) break;
        if (['completed', 'failed', 'recovery_required'].includes(state) && (got || state === 'failed')) break;
        await sleep(500);
      }
      if (got && got.includes('REAL_CODEX_SMOKE_OK')) {
        process.stdout.write('REAL_APP_SERVER_SMOKE=PASS\nstate=' + state + ' result=' + (got || '').slice(0, 160) + '\n');
        await executor.shutdown();
        return;
      }
      const stderr = client.stderrTail;
      const classification = /invalid key|401|unauthor|bearer/i.test(stderr) ? 'provider_auth' : (stderr.includes('agentMessage') ? 'app_server' : 'provider_protocol');
      process.stdout.write('REAL_APP_SERVER_SMOKE=FAIL\nstate=' + state + ' classification=' + classification + ' reason=' + (!got ? 'no assistant result extracted' : 'marker missing') + '\n');
      process.stdout.write('note=background MCP reconnect logs are not the model-turn root cause\n');
      await executor.shutdown();
      process.exitCode = 1;
    } catch (e) { process.stdout.write('REAL_APP_SERVER_SMOKE=FAIL\nerror=' + String(e.message || e).slice(0, 240) + '\n'); try { await executor.shutdown(); } catch {} process.exitCode = 1; }
  } finally { if (dataRoot) { try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {} } }
}
main();
