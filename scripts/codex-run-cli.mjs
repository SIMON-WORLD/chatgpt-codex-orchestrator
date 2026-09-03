// chatgpt-codex-orchestrator: standalone CodexExecutor CLI runner.
// This runs in a NORMAL node process (via exec_command), so the codex subprocess
// can initialize. It persists the codex thread id in a session file so consecutive
// calls resume the SAME thread. Usage:
//   node scripts/codex-run-cli.mjs --repo <dir> --session-file <file> --prompt-file <file>
//     [--sandbox <mode>] [--ignore-rules] [--bypass]
import fs from 'node:fs';
import { CodexExecutor } from '../src/legacy/codex-executor.js';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function has(name) { return process.argv.includes(name); }

const repoDir = arg('--repo');
const sessionFile = arg('--session-file');
const promptFile = arg('--prompt-file');
if (!repoDir || !sessionFile || !promptFile) {
  console.error(JSON.stringify({ error: 'missing --repo / --session-file / --prompt-file' }));
  process.exit(2);
}

let stored = {};
try { stored = JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch (e) { /* none yet */ }

const ex = new CodexExecutor({
  repoDir,
  sandbox: arg('--sandbox') || 'workspace-write',
  ignoreRules: has('--ignore-rules'),
  bypassSandbox: has('--bypass'),
});
if (stored.sessionId) ex.sessionId = stored.sessionId;

const prompt = fs.readFileSync(promptFile, 'utf8');
const res = await ex.execute(prompt);

fs.writeFileSync(sessionFile, JSON.stringify({ sessionId: res.sessionId }, null, 2), 'utf8');

console.log(JSON.stringify({ sessionId: res.sessionId, resultText: res.resultText, success: res.success, error: res.error }));