// chatgpt-codex-orchestrator: narrow allowlisted verify (v0.2 M3).
// The caller supplies only workspaceId + check (a server-owned check name). Command
// + argv are SERVER-CONFIGURED via verifyChecks. No general bash, no shell:true.

import { spawn } from 'node:child_process';
import { WorkspaceError } from './workspace.js';

export const VERIFY_EFFECTS = ['read_only', 'workspace_effect'];
const MAX_STDOUT = 64 * 1024;
const MAX_STDERR = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

export class VerifyService {
  constructor({ workspaceRegistry, mutationOwner, verifyChecks = {} }) {
    this.registry = workspaceRegistry;
    this.owner = mutationOwner;
    this.checks = verifyChecks;
  }

  _requireOwner() { if (!this.owner) throw new WorkspaceError('shared mutation owner is required for verify'); }

  async run({ workspaceId, check }) {
    this._requireOwner();
    const spec = this.checks[check];
    if (!spec) throw new WorkspaceError(`unknown verify check: ${check}`);
    if (!VERIFY_EFFECTS.includes(spec.effect)) throw new WorkspaceError(`invalid verify effect: ${spec.effect}`);
    const ws = this.registry.get(workspaceId);
    const timeoutMs = spec.timeoutMs || DEFAULT_TIMEOUT_MS;

    let acquired = false;
    if (spec.effect === 'workspace_effect') {
      this.owner.acquire('chatgpt', 'verify:' + check);
      acquired = true;
      this.owner.markUnitState('running');
    } else {
      // read_only: default FAIL CLOSED if any other mutating unit is active in M3.
      if (this.owner.owner !== 'none') throw new WorkspaceError('another mutation unit is active; read_only verify fails closed');
    }

    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(spec.command, spec.args || [], { cwd: ws.root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '', outTruncated = false, errTruncated = false, timedOut = false;
        let failed = false;
        const kill = () => { if (!failed) { failed = true; try { child.kill('SIGTERM'); } catch {} } };
        const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
        child.stdout.on('data', (d) => { if (out.length >= MAX_STDOUT) { outTruncated = true; kill(); return; } out += d.toString('utf8').slice(0, MAX_STDOUT - out.length); });
        child.stderr.on('data', (d) => { if (err.length >= MAX_STDERR) { errTruncated = true; return; } err += d.toString('utf8').slice(0, MAX_STDERR - err.length); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ check, effect: spec.effect, exitCode: code, timedOut, stdout: out, stderr: err, truncated: outTruncated || errTruncated, passed: code === 0 }); });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
    } finally {
      if (acquired) {
        // Mark reconciled on known terminal; timeout/unknown termination does NOT
        // silently release for workspace_effect.
        if (this.owner.unitState === 'running') { this.owner.markUnitState('reconciled'); this.owner.release(); }
        else this.owner.markUnitState('unknown');
      }
    }
  }
}
