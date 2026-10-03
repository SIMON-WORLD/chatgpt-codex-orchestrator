# Windows login autostart for the existing Local Connector stack

Issue #212 adds one narrow Windows Task Scheduler installation surface around the already-accepted recovery/bootstrap ownership. It does **not** add a service manager, generic scheduler API, process supervisor, pairing flow, credential store, topology manager, or new recovery authority.

The fixed task name is:

```text
ChatGPT Codex Orchestrator - Local Connector Login Recovery
```

The task is always:

- scoped to the current Windows user SID;
- triggered by `AtLogOn` for that same user;
- `InteractiveToken` + `LeastPrivilege` (never `LocalSystem` and never highest privilege);
- `IgnoreNew` for overlapping task instances;
- network-gated with `StartWhenAvailable`;
- bounded to five Task Scheduler retries at one-minute intervals when the launcher exits non-zero;
- one exact `Exec` action only;
- secret-free in task arguments/XML/description.

Task creation/update is ownership-fenced. A same-name task without the Issue #212 marker is never overwritten or removed. Status output hashes action arguments instead of echoing them. A project-owned task that contains sensitive-looking metadata is treated as untrusted and fails closed.

## Existing lifecycle ownership remains authoritative

Issue #212 does not absorb any accepted lifecycle owner:

- **Stable Runtime** — `host/stable-runtime-recover.mjs` remains the repository recovery authority. It keeps exact repo/config/profile binding, exact target semantics, single-listener safety, and fail-closed drift handling for both accepted profile families: the #75 external-tunnel profile and the #185 device-local Relay-agent profile.
- **Relay Agent** — remains a child of the normal Stable Runtime when `relayAgent.enabled=true`; no separate Relay-agent task/supervisor is added.
- **Secure MCP Tunnel** — remains externally managed where the Stable Runtime config actually declares the #75 external-tunnel profile. The #185 device-local Relay-agent config has no external-tunnel lifecycle to validate or manage.
- **Relay runner / agent ingress** — remain under the already accepted host-side bootstrap/lifecycle owner. The Task Scheduler installer does not recreate their startup logic.

The new repository launcher performs only fail-closed binding/hash validation immediately before delegation. It does not select a new revision, pair a device, change ports/profile/topology, restart by process name, or supervise child processes.

## Device-local Stable Runtime task

For the #75 external-tunnel shape, a paired device whose existing Stable Runtime config has exactly one trusted repo continues to use the original contract:

```powershell
npm run autostart:windows -- plan --kind stable-runtime --config C:\absolute\stable-runtime.json
npm run autostart:windows -- install --kind stable-runtime --config C:\absolute\stable-runtime.json
```

If `worktree.trustedRepos` has more than one entry, provide the exact trusted canonical repo:

```powershell
npm run autostart:windows -- install --kind stable-runtime --config C:\absolute\stable-runtime.json --repo E:\absolute\chatgpt-codex-orchestrator
```

For the #75 shape, validation still requires the exact external-tunnel binding and trusted repo. For the accepted #185 device-local Relay-agent shape, `tunnel.external` and `worktree.trustedRepos` are intentionally absent; plan/install instead requires an explicit canonical `--repo` plus an exact `--sha <40-hex>` target. The no-`trustedRepos` path fails closed unless that repo is the same canonical repo from which the launcher runs and its package identity is exactly `SIMON-WORLD/chatgpt-codex-orchestrator`.

At plan/install time the launcher hashes the critical non-secret binding: profile family, loopback host/port, data root, Governance namespace, filesystem scope, workspace roots, Relay URL, exact `deviceId`, credential-environment variable name, applicable tunnel fields, and canonical repo path. The task stores that SHA-256; each login recomputes it before recovery, so deviceId, credential-env, filesystem/workspace/data-root, port, tunnel, or repo drift fails closed.

A #185-style plan is therefore explicit and revision-pinned:

```powershell
npm run autostart:windows -- plan --kind stable-runtime `
  --config E:\absolute\device-b-config.json `
  --repo E:\absolute\chatgpt-codex-orchestrator `
  --sha <exact-40-hex-accepted-revision>
```

The task invokes only this bounded wrapper:

```text
node <trusted-repo>\scripts\windows-login-autostart.mjs launch-stable-runtime --config <existing-config> --repo <trusted-repo> --binding-sha256 <critical-binding-sha256> [--sha <exact-40-hex>]
```

The wrapper then delegates directly to:

```text
node <trusted-repo>\host\stable-runtime-recover.mjs --config <existing-config> --repo <trusted-repo> [--sha <exact-40-hex>]
```

Recovery starts/reuses the Stable Runtime; the existing Stable Runtime starts the Relay Agent. The #75 branch retains external-tunnel readiness checks. The #185 branch uses the same exact-revision prepare/start/reuse and single-listener fencing but does not require or probe an irrelevant external tunnel. No pairing, deviceId, filesystem scope, port, profile, topology, or repository binding is rewritten.
## Relay-host task

The accepted Relay host has additional lifecycle owners that are intentionally outside `stable-runtime-recover.mjs`: the Relay runner, externally managed Secure MCP Tunnel, and existing agent ingress. Issue #212 therefore does **not** synthesize a repository supervisor for them.

Instead, `relay-host` mode schedules one already-reviewed host bootstrap PowerShell entrypoint and pins its exact bytes by SHA-256:

```powershell
npm run autostart:windows -- plan --kind relay-host `
  --bootstrap C:\absolute\existing-private-relay-recover.ps1 `
  --bootstrap-sha256 <exact-64-hex-sha256>

npm run autostart:windows -- install --kind relay-host `
  --bootstrap C:\absolute\existing-private-relay-recover.ps1 `
  --bootstrap-sha256 <exact-64-hex-sha256>
```

The task action calls the repository launcher with only the bootstrap path and reviewed hash. At every login invocation, the launcher re-reads the bootstrap and refuses to run it unless:

- it is one exact `.ps1` file;
- its bytes still match the reviewed SHA-256;
- it contains no raw bearer/token/credential/secret value;
- it delegates Stable Runtime recovery to `stable-runtime-recover.mjs` / `recover:private-relay`;
- it delegates final composed readiness diagnosis to `private-relay-doctor.mjs` / `doctor:private-relay`.

The reviewed bootstrap remains responsible for invoking the already accepted Relay-runner, Secure-MCP-Tunnel, and agent-ingress owner entrypoints in their established order. Issue #212 does not invent replacements for those host-local artifacts and does not copy their secrets into Task Scheduler metadata.

Existing user-scope environment/profile references remain external inputs inherited by the interactive user session. This includes the accepted `MCP_EXTRA_HEADERS` / `MCP_DISCOVERY_EXTRA_HEADERS` contract where applicable; those values are never serialized into task XML or arguments.

### Current machine-specific assumptions for G05 review

Durable #185/#209 evidence describes the current Relay-host topology as:

```text
Relay MCP             127.0.0.1:18745
Relay internal API    127.0.0.1:18746
agent-only ingress    127.0.0.1:18747
Secure MCP Tunnel     readiness on 127.0.0.1:18748, profile issue-185-relay
A2 Stable Runtime     127.0.0.1:18749
agent ingress         existing tailnet-only Tailscale Serve binding
```

The second paired Windows device owns its device-local Stable Runtime on `127.0.0.1:18749`; it does not own the Relay-host 18745-18748 listeners.

The 2026-10-03 #212 read-only host reacquisition found the Relay/Tunnel/Stable Runtime listeners live but found **no `.ps1` file anywhere under the project-owned `E:\\Project` tree**. Therefore no existing reviewed Relay-host bootstrap path/hash is currently established. The smallest compatible follow-up is one fixed host-local PowerShell bootstrap, reviewed by exact SHA-256, that only composes the already accepted Relay runner / Secure Tunnel startup with `recover:private-relay` and `doctor:private-relay`; it must not become a generic supervisor or scheduler. No such host bootstrap is fabricated by this repository correction.

These values are **not** configured by the installer. Before any persistent Relay-host installation, G05 Parent must reacquire the actual host bootstrap path/hash and review that exact bootstrap against the still-current topology. A stale or mismatched bootstrap hash fails closed.
## Status and bounded removal

Read-only status:

```powershell
npm run autostart:windows -- status
```

Status does not emit raw task action arguments. It reports only the fixed task identity, bounded settings, action executable basename, and argument SHA-256.

Exact project-owned task removal:

```powershell
npm run autostart:windows -- uninstall
```

Removal is idempotent when absent and refuses a same-name foreign/unowned task. There is no generic task enumeration or scheduler-manager API.

## Secret boundary

Do not pass or embed raw bearer tokens, authorization/header values, device credentials, API keys, cookies, passwords, or tunnel/runtime secrets in Task Scheduler arguments, XML, bootstrap source, repository files, or copied shell history.

The existing accepted secret architecture remains authoritative:

- Relay Agent uses `relayAgent.credentialEnv`; the raw device credential never belongs in runtime config.
- Secure MCP Tunnel continues to use its existing user-scope profile/credential references.
- Existing MCP authorization-header environment variables remain inherited user environment, not Scheduled Task metadata.

The Relay-host bootstrap validator permits references such as `$env:NAME` / `GetEnvironmentVariable(...)` but rejects embedded sensitive values.

## Persistent-host boundary

Repository implementation/tests/documentation can be prepared and reviewed without changing either personal Windows host.

Actual `install` / `uninstall`, any Task Scheduler/Startup persistence mutation, and real logoff/login or reboot remain separate G05 Parent actions after candidate review. Before that action, G05 must state the exact target machine, fixed task name, `AtLogOn` trigger, interactive user identity, executable/arguments, credential-reference behavior, and rollback/removal command as required by Issue #212.

No part of this repository candidate changes #208, pairing, deviceId, filesystem scope, ports/profile/topology, public hosting, OAuth, default, release, or project DONE.
