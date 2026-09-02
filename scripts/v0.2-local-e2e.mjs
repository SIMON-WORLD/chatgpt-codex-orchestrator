// chatgpt-codex-orchestrator: v0.2 production-path local E2E (M5 Phase E).
// Runs the full production runtime over MCP:
//   initialize -> route_decide -> PLAN -> TASK(direct) -> read -> edit preview/apply
//   -> verify -> governance_record_result -> TASK(codex) -> codex_start -> codex_get
//   -> governance_record_result -> DONE
// Output: PRODUCTION_LOCAL_E2E=PASS or a non-sensitive root cause.
//
// Codex leg: by default uses the deterministic fake App Server fixture so the whole
// orchestration path is proven. Use --real-codex to drive the real installed Codex
// App Server (blocked by network/cert in this environment, see REAL_APP_SERVER_SMOKE).

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createBrainLocalRuntime, loadV02Config } from '../src/transport/brain-local.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_FIXTURE = path.join(__dirname, '..', 'test-fixtures', 'executor', 'fake-app-server.mjs');
import { discoverCodexAppServer, resolveCodexAppServer } from '../src/transport/codex.js';
import { discoverProvider, prepareIsolatedCodexHome, injectProviderTokenEnv } from '../src/transport/codex-profile.js';
const DISCOVERED = discoverCodexAppServer();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function textOf(res) { const t = res && res.content && res.content.find((c) => c.type === 'text'); return t ? t.text : ''; }

async function main() {
  const useReal = process.argv.includes('--real-codex');
  const dataRoot = path.join(os.tmpdir(), 'v02-e2e-' + Date.now());
  const workspace = path.join(dataRoot, 'repo');
  fs.mkdirSync(workspace, { recursive: true });
  // A temp Git repo + a file to edit.
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'hello world', 'utf8');
  runGit(workspace, ['init', '-q']);
  runGit(workspace, ['config', 'user.email', 'e2e@example.com']);
  runGit(workspace, ['config', 'user.name', 'e2e']);

  let provider = null;
  if (useReal) { provider = discoverProvider(); const ph = prepareIsolatedCodexHome(provider, dataRoot, { model: process.env.CODEX_MODEL || null }); injectProviderTokenEnv(provider); }
  const codexConfig = useReal
    ? { bin: DISCOVERED.bin, spawnArgs: DISCOVERED.argv, cwd: dataRoot, runtimeProfile: provider ? path.join(dataRoot, 'codex-profile') : null }
    : { bin: process.execPath, spawnArgs: [FAKE_FIXTURE], cwd: dataRoot, extraArgs: [] };
  const config = loadV02Config({
    port: 0,
    workspaceRoot: workspace,
    dataRoot,
    codex: codexConfig,
    verify: { syntax: { command: process.execPath, args: ['-e', 'process.exit(0)'], effect: 'read_only', timeoutMs: 10000 } },
  });

  const runtime = createBrainLocalRuntime(config);
  await runtime.start();
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(runtime.mcp.url));

  async function call(name, args) { const r = await client.callTool({ name, arguments: args }); return JSON.parse(textOf(r)); }

  try {
    const route = await call('route_decide', { requiresLocal: true, mutationRequired: true, boundedChange: true, exactChangeKnown: true });
    if (route.route !== 'CHATGPT_DIRECT_LOCAL') throw new Error('route_decide expected DIRECT_LOCAL, got ' + route.route);

    await call('governance_transition', { taskId: 't1', control: 'PLAN' });
    await call('governance_transition', { taskId: 't1', stepId: 's1', control: 'TASK', acceptance: [{ id: 'a1', required: true }], route: 'CHATGPT_DIRECT_LOCAL' });
    const ws = await call('workspace_open', { path: workspace });
    const rd = await call('read', { workspaceId: ws.workspaceId, path: 'a.txt' });
    if (!rd.sha256) throw new Error('read did not return sha256');
    const p = await call('edit', { workspaceId: ws.workspaceId, mode: 'preview', change: { path: 'a.txt', baseHash: rd.sha256, replacements: [{ oldText: 'world', newText: 'there' }] } });
    const a = await call('edit', { workspaceId: ws.workspaceId, mode: 'apply', changeSetId: p.changeSetId });
    if (a.status !== 'applied') throw new Error('edit apply failed');
    const v = await call('verify', { workspaceId: ws.workspaceId, check: 'syntax' });
    if (v.passed !== true) throw new Error('verify did not pass');
    await call('governance_record_result', { taskId: 't1', stepId: 's1', executorStatus: 'success', evidence: [{ acceptanceId: 'a1', status: 'pass' }] });

    // Advance to the Codex step.
    await call('governance_transition', { taskId: 't1', stepId: 's2', control: 'TASK', acceptance: [{ id: 'a2', required: true }], route: 'CODEX_DELEGATE' });
    const started = await call('codex_start', { workspaceId: ws.workspaceId, prompt: useReal ? 'Reply with exactly REAL_CODEX_E2E_OK' : 'do it' });
    if (!started.jobId) throw new Error('codex_start did not return jobId');
    let got = null;
    for (let i = 0; i < 300; i++) {
      const g = await call('codex_get', { workspaceId: ws.workspaceId, jobId: started.jobId });
      got = g.result;
      if (got && (useReal ? got.includes('REAL_CODEX_E2E_OK') : (got.includes('TASK_DONE_MARKER') || got.includes('ASSISTANT_OUTPUT_TEXT_MARKER')))) break;
      await sleep(useReal ? 300 : 20);
    }
    if (!got || !(useReal ? got.includes('REAL_CODEX_E2E_OK') : (got.includes('TASK_DONE_MARKER') || got.includes('ASSISTANT_OUTPUT_TEXT_MARKER')))) throw new Error('codex_get did not return the expected assistant result');
    await call('governance_record_result', { taskId: 't1', stepId: 's2', executorStatus: 'success', evidence: [{ acceptanceId: 'a2', status: 'pass' }] });
    const done = await call('governance_transition', { taskId: 't1', stepId: 's2', control: 'DONE' });
    if (done.blocked) throw new Error('DONE blocked: ' + done.reason);

    process.stdout.write((useReal ? 'PRODUCTION_REAL_CODEX_E2E=PASS' : 'PRODUCTION_LOCAL_E2E=PASS') + '\n');
    process.stdout.write('route=' + route.route + ' codexResult=' + (got || '').slice(0, 60) + '\n');
    await client.close();
    await runtime.close();
    process.exit(0);
  } catch (e) {
    process.stdout.write((useReal ? 'PRODUCTION_REAL_CODEX_E2E=FAIL' : 'PRODUCTION_LOCAL_E2E=FAIL') + '\n');
    process.stdout.write('reason=' + String(e.message || e).slice(0, 300) + '\n');
    try { await client.close(); } catch {}
    try { await runtime.close(); } catch {}
    process.exit(1);
  }
}

import { execFileSync } from 'node:child_process';
function runGit(dir, args) { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }); }

main();
