// chatgpt-codex-orchestrator: brain-command WORKER bootstrap (ordinary-node entrypoint).
// Run by the ENVIRONMENT (exec_command), NOT by the node REPL, so the worker is not a
// sandboxed descendant. It derives repoDir/dataRoot from the user config (resolveRepoDir)
// and starts the long-lived worker host, writing the deterministic ready file. Because
// the caller only passes --config and --ready-file (no repo path with spaces), no manual
// Start-Process quoting is needed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadBrainCommandConfig, resolveRepoDir, fastPreflight } from '../src/bootstrap.js';
import { startWorkerHost } from './codex-worker-host.mjs';

function arg(n){ const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i+1] : null; }
const has = (n) => process.argv.includes(n);

async function main() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const configPath = arg('--config');
  const config = configPath
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : loadBrainCommandConfig({ codexHome });

  const r = resolveRepoDir({ cwd: process.cwd(), explicitRepoPath: null, explicitGitHubRepo: null, config });
  if (!r.repoDir) throw new Error('repo not resolvable: ' + r.source);

  // Worker side cannot probe the in-app-browser; that is the IAB launcher's job (it
  // probes the transport next). So the iab-callable check is left DEFERRED here, which
  // is honest and does not block startup.
  const pre = fastPreflight({ config, probes: { cwd: process.cwd(), repoDir: r.repoDir, repoExists: true } });
  if (!pre.pass) {
    const fails = pre.checks.filter((c) => c.status !== 'PASS' && c.status !== 'DEFERRED').map((c) => `${c.check}: ${c.reason}`).join('; ');
    throw new Error('fast preflight failed: ' + fails);
  }

  const dataRoot = arg('--data-root') || config.dataRoot;
  const readyFile = arg('--ready-file') || path.join(dataRoot, 'runtime', 'brain-command.ready.json');

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
