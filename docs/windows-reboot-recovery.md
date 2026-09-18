# Windows Stable Runtime reboot/login recovery

This document is the operator contract for the bounded Stable Runtime recovery entrypoint added by Issue #75. It closes the deterministic **manual recovery** P1 only; it is not a Windows service manager, scheduler, credential manager, runtime registry, or new Governance authority plane.

## One fixed recovery command

After Windows reboot/login, use the existing Stable Runtime config and its canonical trusted repository binding:

```powershell
npm run recover:v0.2 -- --config <stable-v0.2-config.json>
```

If there is no validated same-profile/same-config exact last-active revision, supply the Parent/operator-approved exact 40-hex commit explicitly:

```powershell
npm run recover:v0.2 -- --config <stable-v0.2-config.json> --sha <exact-40-hex-commit>
```

Use `--repo <trusted-canonical-repo>` only when the Stable Runtime config declares more than one trusted repository. The selected path must resolve to an existing member of `worktree.trustedRepos`; recovery never broad-discovers a checkout and never treats `brain-command` config as repository authority.

## One-time shared read-only smoke fixture install

When the Human Principal has already chosen one exact disposable directory for the shared Local read-only smoke fixture, the same bounded recovery entrypoint can install that path and activate an exact accepted runtime revision in one host action:

```powershell
npm run recover:v0.2 -- --config <stable-v0.2-config.json> --sha <exact-40-hex-commit> --read-only-smoke-fixture <exact-human-approved-directory>
```

This mode is intentionally narrow:

- the fixture path must be supplied explicitly; the host does not scan, enumerate, infer, rank, or substitute directories;
- the path must already exist and resolve to a directory;
- if existing `workspaceRoot/workspaceRoots` already contain it, those roots are left unchanged;
- otherwise only that exact canonical directory is added to `workspaceRoots`; its parent is not authorized;
- `diagnostics.localReadOnlyFixture` is set to that same exact canonical directory;
- unrelated Stable Runtime config values are preserved;
- config replacement is atomic and the original config is kept only in memory for rollback;
- activation uses the existing exact-revision recovery path;
- if activation fails after the config change, the original config is restored and the previously proven serving revision is recovered under that original profile where safe proof is available;
- this operation does not authorize any downstream project's real workspace and does not create a generic config/root management API.

Do not publish private machine paths in GitHub checkpoints. Durable evidence should record only that the Human-approved exact path was used and whether containment/activation/smoke verification passed.

## Deterministic target semantics

Recovery accepts only:

- an explicit exact 40-hex commit reachable from `origin/main`; or
- when `--sha` is omitted, an exact revision from `stable-runtime-active.json` that still validates against the same Stable Runtime config/profile fingerprint and exact prepared checkout.

It never selects `latest`, the current branch head, the newest directory, or a most-recent runtime heuristically. If the durable exact target cannot be validated, recovery stops and asks for an explicit SHA.

## Recovery state machine

The entrypoint preserves the existing Stable Runtime and Secure Tunnel ownership boundaries:

1. Load the existing Stable Runtime config and assert the bounded loopback/fixed-port/external-tunnel profile.
2. Resolve the canonical trusted repo by realpath and validate the exact target revision.
3. Inspect the configured Local MCP endpoint.
   - No listener: prepare the exact clean detached checkout, run the existing non-authoritative activation preflight, and cold-start that exact runtime.
   - One healthy runtime proving the exact target revision: reuse it.
   - Wrong/unknown revision, an unproven listener, or listener ambiguity: fail closed. Recovery does not kill an unknown process.
4. Run the configured `tunnel-client doctor ... --json` against the exact configured profile. The doctor must pass and must prove the profile reaches the exact configured `tunnel.localMcpUrl` before recovery can launch or reuse the tunnel.
5. Inspect `tunnel.healthUrl`.
   - Ready: reuse the external tunnel.
   - Unreachable: launch only the configured tunnel executable/profile with `shell:false`.
   - Reachable but not ready: fail closed rather than starting a duplicate tunnel.
6. PASS only after Local `/healthz` and `/readyz` both prove the exact target revision and the configured external tunnel `/readyz` is ready.

The Stable Runtime still uses `tunnel.external=true`; the runtime itself does not acquire tunnel lifecycle ownership. The recovery coordinator only ensures the already-configured external tunnel for this bounded recovery attempt.

## Credentials and logs

The recovery CLI has **no raw credential argument**. Tunnel credentials stay in the existing tunnel profile reference, for example `env:CONTROL_PLANE_API_KEY`. Do not paste API keys into the recovery command, repository files, task metadata, or PowerShell history.

`tunnel-client doctor` is used as the supported bounded profile check. Recovery emits only structured, bounded evidence and redacts sensitive assignment-shaped values from failure causes. A missing or rejected credential reference is a non-secret `tunnel_preflight` failure, not a reason to accept or persist a replacement raw secret.

## Failure phases

`STABLE_RUNTIME_RECOVERY` emits one structured PASS or FAIL payload. Common fail-closed phases include:

- `profile_binding` / `target_binding` — config, trusted repo, exact target, or durable target state is invalid;
- `runtime_conflict` — the configured endpoint has a wrong/unproven/ambiguous listener;
- `runtime_start` / `runtime_readiness` — the exact runtime could not start or prove readiness;
- `tunnel_profile_binding` / `tunnel_preflight` — the configured tunnel profile cannot be validated without guessing or the doctor fails;
- `tunnel_conflict` — the configured tunnel health endpoint is reachable but not ready, so duplicate launch is refused;
- `tunnel_start` / `tunnel_readiness` — the exact configured tunnel could not start or become ready;
- `joint_readiness` — one side lost exact readiness before the final proof.

If recovery itself cold-started a runtime and later fails, cleanup is limited to that exact runtime PID. If it launched a tunnel and later fails, cleanup uses only that exact child process handle. Recovery never uses name-based/global process termination.

## Troubleshooting boundary

A failure should be diagnosed from the phase and the existing Stable Runtime/tunnel configuration. Do not repair a failure by guessing another checkout, silently pulling/resetting a repo, editing durable Governance JSON, copying raw credentials into commands, or broad-killing `node`, `codex`, or tunnel processes.

The historical two-command/manual reconstruction path remains a troubleshooting fallback only. The normal operating path is this single fixed entrypoint.

## Optional Windows auto-start

A Task Scheduler or Startup-folder login trigger may later invoke **this exact same recovery command** as a thin launcher. It must not contain independent SHA selection, recovery logic, secret values, or generic process management. Windows Service installation is not required for this scope.

Installing/removing any OS startup trigger and performing a real reboot/logon dogfood are separate Human Principal action boundaries; Issue #75 does not perform them.
