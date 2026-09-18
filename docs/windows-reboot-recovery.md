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

When the Human Principal has already chosen one exact disposable directory for the shared Local read-only smoke fixture, use the **standalone first-bootstrap artifact** as the one trusted host action.

The bootstrap may be executed from outside a stale canonical checkout. For this fixture-install mode, `--config` is optional on the Windows dogfood host: when omitted, the bootstrap binds only to the single exact listener on the configured stable port (default 8745), reads that serving process's explicit `--config` argument, and verifies that config before any mutation. It does **not** scan the filesystem for config files.

Conceptual invocation:

```powershell
node <standalone-stable-runtime-first-bootstrap.mjs> --sha <exact-40-hex-commit> --repo <trusted-canonical-repo> --read-only-smoke-fixture <exact-human-approved-directory>
```

The bootstrap then materializes the exact target checkout and enters that revision's bounded recovery/fixture installer. The installer:

- requires the fixture path to be supplied explicitly; it never scans, enumerates, infers, ranks, or substitutes directories;
- requires the path to already exist and resolve to a directory;
- if existing `workspaceRoot/workspaceRoots` already contain it, leaves those roots unchanged;
- otherwise adds only that exact canonical directory to `workspaceRoots`, never its parent;
- initializes that exact directory as the deterministic shared smoke payload before changing runtime config:
  - minimal Git repository;
  - `smoke.txt` with marker `READ_ONLY_SMOKE_V1`;
  - intent-to-add state so normal worktree `git diff` is non-empty without creating a commit or requiring Git identity;
  - unknown pre-existing top-level content or sentinel mismatch fails closed rather than being overwritten;
- sets `diagnostics.localReadOnlyFixture` to that same exact canonical directory;
- exposes a bounded fixture contract from `workspace_open({ fixture: "read_only_smoke" })` containing the exact relative read target, search marker, and git-diff mode;
- preserves unrelated Stable Runtime config values;
- atomically replaces the config;
- proves the exact currently serving revision/PID, stops only that exact PID, and cold-starts the exact accepted target revision under the updated profile;
- on failure restores the original config and recovers the previously proven serving revision where safe proof remains available;
- does not authorize any downstream project's real workspace and does not create a generic config/root/process management API.

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
4. Preserve the externally managed Secure Tunnel lifecycle. Recovery does **not** require a tunnel-client executable/profile, does not run `tunnel-client doctor`, and never launches/stops/reconfigures tunnel-client when `tunnel.external=true`.
5. Inspect the already-configured `tunnel.healthUrl`.
   - Ready: record the external tunnel as reused.
   - Unreachable or not ready: fail closed with `tunnel_readiness`; tunnel lifecycle recovery belongs to its external owner.
6. PASS only after Local `/healthz` and `/readyz` both prove the exact target revision and the configured external tunnel readiness endpoint is ready.

The Stable Runtime uses `tunnel.external=true`; both runtime activation and deterministic recovery therefore own only the orchestrator process. Secure Tunnel lifecycle remains external.

## Credentials and logs

The recovery CLI has **no raw credential argument** and no tunnel credential/profile handling in external mode. Do not paste API keys into the recovery command, repository files, task metadata, or PowerShell history. Recovery emits only structured, bounded evidence and redacts sensitive assignment-shaped values from failure causes.

## Failure phases

`STABLE_RUNTIME_RECOVERY` emits one structured PASS or FAIL payload. Common fail-closed phases include:

- `profile_binding` / `target_binding` — config, trusted repo, exact target, or durable target state is invalid;
- `runtime_conflict` — the configured endpoint has a wrong/unproven/ambiguous listener;
- `runtime_start` / `runtime_readiness` — the exact runtime could not start or prove readiness;
- `tunnel_readiness` — the externally managed Secure Tunnel readiness endpoint is not ready; recovery does not take over its lifecycle;
- `joint_readiness` — one side lost exact readiness before the final proof.

If recovery itself cold-started a runtime and later fails, cleanup is limited to that exact runtime PID. Recovery never owns, launches, or stops the external Secure Tunnel and never uses name-based/global process termination.

## Troubleshooting boundary

A failure should be diagnosed from the phase and the existing Stable Runtime/tunnel configuration. Do not repair a failure by guessing another checkout, silently pulling/resetting a repo, editing durable Governance JSON, copying raw credentials into commands, or broad-killing `node`, `codex`, or tunnel processes.

The historical two-command/manual reconstruction path remains a troubleshooting fallback only. The normal operating path is this single fixed entrypoint.

## Optional Windows auto-start

A Task Scheduler or Startup-folder login trigger may later invoke **this exact same recovery command** as a thin launcher. It must not contain independent SHA selection, recovery logic, secret values, or generic process management. Windows Service installation is not required for this scope.

Installing/removing any OS startup trigger and performing a real reboot/logon dogfood are separate Human Principal action boundaries; Issue #75 does not perform them.
