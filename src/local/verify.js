// chatgpt-codex-orchestrator: narrow allowlisted verify (v0.2 M3).
// The caller supplies only workspaceId + check (a server-owned check name). command
// + argv are SERVER-CONFIGURED. No general bash, no shell:true.

import { spawn } from 'node:child_process';
import { WorkspaceError } from './workspace.js';

export const VERIFY_EFFECTS = ['read_only', 'workspace_effect'];
export const VERIFY_TERMINATIONS = ['normal_terminal', 'spawn_failed', 'timeout_or_uncertain'];
const MAX_STDOUT = 64 * 1024;
const MAX_STDERR = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const HARD_MAX_TIMEOUT_MS = 120000;

function validateTimeout(value, def) {
  if (value === undefined || value === null) return def;
  if (!Number.isInteger(value) || value <= 0 || value > HARD_MAX_TIMEOUT_MS) throw new WorkspaceError('verify timeoutMs must be a positive integer <= ' + HARD_MAX_TIMEOUT_MS);
  return value;
}

export class VerifyService {
  constructor({ workspaceRegistry, mutationOwner, verifyChecks = {} }) {
    this.registry = workspaceRegistry;
    this.owner = mutationOwner;
    this.checks = verifyChecks;
    // Validate server-owned specs at construction.
    for (const [name, spec] of Object.entries(verifyChecks)) {
      if (!spec || typeof spec !== 'object') throw new WorkspaceError('bad verify spec: ' + name);
      if (!VERIFY_EFFECTS.includes(spec.effect)) throw new WorkspaceError('invalid verify effect for ' + name);
      validateTimeout(spec.timeoutMs, DEFAULT_TIMEOUT_MS);
    }
  }
  _requireOwner() { if (!this.owner) throw new WorkspaceError('shared mutation owner is required for verify'); }

  async run({ workspaceId, check }) {
    this._requireOwner();
    const spec = this.checks[check];
    if (!spec) throw new WorkspaceError('unknown verify check: ' + check);
    if (!VERIFY_EFFECTS.includes(spec.effect)) throw new WorkspaceError('invalid verify effect: ' + spec.effect);
    const timeoutMs = validateTimeout(spec.timeoutMs, DEFAULT_TIMEOUT_MS);
    const ws = this.registry.get(workspaceId);

    let acquired = false;
    let termination = 'normal_terminal';
    if (spec.effect === 'workspace_effect') {
      this.owner.acquire('chatgpt', 'verify:' + check); // fails closed on conflict BEFORE spawn
      acquired = true;
      this.owner.markUnitState('running');
    } else if (this.owner.owner !== 'none') {
      throw new WorkspaceError('another mutation unit is active; read_only verify fails closed');
    }

    let done = false;
    try {
      return await new Promise((resolve, reject) => {
        let child;
        try { child = spawn(spec.command, spec.args || [], { cwd: ws.root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) { termination = 'spawn_failed'; return resolve({ check, effect: spec.effect, termination, exitCode: null, timedOut: false, stdout: '', stderr: '', truncated: false, passed: false }); }
        let out = '', err = '', outTruncated = false, errTruncated = false, timedOut = false, spawned = false;
        let timer = null;
        const finish = (code, forceTermination) => { if (done) return; done = true; clearTimeout(timer); if (forceTermination) termination = forceTermination; else if (timedOut) termination = 'timeout_or_uncertain'; else termination = 'normal_terminal'; resolve({ check, effect: spec.effect, termination, exitCode: code, timedOut, stdout: out, stderr: err, truncated: outTruncated || errTruncated, passed: code === 0 && !timedOut }); };
        timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch {} }, timeoutMs);
        child.on('spawn', () => { spawned = true; });
        // Output bounding does NOT terminate the process; discard beyond the cap.
        child.stdout.on('data', (d) => { const s = d.toString('utf8'); if (out.length < MAX_STDOUT) { const rem = MAX_STDOUT - out.length; out += s.slice(0, rem); if (s.length > rem) outTruncated = true; } else outTruncated = true; });
        child.stderr.on('data', (d) => { const s = d.toString('utf8'); if (err.length < MAX_STDERR) { const rem = MAX_STDERR - err.length; err += s.slice(0, rem); if (s.length > rem) errTruncated = true; } else errTruncated = true; });
        child.on('close', (code) => finish(code));
        child.on('error', () => { if (!spawned) finish(null, 'spawn_failed'); else finish(null, 'timeout_or_uncertain'); });
      });
    } finally {
      if (acquired) {
        if (termination === 'normal_terminal' || termination === 'spawn_failed') {
          // Known finished / never executed: can safely reconcile + release.
          this.owner.markUnitState('reconciled');
          try { this.owner.release(); } catch {}
        } else {
          // timeout / uncertain: do NOT silently release.
          this.owner.markUnitState('unknown');
        }
      }
    }
  }
}
