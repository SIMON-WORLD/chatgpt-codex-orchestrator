// chatgpt-codex-orchestrator: v0.2 production runtime entrypoint (M5).
// Assembles the runtime (WorkspaceRegistry / MutationOwner / OperationState /
// ChangeSetService / VerifyService / CapabilityRouter / GovernanceService /
// AppServerExecutor / MCP server) and provides /mcp, /healthz, /readyz.
//
// Usage:
//   node scripts/v0.2-start.mjs [--config <path>] [--port <n>] [--workspace-root <root>]
//                                [--status] [--oneshot]
// Output (readable, non-sensitive):
//   { mcp, localMcp, appServer, tunnel, workspace, healthz, readyz, readyForChatGPT }

import { createBrainLocalRuntime, loadV02Config } from '../src/transport/brain-local.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.configPath = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--data-root') out.dataRoot = argv[++i];
    else if (a === '--workspace-root') out.workspaceRoot = argv[++i];
    else if (a === '--status') out.status = true;
    else if (a === '--oneshot') out.oneshot = true;
    else if (a === '--codex-bin') out.codexBin = argv[++i];
    else if (a === '--runtime-profile') out.runtimeProfile = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function setNoSaveEnv() {
  // Repo lives outside the workspace; keep repo clean. No-op placeholder.
}

let config;
try {
  config = loadV02Config({
    ...(args.port !== undefined ? { port: args.port } : {}),
    ...(args.dataRoot ? { dataRoot: args.dataRoot } : {}),
    ...(args.workspaceRoot ? { workspaceRoot: args.workspaceRoot } : {}),
    ...(args.codexBin ? { codex: { bin: args.codexBin } } : {}),
    ...(args.runtimeProfile ? { codex: { runtimeProfile: args.runtimeProfile } } : {}),
  }, { configPath: args.configPath || null });
} catch (e) {
  process.stderr.write('v0.2 config error: ' + e.message + '\n');
  process.exit(2);
}

if (!config.workspaceRoots.length) {
  process.stderr.write('v0.2 runtime requires a workspace root (--workspace-root or config.workspaceRoot/workspaceRoots)\n');
  process.exit(2);
}

const runtime = createBrainLocalRuntime(config);

async function main() {
  await runtime.start();
  await new Promise((r) => setTimeout(r, 500));
  const st = await runtime.status();
  // Compute health/ready from the runtime (NO secrets, NO credentials).
  const report = {
    mcp: st.localMcp.url,
    localMcp: st.localMcp,
    appServer: st.appServer,
    tunnel: st.tunnel,
    workspace: st.workspace,
    readyForChatGPT: st.readyForChatGPT,
  };
  process.stdout.write('V02_RUNTIME ' + JSON.stringify(report) + '\n');
  if (args.status || args.oneshot) {
    await runtime.close();
    process.exit(0);
  }
  process.stdout.write('v0.2 runtime listening; Ctrl+C to stop\n');
  process.on('SIGINT', async () => { await runtime.close(); process.exit(0); });
  process.on('SIGTERM', async () => { await runtime.close(); process.exit(0); });
}

main().catch(async (e) => {
  process.stderr.write('v0.2 runtime error: ' + e.stack + '\n');
  try { await runtime.close(); } catch {}
  process.exit(1);
});
