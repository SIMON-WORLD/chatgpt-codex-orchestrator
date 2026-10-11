# #222 — desktop-primary Relay migration: staged handoff (NO CUTOVER)

This document is a bounded implementation artifact, not permission to change host state. It complements the authoritative [Issue #222](https://github.com/SIMON-WORLD/chatgpt-codex-orchestrator/issues/222) and keeps #212's accepted launcher/finite-readiness/phase-journal implementation unchanged.

## Observed nonsecret topology (October 11, 2026)

| | Computer1, original Relay host | Computer2, proposed host |
|---|---|---|
| Windows | `DESKTOP-29JHFM4` | `DESKTOP-KPU6GP4` |
| Relay data root | `E:\Project\chatgpt-codex-orchestrator\issue-185-runtime` | **new disjoint root required**, not Device B's root |
| Ports | Relay :18745–47; tunnel :18748 currently absent; Device A :18749 absent | Device B :18749 Ready; :18745–48 reserved for staged host |
| SQLite | `relay.sqlite` 225280 bytes, live `-wal` 4128272 bytes, `-shm` 32768 bytes | no Relay DB installed |
| Tunnel | existing profile `issue-185-relay` at runtime `tunnel-profiles`; profile hash `303370e08438977baa25f0cd9e16c8cc4c75fddd5297de40f56c94d3b80cfaa3` | client executable missing on known PATH; do not assume install location |
| Node | existing laptop-specific path `D:\Software\nvm\nodejs\node.exe` | `C:\Program Files\nodejs\node.exe` |
| Ingress | `https://desktop-1.tail4d2a66.ts.net` → 18747 | Tailscale running; no Serve configuration established |
| Task | existing #212 task, Relay host branch, reboot recovery failed | same-name #212 task already runs Device B stable-runtime; do not replace blindly |

Current Device B config: `E:\Project\chatgpt-codex-orchestrator\issue-185-runtime-device-b\device-b-config.json`; SHA256 `92c90b32b58b1d6b73cddf094b228fa9771a34d52ed47e59e57a48ddf79c2b18`. Device ID `039923d2-be2d-4345-bfd8-fdf385abf715`; `filesystemScope=os_user_scope`, port 18749, dataRoot `...\issue-185-runtime-device-b\data`; do **not** change ID, config, trust boundary or credentialEnv `ISSUE185_DEVICE_B_SECRET` without Parent review. The existing Device B Relay URL still targets Computer1; reconnection to new ingress is a separately authorized configuration/network change.

Presence-only User refs on B: `CONTROL_PLANE_API_KEY`, `ISSUE185_DEVICE_B_SECRET` present; `ISSUE185_RELAY_AUTHORIZATION`, `LOCAL_RELAY_DEVICE_SECRET` absent. No secret contents inspected. Laptop Relay runner hash `ff64a79bc20bb7104a2536e5c205451f96b219d0b08e197211a720dfcb9e84e1`; source relay repo at `5c36a7aaebe0f51e012f8a27ab160c2bf9eebde9`, recovery checkout at `f87f4665fa225e904f4edf0408181f52074e267e`, both observed clean.

## Startup coexistence design — Parent approval required

**Single project-owned AtLogOn entrypoint**, not two competing identical task names. The current Device B task is the protected starting point. The proposed replacement *after explicit Task approval* is a reviewed/hash-fenced durable thin coordinator that invokes the existing #212 relay-host bootstrap **for Relay/Tunnel only** and separately invokes the existing Device B `stable-runtime-recover.mjs` with unchanged config/repo/exact serving SHA, then verifies via existing `private-relay-doctor.mjs` against B. The laptop-specific #212 bootstrap is **not** portable verbatim because its source-path/revision/Device-A/Node assumptions are hard-coded; a future desktop-specific reviewed bootstrap must preserve #212's finite readiness and sanitized phase checkpoint. Do not invoke the old host bootstrap if it would recover Device A on port 18749: it collides with B.

Retain Task semantics: exact user SID/principal, AtLogOn, `InteractiveToken`, `LeastPrivilege`, one action, `IgnoreNew`, network prerequisite, bounded retries, exact action hash and project ownership marker. Replacing the existing B task is **not** presently authorized. Explicitly preserve rollback task XML (secret-free; review SID/action arguments), hash-verified durable bootstrap backup and original B config, without emitting secrets.

## Separately gated migration sequence

1. **Read-only inventory**: verify desktop SID, existing Task XML/fingerprint, B config and exact serving SHA, parent of B runtime data, nonsecret relay storage schema/DB metadata, free space, ports/listener owners, exact tunnel binary and profile hash, and Tailscale Serve configuration. `planDesktopRelayMigration` rejects unknown/colliding bindings; snapshots must be sourced from actual machine probes (not guessed booleans).
2. **Stage files, not services**: create a new disjoint desktop Relay root and dedicated pinned checkout only after exact artifact/ownership review. Run offline package tests and dry-run/bootstrap `-Plan` with no Task install. Review all credential **reference names** and file ACLs; never write raw secret values to script/Task/PR/log.
3. **Consistent DB and single-writer**: capture safe rollback snapshot first, then at explicitly approved source quiescence use SQLite online backup API or validated checkpoint + consistent backup of the *whole live state*. Never copy just `relay.sqlite` while WAL active; validate account and device identity/integrity and provenance before enabling B Relay. Keep only one active Relay writer and one Secure MCP Tunnel client consuming the shared queue.
4. **Approved transfer**: only Parent/Human-approved narrow change may stop/isolate source Relay/Tunnel, transfer DB and secure tunnel profile/credential references through an approved secure channel, configure desktop Tailscale Serve ingress, update A/B exact-agent targets, and install the reviewed combined Task. Do not re-pair, re-key, widen OS scope, silently transfer secrets, or change connector identity.
5. **Canary acceptance**: host Relay :18745–47 and tunnel :18748 exact owner/readiness; existing ChatGPT Relay connector lists exact B Ready; explicit workspace_open + harmless B process exit 0 even with laptop off; exact A reconnect/sentinel when online; cold logon restores both host and B. Passive doctor is not a substitute for dispatch.
6. **Rollback**: fence desktop writer/tunnel first; verify source backup/original DB + WAL consistency and no writes lost before resuming **only** old laptop Relay/tunnel; restore old ingress mapping and exact A/B agent URLs, B's task XML/config, and verify account/device identities. Do not independently restart both writers.

## Material Parent gates at implementation checkpoint

- Credential references absent on destination; approved secure provisioning route is **not established**.
- Secure Tunnel client location/approved binary, existing account-facing tunnel profile portability/queue ownership and Tailscale Serve cutover require independent proof.
- Consistent source live SQLite snapshot/quiescence and validated rollback require an availability-affecting authorization.
- Existing Device B Task mutation, network ingress cutover, and agent Relay URL changes require exact task/SID/action/hash disclosure and narrow Parent/Human approval.

**No live Relay, DB, Task, Secure Tunnel, Tailscale Serve, credential, device identity, or agent config was mutated by this repository PR.** This PR provides a read-only deterministic migration gate and staged Parent handoff; it is not the mandatory powered-off laptop acceptance.
