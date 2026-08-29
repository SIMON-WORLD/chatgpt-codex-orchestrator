// LEGACY / EXPERIMENTAL RUNTIME: this module is NOT on the canonical Direct Brain Loop\n// path. The default \\-command\ uses the current Codex agent + built-in browser\n// (see src/direct-mode.js). Retained for compatibility/experimental use only.\n// chatgpt-codex-orchestrator: brain-command WORKER bootstrap (ordinary-node entrypoint).
// Run by the ENVIRONMENT (exec_command), NOT by the node REPL, so the worker is not a
// sandboxed descendant. It derives repoDir/dataRoot from the user config (resolveRepoDir)
// and starts the long-lived worker host, writing the deterministic ready file. Because
// the caller only passes --config (no --repo, no --ready-file, no path quoting) the
// canonical ready-file path is derived automatically and always matches the IAB launcher.
import fs from 'node:fs';
import { loadBrainCommandConfig, resolveRepoDir, fastPreflight } from '../src/bootstrap.js';
import { getCodexHome, getCwd } from '../src/runtime-env.js';
import { canonicalReadyFile } from '../src/runtime-paths.js';
import { startWorkerHost } from './codex-worker-host.mjs';

function arg(n){ const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i+1] : null; }
const has = (n) => process.argv.includes(n);

async function main() {
  const configPath = arg('--config');
  const codexHome = arg('--codex-home') || getCodexHome();
  const config = configPath
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : loadBrainCommandConfig({ codexHome });

  const r = resolveRepoDir({ cwd: getCwd(), explicitRepoPath: null, explicitGitHubRepo: null, config });
  if (!r.repoDir) throw new Error('repo not resolvable: ' + r.source);

  // Worker side cannot probe the in-app-browser; that is the IAB launcher's job (it
  // probes the transport next). So the iab-callable check is left DEFERRED here, which
  // is honest and does not block startup. The worker DOES own data-root writability,
  // the Codex executable check, and the runtime dirs.
  const pre = fastPreflight({ config, probes: { cwd: getCwd(), repoDir: r.repoDir, repoExists: true } });
  if (!pre.pass) {
    const fails = pre.checks.filter((c) => c.status !== 'PASS' && c.status !== 'DEFERRED').map((c) => `${c.check}: ${c.reason}`).join('; ');
    throw new Error('fast preflight failed: ' + fails);
  }

  const dataRoot = arg('--data-root') || config.dataRoot;
  const readyFile = arg('--ready-file') || canonicalReadyFile(dataRoot);

  const { info, shutdown } = await startWorkerHost({
    repoDir: r.repoDir,
    dataRoot,
    readyFile,
    port: Number(arg('--port') || '0'),
    bypassSandbox: has('--bypass'),
    session: arg('--session') || null,
  });

  console.log(JSON.stringify({ ...info, repoDir: r.repoDir }));
}

if (typeof process !== 'undefined' && process.argv[1]) {
  const { pathToFileURL } = await import('node:url');
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => { console.error(JSON.stringify({ error: e.message })); process.exit(1); });
  }
}
