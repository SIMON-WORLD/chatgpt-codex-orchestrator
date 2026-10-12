# #222 — migrate the single Local Connector Relay host to Computer2

Issue #222 keeps the existing account-facing **Local Connector Relay** and the existing paired device identities. It changes only which Windows machine hosts the one Relay writer and the one Secure MCP Tunnel client.

Current desired topology:

```text
ChatGPT
  -> existing account-facing Local Connector Relay connector
  -> Secure MCP Tunnel hosted on Computer2
  -> one Relay writer on Computer2 :18745-18747
       -> Device B local Stable Runtime on Computer2 :18749
       -> Device A reconnects from Computer1 when the laptop is online
```

Computer1 may be powered off after migration; Computer2 is the usually-on host. This issue does **not** add cloud hosting, HA, automatic failover, a scheduler, a second Relay account, re-pairing, or a new connector.

## Current verified topology

| | Computer1 / source | Computer2 / destination |
|---|---|---|
| Windows host | `DESKTOP-29JHFM4` | `DESKTOP-KPU6GP4` |
| Current role | live Relay/Tunnel host after #212 recovery; Device A2 Ready | Device B Ready |
| Relay/Tunnel ports | :18745-:18748 | currently free |
| Device runtime | A2 :18749 | B :18749 |
| Device B identity | n/a | `039923d2-be2d-4345-bfd8-fdf385abf715` |
| Device B config | n/a | `E:\Project\chatgpt-codex-orchestrator\issue-185-runtime-device-b\device-b-config.json` |
| Existing login Task | #212 Relay-host recovery Task | #212 Device B Stable Runtime Task |
| Tailscale agent ingress | current `desktop-1` tailnet-only Serve -> :18747 | destination Serve not yet configured |

The Device B config hash observed before implementation was
`92c90b32b58b1d6b73cddf094b228fa9771a34d52ed47e59e57a48ddf79c2b18`.
Its deviceId, `ISSUE185_DEVICE_B_SECRET` credential reference, filesystem scope, data root, workspace roots and :18749 listener remain protected bindings.

The source incident originally had the Secure Tunnel stopped. The implementation therefore accepts two independently verified source states:

- `running` only when the exact source tunnel owner/profile is verified;
- `verified-stopped` only when there is affirmative evidence that no other client is consuming the same tunnel queue.

Unknown, foreign, ambiguous or duplicate queue ownership fails closed. The source Tunnel does **not** need to be restarted merely to satisfy a migration preflight.

## Destination runtime layout

The desktop Relay has a new root that is disjoint from Device B:

```text
E:\Project\chatgpt-codex-orchestrator\issue-222-relay-runtime\
  relay-runner.mjs
  relay.sqlite
  bin\tunnel-client.exe
  tunnel-profiles\issue-185-relay.yaml
  windows-login\desktop-relay-host-bootstrap.ps1
  windows-login\last-result.json
```

Reviewed artifact identities:

- Relay runner SHA-256:
  `ff64a79bc20bb7104a2536e5c205451f96b219d0b08e197211a720dfcb9e84e1`
- Secure MCP Tunnel v0.0.14 executable SHA-256:
  `fcc85a69ec0ad82518e4f8964f60c45e31787957782a0fc9c1b0c44e82d61b9b`
- `issue-185-relay.yaml` SHA-256:
  `303370e08438977baa25f0cd9e16c8cc4c75fddd5297de40f56c94d3b80cfaa3`
- Relay source checkout:
  `E:\Project\chatgpt-codex-orchestrator\chatgpt-codex-orchestrator-issue-185`
  pinned at `5c36a7aaebe0f51e012f8a27ab160c2bf9eebde9`
- Computer2 Node:
  `C:\Program Files\nodejs\node.exe`

The desktop bootstrap requires an already staged, consistent `relay.sqlite`. It never creates the migration database as an empty fallback.

## Task coexistence: preserve Device B

The existing Computer2 Task remains untouched:

```text
ChatGPT Codex Orchestrator - Local Connector Login Recovery
```

It continues to own Device B Stable Runtime :18749.

Issue #222 adds one **different**, project-owned Task:

```text
ChatGPT Codex Orchestrator - Desktop Relay Host
```

Its fixed contract is:

- current exact Windows user SID;
- `AtLogOn`;
- `InteractiveToken`;
- `LeastPrivilege`;
- `IgnoreNew`;
- network required / StartWhenAvailable;
- five one-minute bounded Task Scheduler retries;
- one PowerShell action only;
- exact reviewed bootstrap SHA-256 checked immediately before execution;
- no raw credential/header/token values in Task XML, action arguments, description, logs or repository files.

A same-name Task without marker
`chatgpt-codex-orchestrator#222/desktop-relay-host/v1`
is foreign and is never overwritten or removed.

Repository CLI:

```powershell
npm run autostart:desktop-relay-host -- plan --bootstrap <reviewed.ps1> --bootstrap-sha256 <64-hex>
npm run autostart:desktop-relay-host -- install --bootstrap <reviewed.ps1> --bootstrap-sha256 <64-hex>
npm run autostart:desktop-relay-host -- status
npm run autostart:desktop-relay-host -- uninstall
```

`plan` is read-only. `install` and `uninstall` are persistent host mutations and require the separate Parent/Human authorization described below.

## Desktop bootstrap scope

`scripts/windows-desktop-relay-host-bootstrap.ps1` owns only:

- Relay MCP :18745;
- Relay internal API :18746;
- agent ingress :18747;
- Secure MCP Tunnel readiness :18748.

It **does not** recover Device A or Device B and does not own :18749. It does not install Tasks, change Tailscale Serve, edit agent configs or copy credentials.

Before starting anything it fail-closes on:

- wrong runner/tunnel/profile hash;
- wrong Relay source checkout revision or tracked-file drift;
- missing staged `relay.sqlite`;
- foreign/partial/ambiguous listener ownership;
- missing User-scope credential references;
- wrong process path/command/profile.

`-Plan` checks only the **presence** of the required User-scope references and exits before reading their values. Non-plan execution reads approved existing references only into process memory:

- `ISSUE185_RELAY_AUTHORIZATION`;
- `LOCAL_RELAY_DEVICE_SECRET`;
- `CONTROL_PLANE_API_KEY`.

Its journal contains only fixed status/phase/time fields. It does not persist exception text, environment values, headers or command lines.

## Preflight is not authority

`planDesktopRelayMigration(snapshot)` is a read-only evidence gate. Even if every staging fact is true, its best result is:

```text
STAGING_PREFLIGHT_READY
cutoverAuthorization = EXTERNAL_PARENT_HUMAN_ONLY
cutoverAuthorized = false
```

No snapshot boolean such as `parentCutoverApproved: true` can grant host-change authority.

## Controlled migration sequence

1. **Repository candidate** — exact-head tests and Node 22/24 CI must pass. No host changes occur in this step.
2. **Read-only reacquisition** — re-check both exact devices, source Relay/Tunnel ownership, Device B Task/config/identity, destination ports, SID, disk space, source SQLite WAL state, Tailscale Serve, User-reference presence and artifact hashes.
3. **Non-secret staging** — after Parent disclosure, stage the exact runner, tunnel binary/profile and reviewed bootstrap under the new disjoint Computer2 root. Do not start them and do not install the Task.
4. **Narrow cutover authorization** — before any availability/security mutation, disclose the exact Computer2 Task name, SID, trigger, executable/action hash, credential reference names, new Serve mapping, A/B config changes, source stop/quiescence operation and rollback.
5. **Single-writer SQLite transition** — with explicit authorization, fence the source writer, capture a consistent SQLite backup/checkpoint including live WAL state, validate integrity/provenance, transfer to the destination, and keep the source rollback copy. Never copy only the live `relay.sqlite` while WAL is active.
6. **Credential/profile/network handoff** — securely provision the existing reference values/profile without printing them, configure the Computer2 tailnet-only Serve ingress, and update A/B Relay-agent URLs while preserving device IDs, credentialEnv names and filesystem scopes.
7. **Start destination** — prove source Relay/Tunnel are fenced, then run the reviewed Computer2 bootstrap. There must be only one active Relay writer and one tunnel queue client.
8. **Install the distinct Task** — only after the running destination has passed canaries; the existing Device B Task remains unchanged.
9. **Acceptance** — the existing ChatGPT connector must list exact B Ready, open a B workspace and execute a harmless B process with exit 0. Then, with separately approved real laptop shutdown, B must remain usable while Computer1 is off. When Computer1 returns, A must reconnect with its original identity.
10. **Cold-login proof** — a real Computer2 Windows login must restore the Relay/Tunnel host and Device B using the two non-conflicting Tasks.

## Rollback

Rollback always fences the Computer2 Relay writer and Tunnel client **first**. Then validate the retained source database/rollback snapshot before resuming the old Computer1 writer/tunnel. Restore the prior tailnet Serve mapping and exact A/B Relay URLs, remove only the project-owned
`ChatGPT Codex Orchestrator - Desktop Relay Host` Task if required, and re-run exact account/device canaries.

Never run both Relay writers or both tunnel clients as a rollback shortcut.

## Current boundary

The Local Connector Relay is presently usable again through Computer1, and both paired devices have been observed Ready. That restored daily use is not #222 acceptance: powering off Computer1 would still remove the shared Relay/Tunnel path.

This repository PR may implement/test the staging and Task/bootstrap machinery. It must not itself stop/start live Relay/Tunnel, transfer the SQLite database or credentials, mutate Task Scheduler, Tailscale Serve or A/B configs, or reboot/power off either personal machine.
