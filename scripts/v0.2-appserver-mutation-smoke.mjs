// chatgpt-codex-orchestrator: REAL Codex workspace-write mutation smoke (M7-B fix).
// Proves that accessMode=workspace_write actually grants the real Codex App Server
// effective workspace-write permission: the Codex turn itself creates a probe file
// in the temp workspace AND writes a second file via an executed shell command. The
// script NEVER pre-writes either file. If the effective sandbox were read-only, the
// Codex turn could not create them, and this smoke would FAIL.
//
// Credential-safe: same isolated CODEX_HOME / provider-token-in-env contract as the
// read-only smoke. No auth.json copied, token never in argv/report/repo/temp config.
//
// Approval handling: workspace-write jobs surface real command/fileChange approval
// requests (per approving-policy on-request). This smoke AUTO-APPROVES only the binary
// command/fileChange approvals for its own disposable probe files (safe, temp). It does
// NOT auto-approve structured permission escalations (those stay fail-closed).
//
// Output markers:
//   CC_SWITCH_RESPONSES_PROTOCOL=PASS/FAIL
//   REAL_CODEX_WORKSPACE_WRITE=PASS/FAIL
//   PYTHON_CAPABILITY=present|absent|policy_blocked|unknown

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { AppServerClient } from '../src/executor/app-server-client.js';
import { AppServerExecutor } from '../src/executor/app-server-executor.js';
import { discoverCodexAppServer } from '../src/transport/codex.js';
import { discoverProvider, prepareIsolatedCodexHome, injectProviderTokenEnv, probeResponsesCompatibility } from '../src/transport/codex-profile.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function runGit(dir, args) { try { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }); } catch {} }

async function waitResult(executor, jobId, { marker = null, timeoutMs = 180000, intervalMs = 1500 } = {}) {
  const start = Date.now();
  let last = { state: 'running', result: null, pendingApprovals: [] };
  while (Date.now() - start < timeoutMs) {
    last = await executor.get({ jobId });
    // Auto-approve only the safe binary command/fileChange approvals for this controlled smoke.
    for (const p of (last.pendingApprovals || [])) {
      if (p.supportedDecisionMode) {
        try { await executor.respondApproval({ jobId, approvalId: p.approvalId, decision: 'approve' }); process.stdout.write('approved ' + p.kind + ' for job ' + jobId + '\n'); }
        catch (e) { process.stdout.write('approval-error ' + p.kind + ' ' + String(e.message || e).slice(0, 120) + '\n'); }
      } else {
        process.stdout.write('unhandled structured approval kind=' + p.kind + ' method=' + p.method + '\n');
      }
    }
    if (marker && last.result && last.result.includes(marker)) return { ok: true, got: last.result, state: last.state };
    if (last.state === 'completed' || last.state === 'failed' || last.state === 'recovery_required') {
      if (marker && last.result && last.result.includes(marker)) return { ok: true, got: last.result, state: last.state };
      return { ok: false, got: last.result, state: last.state };
    }
    await sleep(intervalMs);
  }
  return { ok: false, got: last.result, state: last.state, timeout: true };
}

async function main() {
  let dataRoot = null;
  let executor = null;
  try {
    const provider = discoverProvider();
    process.stdout.write('provider_id=' + provider.providerId + ' base_url=' + provider.baseUrl + ' model=' + provider.model + ' bearer_present=' + provider.hasToken + '\n');

    const probe = await probeResponsesCompatibility(provider);
    process.stdout.write('CC_SWITCH_RESPONSES_PROTOCOL=' + (probe.ok ? 'PASS' : 'FAIL') + '\n');
    if (!probe.ok) { process.stdout.write('blocker_classification=provider_protocol_incompatible\nreason=' + (probe.reason || '') + '\n'); process.exit(1); }
    if (!provider.token) { process.stdout.write('REAL_CODEX_WORKSPACE_WRITE=FAIL\nreason=provider credential not present in user config\n'); process.exit(1); }

    dataRoot = process.env.V02_SMOKE_DATA_ROOT || path.join(os.tmpdir(), 'v02-mutation-' + Date.now());
    const ws = path.join(dataRoot, 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    runGit(ws, ['init', '-q']);
    runGit(ws, ['config', 'user.email', 'smoke@example.com']);
    runGit(ws, ['config', 'user.name', 'smoke']);

    const { home } = prepareIsolatedCodexHome(provider, dataRoot, { model: process.env.CODEX_MODEL || null });
    const env = { ...process.env, CODEX_HOME: home };
    injectProviderTokenEnv(provider);
    if (provider.token) env.V02_CODEX_PROVIDER_TOKEN = provider.token;

    const codex = discoverCodexAppServer();
    const client = new AppServerClient({ codexBin: codex.bin, spawnArgs: codex.argv, env, cwd: dataRoot });
    executor = new AppServerExecutor({ dataRoot, client, cwd: dataRoot });

    // ---- Phase 1: workspace-write mutation ----
    const probeFile = path.join(ws, 'REAL_CODEX_WORKSPACE_WRITE_PROBE.txt');
    const shellProbeFile = path.join(ws, 'REAL_CODEX_SHELL_PROBE.txt');
    const mutPrompt = [
      'Work in the current workspace directory. Do each of the following steps EXACTLY and do not skip any:',
      '1. Use a write tool to create a file named REAL_CODEX_WORKSPACE_WRITE_PROBE.txt in the current directory containing exactly the text: REAL_CODEX_WORKSPACE_WRITE',
      '2. Use the shell to run the following command exactly: echo SHELL_PROBE_OK > REAL_CODEX_SHELL_PROBE.txt',
      '3. Use the shell to run: pwd',
      '4. Use the shell to run: git status --short',
      '5. In your final message, print exactly the line: REAL_CODEX_WORKSPACE_WRITE_DONE',
      'Do not stop until all steps are done. Do not report success unless the files were actually created.',
    ].join('\n');
    const mut = await executor.start({ prompt: mutPrompt, cwd: ws, accessMode: 'workspace_write', workspaceRoot: ws, workspaceId: 'mutation-smoke', networkAccess: true });
    process.stdout.write('mutation_jobId=' + mut.jobId + ' requestedSandbox=' + mut.sandbox + ' effectiveVerified=' + mut.effectiveVerified + ' effectiveSandbox=' + mut.effectiveSandbox + ' effectiveApprovalPolicy=' + mut.effectiveApprovalPolicy + ' networkAccess=' + (mut.permissionContract && mut.permissionContract.networkAccess) + ' effectiveWritableRootMatch=' + (mut.permissionContract && mut.permissionContract.effectiveWritableRootMatch) + '\n');
    const res = await waitResult(executor, mut.jobId, { marker: 'REAL_CODEX_WORKSPACE_WRITE_DONE', timeoutMs: 300000, intervalMs: 1500 });

    const probeExists = fs.existsSync(probeFile);
    const probeOk = probeExists && fs.readFileSync(probeFile, 'utf8').trim() === 'REAL_CODEX_WORKSPACE_WRITE';
    const shellExists = fs.existsSync(shellProbeFile);
    const shellOk = shellExists && fs.readFileSync(shellProbeFile, 'utf8').trim() === 'SHELL_PROBE_OK';
    const doneMarker = !!(res.got && res.got.includes('REAL_CODEX_WORKSPACE_WRITE_DONE'));

    const contractOk = mut.effectiveVerified === true && mut.effectiveSandbox === 'workspace-write';
    const pass = contractOk && probeOk && shellOk && doneMarker;
    process.stdout.write('permission_evidence effectiveVerified=' + mut.effectiveVerified + ' effectiveSandbox=' + mut.effectiveSandbox + ' effectiveApprovalPolicy=' + mut.effectiveApprovalPolicy + ' effectiveWritableRootMatch=' + (mut.permissionContract && mut.permissionContract.effectiveWritableRootMatch) + ' effectiveNetworkAccess=' + (mut.permissionContract && mut.permissionContract.effectiveNetworkAccess) + '\n');
    process.stdout.write('REAL_CODEX_WORKSPACE_WRITE=' + (pass ? 'PASS' : 'FAIL') + '\n');
    process.stdout.write('evidence probe_file_exists=' + probeExists + ' probe_content_ok=' + probeOk + ' shell_file_exists=' + shellExists + ' shell_content_ok=' + shellOk + ' done_marker=' + doneMarker + '\n');
    process.stdout.write('mutation_state=' + res.state + '\n');
    if (!pass) { process.stdout.write('reason=' + (!contractOk ? 'permission contract not verified as workspace_write' : (res.timeout ? 'timeout waiting for mutation turn' : (res.state === 'failed' ? 'mutation turn failed' : 'mutation evidence missing'))) + '\n'); await executor.shutdown(); process.exitCode = 1; return; }

    // ---- Phase 2: best-effort python capability probe (read_only) ----
    const pyPrompt = [
      'Run the following from the current directory, in order, until one succeeds:',
      '  python3 --version',
      '  py --version',
      '  python --version',
      'Based ONLY on what the command actually printed, in your final message:',
      '  - if you saw a Python version string, print: PYTHON_BINARY_PRESENT',
      '  - if every command reported not found / not recognized / command not found, print: PYTHON_BINARY_ABSENT',
      '  - if a command was blocked by policy / permission / sandbox, print: PYTHON_POLICY_BLOCKED',
      'Then print exactly: PYTHON_PROBE_DONE',
    ].join('\n');
    let pyClass = 'unknown';
    try {
      const py = await executor.start({ prompt: pyPrompt, cwd: ws, accessMode: 'read_only', workspaceRoot: ws, workspaceId: 'python-probe' });
      const pyRes = await waitResult(executor, py.jobId, { marker: 'PYTHON_PROBE_DONE', timeoutMs: 180000, intervalMs: 1500 });
      const t = (pyRes.got || '');
      if (t.includes('PYTHON_BINARY_PRESENT') || /Python\s+3\.[0-9]+/.test(t)) pyClass = 'present';
      else if (t.includes('PYTHON_BINARY_ABSENT') || /not (found|recognized)|command not found/i.test(t)) pyClass = 'absent';
      else if (t.includes('PYTHON_POLICY_BLOCKED') || /blocked|permission|denied|not allowed/i.test(t)) pyClass = 'policy_blocked';
    } catch (e) { pyClass = 'unknown'; }
    process.stdout.write('PYTHON_CAPABILITY=' + pyClass + '\n');

    process.stdout.write('REAL_CODEX_MUTATION_SMOKE=COMPLETE\n');
    await executor.shutdown();
  } finally { if (executor) { try { await executor.shutdown(); } catch {} } if (dataRoot) { try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {} } }
}

main().catch((e) => { process.stdout.write('REAL_CODEX_WORKSPACE_WRITE=FAIL\nerror=' + String(e.message || e).slice(0, 300) + '\n'); process.exit(1); });
