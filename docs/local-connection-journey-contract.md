# Local Connection Journey Contract

> Issue #110 design candidate. This document implements the Parent-accepted #109 `UX_ONLY_REPLAN` direction as a product/lifecycle contract only. It does not authorize runtime implementation, provider-default changes, relay/auth/device-service work, deletion of existing Local surfaces, or release/default-flip work.
>
> **Historical-scope note (current through #185):** the body below preserves the #109/#110 design decision at its original baseline. Statements such as “do not create a relay”, “true multi-device out of implementation scope”, and “future Option-2/3” are historical to that bounded design slice and are **not** current project architecture. Subsequent accepted #178/#181/#183 work implemented the paired-device Relay path, and #185 Parent acceptance proved one ChatGPT-facing Local Connector Relay across two real devices. For current routing/status truth use `CAPABILITY_ROUTING.md`, `PROJECT_STATUS.md`, `ROADMAP.md`, and current GitHub implementation/evidence. This note does not rewrite the original #110 decision or imply production/default/release acceptance.

## 1. Scope and baseline

Design baseline:

- orchestrator `main`: `b4c4b127cefa483f0ce81851b104c5f94d62e1bb`
- current `CAPABILITY_ROUTING.md`, `PROJECT_STATUS.md`, and `ROADMAP.md`
- Issues #107, #108, #109, and the authoritative Issue #110 contract
- current Stable Runtime, Secure Tunnel, governed Local MCP / `mcp-plus-web-probe`, exact workspace-root authorization, deterministic Windows recovery, and exact-revision activation/rollback behavior

Selected architecture:

```text
Human Principal / ChatGPT
        |
        v
Local Connection Lifecycle façade
        |
        +--> existing Stable Runtime activation/recovery
        +--> existing Local MCP health/readiness and bounded tools
        +--> existing external Secure Tunnel readiness
        +--> existing ChatGPT custom-app / connector attachment
```

The façade is an aggregation and presentation layer. It is not a new transport, relay, device authority, credential issuer, workspace authority, mutation authority, or Governance plane.

## 2. User model

Normal operation should be understandable as:

```text
install/activate
→ connect
→ ready
→ status/ping
→ reconnect
→ disconnect/revoke
→ select device
→ upgrade
→ rollback
→ diagnose
```

The façade may say “local connection” or “device” for UX clarity, but those terms do **not** create new authority.

A connection is the composition of:

1. one exact Stable Runtime binding;
2. one exact Local MCP endpoint owned by that runtime;
3. the current externally managed Secure Tunnel binding/readiness;
4. the ChatGPT product/app attachment required to reach the remote MCP surface.

A connection is **not** a Parent, task, workspace authorization, repository authorization, or MutationOwner lease.

## 3. Non-negotiable identity and authority invariants

The façade must preserve these invariants unchanged:

- device/runtime identity is not Parent/task/workspace authority;
- no “most recent device”, “most recent workspace”, “latest checkout”, or similar recency guessing;
- Local file access remains limited by exact Human-authorized workspace roots and canonical containment;
- `workspace_open` remains the explicit workspace binding before Local repository operations;
- Repository Identity Fence remains required for repository mutation;
- one authoritative writer / existing MutationOwner semantics remain unchanged;
- reconnect/recovery must reconcile the existing logical execution; it must not silently create a new one;
- connector/tunnel/device credentials do not grant workspace, mutation, Parent, or task authority;
- runtime revision and connection identity are evidence selectors, not mutation authority;
- all durable evidence returned to ChatGPT remains sanitized and pointer-not-payload compatible.

## 4. Existing primitives the façade is allowed to reuse

| User need | Existing accepted primitive | Current semantics |
| --- | --- | --- |
| Activate exact runtime | `scripts/stable-runtime-activate.mjs` → `StableRuntimeActivator.activate({ targetSha, configPath, repoPath })` | Requires exact 40-hex SHA, exact trusted repo/profile, external tunnel readiness, and exact Local revision proof. |
| First bootstrap without scanning | `host/stable-runtime-first-bootstrap.mjs` | On Windows may bind to the single exact serving listener and its explicit `--config`; it does not scan for configs/workspaces. |
| Authorize one exact workspace root | first bootstrap / recovery `--authorized-workspace-root <exact Human-approved directory>` | Adds only the exact canonical root, preserves other config, force-reloads exact accepted runtime, sanitizes returned evidence. |
| Recover after runtime/reboot failure | `host/stable-runtime-recover.mjs` / `npm run recover:v0.2` | Recovers only an explicit exact SHA or validated same-profile exact durable serving state. Wrong/ambiguous state fails closed. |
| Prove Local health | `GET /healthz` | Returns `status`, exact runtime `revision`, and activation-preflight flag. |
| Prove Local readiness | `GET /readyz` | Returns `status`, exact `revision`, loopback status, and whether allowed roots exist. |
| Prove external tunnel readiness | configured `tunnel.healthUrl` | Readiness only. Stable Runtime/recovery do not own, launch, stop, or reconfigure the external Secure Tunnel. |
| Prove exact Local workspace binding | `WorkspaceRegistry.open` / `workspace_open` | Canonicalizes the requested path, enforces configured roots, and returns an explicit workspace identity. |
| Preserve single writer | existing `MutationOwner` | Different writer fails; interrupted/unknown units must reconcile before reacquire. |
| Preserve repository mutation scope | Repository Identity Fence policy | Canonical repository mutation scope must match before writes. |

## 5. Façade evidence model

The façade should expose a small sanitized lifecycle view, not raw implementation payloads.

A design-level shape is:

```text
LocalConnectionStatus {
  state,
  runtimeRevision,          // exact SHA when proven
  bindingDigest,            // opaque/sanitized profile-binding digest when available
  localHealth,              // ready / not-ready / unknown
  tunnelReadiness,          // ready / unavailable / unknown
  chatgptReachability,      // proven only by a successful ChatGPT-side invocation
  authorizedRootsPresent,   // boolean only; never list roots
  authority: {
    grantsWorkspaceAuthority: false,
    grantsMutationAuthority: false,
    grantsParentAuthority: false
  },
  failurePhase?,
  remediationCode?
}
```

Rules:

- never return config paths, dataRoot, workspace roots, tokens, cookies, credentials, raw logs, PIDs unless a bounded diagnostic contract explicitly requires a non-sensitive value;
- exact runtime revision may be returned because exact-version proof is part of the accepted activation/recovery contract;
- a profile/binding digest may be shown as an opaque identity hint, but its value is not authority;
- `READY_REMOTE` is only true when ChatGPT has actually invoked the Local MCP through the configured remote path in the current product surface. Host-side tunnel readiness alone is not equivalent to ChatGPT reachability.

## 6. Product state model

| State | Entry criterion | User-visible meaning | Exit / fail-closed rule |
| --- | --- | --- | --- |
| `NOT_INSTALLED` | No accepted Stable Runtime/bootstrap binding is available. | “Local connection is not installed.” | Do not scan for a config, repo, or workspace. Installation requires an explicit accepted bootstrap input. |
| `NOT_READY` | A binding is known, but exact Local readiness cannot be proven. | “Local connection is not ready.” | Diagnose exact phase; never substitute another runtime/profile. |
| `ACTIVATING` | Exact target activation/bootstrap is in progress. | “Activating the selected Local runtime.” | Only become ready after exact revision + readiness proof. Failure enters `DEGRADED` or returns to prior proven state after safe rollback. |
| `READY_LOCAL` | `/healthz` + `/readyz` prove the same exact runtime revision and allowed roots are configured. | “Local runtime is ready on this computer.” | Remote status is separate. |
| `REMOTE_UNAVAILABLE` | Local exact runtime is ready, but external tunnel readiness or ChatGPT product attachment/reachability is not proven. | “Local runtime is ready, but ChatGPT cannot reach it remotely.” | Do not take ownership of external tunnel/auth lifecycle. Surface the external remediation boundary. |
| `READY_REMOTE` | Exact Local readiness is proven and a current ChatGPT-side façade/status invocation succeeds through the remote MCP path. | “Your local connection is ready.” | A later failed invocation or readiness loss moves to `DEGRADED` / `REMOTE_UNAVAILABLE`. |
| `DEGRADED` | Identity remains known, but one or more required readiness facts are stale, failed, contradictory, or ambiguous. | “Connection needs attention.” | Preserve exact binding; diagnose before mutation/recovery. |
| `RECOVERING` | Deterministic recovery is operating on the exact selected binding. | “Recovering the existing local connection.” | Recovery may reuse/start only the exact Stable Runtime it is authorized to manage. Tunnel remains external. |
| `DISCONNECTED` | ChatGPT attachment or remote reachability has been intentionally disabled, or the external tunnel owner intentionally disconnected it. | “Disconnected.” | Local runtime may still be healthy. Reconnect must reuse the same explicit binding. |
| `REVOKED` | An authoritative external connector/tunnel provider confirms credential/app authorization revocation. | “Authorization revoked.” | The façade must not claim this state from mere unreachability. If revocation cannot be authoritatively confirmed, remain `DISCONNECTED` / `REMOTE_UNAVAILABLE`. |
| `UPGRADE_PENDING` | A specific immutable target has been selected but not yet activated. | “Upgrade ready to apply.” | No `latest`/recency resolution. The exact SHA must be resolved before activation. |
| `ROLLBACK_PENDING` | A specific exact rollback target is proven and selected, or an activation failure has an automatically proven previous serving revision. | “Rollback ready.” | If no exact safe prior revision is proven, fail closed as “rollback unavailable”; never guess “previous”. |

## 7. Lifecycle transition contract

### T1 — Install / activate

**User intent:** “Set up or activate my local connection.”

**Existing primitives:** `host/stable-runtime-first-bootstrap.mjs`; `scripts/stable-runtime-activate.mjs`; existing Stable Runtime config/profile; exact trusted repo binding; external tunnel readiness check.

**Durable identity:** exact target commit SHA, exact Stable Runtime config/profile fingerprint, exact trusted canonical repo, exact serving endpoint. None of these confer mission authority.

**Success evidence:** activation `PASS`; Local `/healthz` and `/readyz` return the exact target revision; loopback/readiness checks pass; external tunnel readiness passes.

**Fail closed / remediation:** invalid target/config/repo/profile, ambiguous listener, failed preflight, target start/readiness failure, or tunnel unreadiness must stop with a specific phase. Do not scan for alternatives or silently reset a checkout.

**Maximum expected Human Principal steps:** once Stable Runtime config + Secure Tunnel are already provisioned, one host action. First-ever Secure Tunnel provisioning is externally owned and cannot be given a project-controlled maximum by this façade. If ChatGPT app attachment is also absent, add one ChatGPT product-setting action.

**Unavoidable ChatGPT product setting:** yes, first connector/custom-app attachment when not already present.

**Restart/reboot/reconnect:** activation preserves exact revision semantics; reboot is handled by T11 recovery.

**Upgrade/rollback:** exact SHA only; activation failure may restore only a proven prior same-profile serving revision.

**Privacy:** no private config path, dataRoot, workspace root, credential, or raw log in durable ChatGPT/GitHub evidence.

### T2 — Authorize one workspace root

**User intent:** “Allow this exact local folder for Local operations.”

**Existing primitives:** first-bootstrap/recovery `--authorized-workspace-root <exact Human-approved directory>`; `AuthorizedWorkspaceRootInstaller`; existing `workspaceRoots` containment.

**Durable identity:** exact canonical root is retained locally in Stable Runtime config. It is never returned as durable remote evidence.

**Success evidence:** sanitized `rootAuthorized=true`, exact runtime activation PASS, readiness booleans, exact revision.

**Fail closed / remediation:** missing/non-directory path, invalid exact target, unproven previous serving revision, activation failure, or failed rollback. Never enumerate directories or infer a substitute root.

**Maximum Human steps:** one explicit root-selection/input plus one host façade action; these may be presented as one guided action.

**ChatGPT product setting:** none.

**Restart/reboot/reconnect:** authorization force-reloads the exact accepted Stable Runtime; later reboot uses the same config.

**Upgrade/rollback:** config change is restored and the previously proven serving revision is reactivated when safe if the authorization reload fails.

**Privacy:** remote PASS/FAIL must not echo the root path or file names beneath it.

### T3 — Connect

**User intent:** “Make the ready Local runtime reachable from ChatGPT.”

**Existing primitives:** existing external Secure Tunnel readiness; existing ChatGPT custom-app/connector attachment; Local MCP remote invocation.

**Durable identity:** same exact Stable Runtime binding. Connector/tunnel credential identity remains external and is not converted into authority.

**Success evidence:** a ChatGPT-side read-only façade/status call succeeds through the remote MCP path and returns the exact runtime revision/binding evidence.

**Fail closed / remediation:** if Local is ready but tunnel is not, surface `REMOTE_UNAVAILABLE / tunnel_readiness`. If tunnel is ready but ChatGPT cannot invoke the app, surface the ChatGPT product-attachment boundary. Do not create a relay or new auth flow.

**Maximum Human steps:** zero when tunnel/app attachment already exists; otherwise one product-setting action for ChatGPT attachment, plus any externally owned Secure Tunnel remediation required by that provider.

**ChatGPT product setting:** potentially yes.

**Restart/reboot/reconnect:** reconnect reuses the exact connection binding; no new logical execution is created.

**Upgrade/rollback:** none.

**Privacy:** no OAuth/token values or connector account identifiers enter façade evidence.

### T4 — Status / ping

**User intent:** “Is my local connection ready?”

**Existing primitives:** `/healthz`, `/readyz`, configured tunnel readiness, and the fact that a ChatGPT-side MCP status invocation arrived successfully.

**Minimum façade gap:** current Local MCP has no dedicated lifecycle-status tool that returns the aggregate connection state without requiring workspace IDs. A future implementation may add one **read-only, zero-authority aggregation tool** (for example `connection_status`) that exposes only the sanitized shape in Section 5. This is façade plumbing, not a service/backend.

**Durable identity:** exact runtime revision and opaque binding digest only.

**Success evidence:** `READY_REMOTE` when invoked from ChatGPT and local/tunnel facts are consistent; `READY_LOCAL` from host-side status when remote reachability is not proven.

**Fail closed / remediation:** contradictory revisions, missing readiness, or unavailable tunnel become `DEGRADED` / `REMOTE_UNAVAILABLE`; do not return a green state based on stale cached success.

**Maximum Human steps:** zero from ChatGPT when reachable; one host status command when remote path itself is unavailable.

**ChatGPT product setting:** none beyond the already-connected app.

**Restart/reboot/reconnect:** status never mutates or restarts anything.

**Upgrade/rollback:** status may display exact current revision; it must not resolve or select a target.

**Privacy:** fixed-schema sanitized output only.

### T5 — Reconnect / recover

**User intent:** “Restore this existing local connection.”

**Existing primitives:** `host/stable-runtime-recover.mjs`; `npm run recover:v0.2 -- --config ...`; exact durable same-profile revision selection; external tunnel readiness check.

**Durable identity:** same config/profile fingerprint, same exact trusted repo binding, explicit target SHA or validated exact same-profile durable state.

**Success evidence:** recovery `PASS`; exact Local revision and single listener proof; external tunnel readiness; no guessed target.

**Fail closed / remediation:** wrong/unknown/ambiguous listener, invalid target/profile, runtime conflict/readiness failure, tunnel unreadiness, or joint readiness loss. If tunnel is down, recovery must stop at `tunnel_readiness`; it must not launch/stop/reconfigure the external tunnel.

**Maximum Human steps:** normally one host façade/recovery action. If the external tunnel owner is unhealthy, an additional provider-specific remediation action is unavoidable and remains outside orchestrator ownership.

**ChatGPT product setting:** only if app attachment itself was removed/expired.

**Restart/reboot/reconnect:** recovery reuses or starts only the exact authorized Stable Runtime. It does not silently start another task/execution.

**Upgrade/rollback:** omitted `--sha` is allowed only when exact same-profile durable state validates; this is deterministic recovery, not “latest” selection.

**Privacy:** use the existing bounded/redacted recovery failure payload.

### T6 — Disconnect

**User intent:** “Stop ChatGPT from reaching this local connection without changing Local authority.”

**Existing primitives:** external Secure Tunnel owner controls tunnel lifecycle; ChatGPT product controls connector/custom-app attachment. Stable Runtime does not own those actions.

**Durable identity:** current Local runtime/profile may remain intact and ready locally.

**Success evidence:** authoritative external provider/product confirms detach/disable, or host-side status proves remote tunnel unavailable after an intentional external action. Local runtime health is reported separately.

**Fail closed / remediation:** do not equate an unexplained outage with an intentional disconnect.

**Maximum Human steps:** one external product/provider action when that surface exposes disable/remove. There is no current orchestrator-owned one-click disconnect primitive.

**ChatGPT product setting:** often yes.

**Restart/reboot/reconnect:** reconnect must reuse the explicit binding; no most-recent selection.

**Upgrade/rollback:** unaffected.

**Privacy:** no credential material or account identifiers.

### T7 — Revoke

**User intent:** “Invalidate the remote authorization/credential, not merely disconnect.”

**Existing primitives:** none inside Stable Runtime/Local MCP. Credential lifecycle belongs to ChatGPT and/or the external Secure Tunnel provider.

**Gap:** the orchestrator cannot authoritatively prove or perform unified credential revocation with current accepted primitives.

**Minimum new primitive if Parent later requires it:** a façade adapter to an already-existing provider/product revocation action **only if that provider exposes an authorized API/tool**. Otherwise remain a documented Human Principal product-setting step. Do not build an OAuth server, credential store, or revocation service.

**Durable identity:** provider-owned credential/app authorization identity remains external.

**Success evidence:** provider/product authoritative revocation confirmation. Mere connection failure is insufficient.

**Fail closed / remediation:** if confirmation is unavailable, report `DISCONNECTED` or `REMOTE_UNAVAILABLE`, not `REVOKED`.

**Maximum Human steps:** one provider/product action where available.

**ChatGPT product setting:** potentially yes.

**Restart/reboot/reconnect:** reconnect after revocation requires an explicit reauthorization boundary.

**Upgrade/rollback:** unaffected.

**Privacy:** never relay tokens or credential IDs.

### T8 — Select device / connection

**User intent:** “Use this exact local computer/connection.”

**Current backend status:** single explicit Stable Runtime binding is provable, but the current accepted backend does not provide an orchestrator-owned multi-device registry or remote selection service.

**Gap:** true multi-device list/select is not satisfied by current primitives.

**Minimum future primitive if separately authorized:** an explicit local/static set of named connection bindings whose entries are created only by Human/Parent-authorized exact configuration and selected by stable ID; no discovery, no recency fallback, no hosted registry. This is a separate Parent implementation decision because it creates durable multi-binding semantics.

**Fail closed rule now:** when more than one possible connection is presented without an explicit accepted binding, return “selection unsupported/ambiguous”; never choose the newest/online/most-recent device.

**Maximum Human steps now:** zero for the sole explicitly bound connection; multi-device selection is unsupported rather than guessed.

**ChatGPT product setting:** provider-specific if multiple custom apps/connectors are involved; no project assumption.

**Restart/reboot/reconnect:** selection must survive only through explicit durable binding, not process memory.

**Upgrade/rollback:** per selected exact binding only.

**Privacy:** user-facing labels must not embed private paths or machine identifiers unless the Human explicitly chose that label.

### T9 — Upgrade

**User intent:** “Move this local connection to a selected accepted version.”

**Existing primitives:** exact-revision Stable Runtime activator, isolated prepared checkout, exact readiness proof, safe failed-cutover rollback when a previous serving revision is proven.

**Façade behavior:** the Human should not need to type a SHA in normal product UX, but before host activation the orchestrator/Brain must resolve the selected immutable release/candidate to one exact 40-hex SHA and bind the activation to it. `latest`, branch-head-at-use-time, newest checkout, or recency-based resolution is forbidden.

**Durable identity:** selected exact SHA + current profile fingerprint.

**Success evidence:** exact target revision appears on both `/healthz` and `/readyz`, tunnel readiness is still good, activation PASS.

**Fail closed / remediation:** target validation/preflight/cutover/readiness failure. If a safe previous serving revision is proven, automatic rollback may restore it; otherwise fail closed.

**Maximum Human steps:** one façade “upgrade to selected immutable version” action after the version has been selected/authorized.

**ChatGPT product setting:** none.

**Restart/reboot/reconnect:** future recovery uses exact validated state; no default changes are implied.

**Rollback:** failed-cutover rollback is already supported when exact prior state is proven.

**Privacy:** no checkout/config path in remote evidence.

### T10 — Rollback

**User intent:** “Return to an exact known-good prior runtime.”

**Existing primitives:** activation can target any explicit exact accepted SHA that satisfies current trusted-repo validation; failed cutover can automatically restore a proven same-profile previous serving revision.

**Gap:** the current durable Stable Runtime state is not a general version-history registry. A one-click post-success “go to previous version” action cannot safely infer “previous” after the successful target has replaced current durable active state.

**Minimum future primitive if separately authorized:** retain one explicit sanitized `previousProvenRevision` pointer bound to the same profile/config and exact prepared checkout, with the same validation rules as current rollback state. No version registry, update service, or `latest-1` semantics.

**Success evidence:** exact rollback SHA proven on `/healthz` + `/readyz`, tunnel ready.

**Fail closed / remediation:** if no exact safe rollback target is explicitly supplied/proven, report “rollback unavailable”; do not guess.

**Maximum Human steps:** zero for automatic failed-cutover rollback; one action for an explicitly selected exact rollback target.

**ChatGPT product setting:** none.

**Restart/reboot/reconnect:** same deterministic recovery rules after rollback.

**Privacy:** expose version/revision evidence, not local checkout paths.

### T11 — Reboot / login recovery

**User intent:** “Come back after reboot without rebuilding the connection.”

**Existing primitives:** fixed `npm run recover:v0.2 -- --config <...>` entrypoint; optional Task Scheduler/Startup launcher documented as a thin Human-installed wrapper around that exact command.

**Durable identity:** existing exact config/profile + validated same-profile exact target state.

**Success evidence:** same recovery PASS criteria as T5.

**Fail closed / remediation:** no valid target/profile, ambiguous listener, Local readiness failure, or external tunnel unreadiness.

**Maximum Human steps:** one fixed recovery action after login when no auto-start launcher is installed; zero routine steps if the Human has separately installed the optional OS launcher and it succeeds. Installing/removing that launcher remains a Human/machine boundary.

**ChatGPT product setting:** none unless connector authorization itself expired.

**Upgrade/rollback:** no version change is implied by reboot.

**Privacy:** same bounded recovery evidence.

### T12 — Diagnose

**User intent:** “Tell me why the connection is not ready and what I must do next.”

**Existing primitives:** activation/recovery failure phases; Local health/readiness; external tunnel readiness; current ChatGPT provider invocation success/failure; existing structured diagnostics where already authorized.

**Façade behavior:** map low-level phases into stable remediation categories, for example:

```text
config_binding / profile_binding  -> connection binding needs repair
target_binding                    -> selected exact version is invalid/unavailable
runtime_conflict                  -> Local endpoint identity is ambiguous; do not kill/guess
runtime_start / runtime_readiness -> Stable Runtime failed to become exact-ready
tunnel_readiness                  -> external Secure Tunnel owner must recover
chatgpt_attachment                -> attach/re-authorize the ChatGPT app
workspace_root_binding            -> re-enter the exact Human-approved workspace root
authority_conflict                -> reconcile existing execution/writer; do not reacquire silently
```

**Minimum façade gap:** a stable error-to-remediation mapper and fixed-schema connection-status presentation.

**Maximum Human steps:** zero to obtain diagnostics when ChatGPT path is reachable; otherwise one host status/diagnose action, then only the remediation action named by the phase.

**ChatGPT product setting:** only for `chatgpt_attachment`.

**Restart/reboot/reconnect:** diagnosis itself is read-only.

**Upgrade/rollback:** diagnosis may recommend an explicit rollback only when a safe exact rollback target is proven.

**Privacy:** phase/code + bounded sanitized facts only; no routine raw logs.

## 8. Thin façade primitives proposed for a later implementation mission

These are the only new primitives justified by this design. They are not implemented by Issue #110.

### BUILD-1 — host lifecycle wrapper

A thin host command such as:

```text
local-connection activate
local-connection status
local-connection recover
local-connection authorize-root <exact-path>
local-connection upgrade <immutable-version-selector>
local-connection rollback <explicit-exact-selector>
local-connection diagnose
```

It delegates to existing activation/recovery/config/readiness primitives and must not contain its own process manager, tunnel manager, auth server, registry, shell API, or Governance logic.

### BUILD-2 — read-only remote connection status

A fixed-schema, zero-authority MCP façade tool such as `connection_status` may aggregate:

- runtime revision/readiness;
- allowed-roots-present boolean;
- external tunnel readiness;
- sanitized binding digest;
- authority-negative assertions.

Because a successful remote call itself proves current ChatGPT reachability, this closes the “status/ping without workspace ID” UX gap.

It must have no path arguments, workspace selectors, shell/process control, credential input, mutation, reconnect, or authority-granting fields.

Security boundary: BUILD-2 must not recreate the always-available sensitive-diagnostics path rejected by Issues #66/#67. Only fields already established as non-sensitive connection/readiness evidence may be exposed without a stronger caller boundary. If a proposed field requires caller authorization that the current transport cannot enforce, omit it from the remote tool or keep it host-side; caller-supplied booleans or mission prose are not authorization.

### BUILD-3 — error/remediation mapper

Translate accepted activation/recovery/tunnel/product phases into a small stable remediation vocabulary. Keep original bounded phase codes for evidence; hide routine raw logs and internal IDs.

### BUILD-4 — immutable version selector resolution

Normal UX may accept a signed/immutable release identifier or Parent-selected candidate label, but before activation it must resolve to one exact 40-hex SHA and display/record that exact revision in evidence. No `latest`, “current main”, newest checkout, or date-based selection.

Resolution may be performed by the authoritative Brain / existing trusted GitHub or git evidence path; it does not require a new update service.

## 9. KEEP / REUSE / BUILD / DELETE LATER / DO NOT BUILD

### KEEP unchanged

- Stable Runtime exact-revision activation, isolated preparation, readiness proof, and safe failed-cutover rollback;
- deterministic Stable Runtime reboot/login recovery;
- external Secure Tunnel ownership boundary;
- current governed Local MCP / `mcp-plus-web-probe`;
- exact Human-authorized workspace roots and canonical containment;
- `workspace_open` explicit binding;
- Repository Identity Fence;
- MutationOwner / single authoritative writer;
- durable Governance, Parent fencing, bounded execution continuation;
- Codex structured delegation/reconciliation;
- independent evidence/readback and pointer-not-payload handoff.

### REUSE behind the façade

- `stable-runtime-first-bootstrap`;
- `stable-runtime-activate`;
- `stable-runtime-recover`;
- `AuthorizedWorkspaceRootInstaller`;
- `/healthz` and `/readyz`;
- configured external `tunnel.healthUrl`;
- existing exact revision/profile fingerprint evidence;
- current bounded activation/recovery error phases;
- current ChatGPT product attachment rather than a replacement auth system.

### BUILD later only after Parent accepts this design

- BUILD-1 host lifecycle wrapper;
- BUILD-2 read-only remote status aggregation;
- BUILD-3 stable remediation mapping;
- BUILD-4 immutable selector → exact SHA resolution at the façade/Brain boundary.

### DELETE LATER only after implementation proves parity

- operator-facing instructions that require routine users to reason about config paths, dataRoot, serving-checkout internals, tunnel internals, or raw activation/recovery payloads;
- duplicate manual “which command do I run now?” choreography superseded by the accepted host façade.

Do **not** delete the underlying deterministic operator/recovery docs until the façade has equivalent failure detail and rollback/recovery parity.

### DO NOT BUILD under #109/#110

- hosted MCP relay;
- OAuth authorization server;
- device registry/dashboard service;
- custom Realtime/WebSocket protocol;
- generic fleet RBAC;
- DesktopCommander fork;
- broad DesktopCommander-style tool engine;
- new generic remote-computer API;
- second Governance/authority plane;
- credential store owned by this project;
- automatic filesystem/config/device discovery;
- `@latest`, newest-device, newest-workspace, or newest-checkout semantics.

## 10. Explicit backend/product gaps

| Gap | Why current primitives do not satisfy it | Minimum safe future primitive | Current decision |
| --- | --- | --- | --- |
| Unified credential revoke | Credentials/app authorization are externally owned. | Adapter to an existing authorized provider revocation API, if one exists; otherwise a documented product-setting action. | Do not build auth/revocation backend. |
| True multi-device list/select | Current accepted Local stack proves one explicit Stable Runtime binding; no device registry exists. | Separate Parent-approved explicit static multi-binding contract; no discovery/recency. | Out of implementation scope. |
| One-click post-success “previous version” | Active state is not a general history registry. | One explicit previous-proven-revision pointer bound to same profile, if Parent later accepts it. | Out of implementation scope. |
| External tunnel repair | Recovery intentionally owns readiness only. | Provider-owned remediation; optionally façade guidance/linking. | Keep external ownership. |
| First-ever Secure Tunnel provisioning | No accepted orchestrator primitive owns it. | Existing provider/product setup only. | External prerequisite. |
| ChatGPT connector/custom-app attach/re-authorize | ChatGPT product boundary. | Existing ChatGPT product settings. | Unavoidable product action. |

None of these gaps requires a new hosted service for the selected façade architecture.

## 11. Comparative journey analysis

This comparison is descriptive. It is used only to check whether the façade removes the observed operator burden.

| Dimension | Current raw orchestrator journey | Proposed façade journey | RDC reference journey from #108/#109 evidence |
| --- | --- | --- | --- |
| First usable connection | Exact runtime/config/version handling plus external tunnel/app setup; exact workspace authorization is a separate explicit boundary when needed. | One host lifecycle action for the orchestrator-owned leg; exact workspace path requested only when authorization is needed; existing external tunnel/app attach remains explicit. | Device bootstrap/authorization plus a separate ChatGPT-side remote MCP/OAuth attachment; list/ping/online model then hides most transport internals. |
| Routine reconnect | Fixed deterministic recovery command, but user must interpret runtime vs tunnel ownership/failure phases. | One `reconnect/recover` intent with explicit “runtime recovered” vs “external tunnel/app action required”. | Product exposes device online/offline/list/ping/reconnect concepts. |
| Browser/product round-trips | Depends on current ChatGPT app/tunnel provider state; orchestrator does not own them. | Does not add any new browser round-trip; retains only unavoidable existing ChatGPT/provider actions. | At least device authorization and ChatGPT-side connector authorization were separate boundaries in #108 evidence. |
| Path/config knowledge | Operator docs expose config path, exact SHA, serving/runtime details; exact root must be known for authorization. | Routine status/recover hides config/dataRoot/serving internals; exact workspace root remains explicit because it is an authority boundary. | Device mental model hides local MCP/tunnel config; exact filesystem authority is a separate question. |
| SHA/version knowledge | Host activator consumes exact SHA. | Human selects an immutable accepted version/candidate; Brain/façade resolves and proves exact SHA before invoking unchanged activator. | Agent version may be pinned, but RDC is not adopted as this project’s exact-version authority model. |
| Diagnosis | Strong structured phases exist but are operator-oriented. | Same phases mapped to stable states/remediation codes; raw logs not required. | Health/list/ping improve reachability diagnosis; provider-specific failures still exist. |
| Reboot | One deterministic recovery command; optional OS launcher is Human-installed. | Same semantics under `RECOVERING`, with zero routine steps only when the existing optional launcher is already installed. | Persistent agent/session model is the product reference concept, not a selected backend dependency. |
| Upgrade/rollback determinism | Exact SHA; failed-cutover rollback only when prior serving revision is proven. | Exactly the same safety model; façade removes SHA plumbing from normal UX but not from machine evidence. | Reference does not replace the project’s exact-revision contract. |

### Material burden reduction proved by the design

The façade removes routine Human Principal reasoning about:

- repo bootstrap mechanics;
- config/dataRoot paths after the binding is already established;
- serving-checkout internals;
- Stable Runtime vs Secure Tunnel ownership during ordinary healthy use;
- workspace/job/task IDs for connection-status questions;
- raw logs for first-line diagnosis;
- exact SHA typing during normal immutable-version selection.

It deliberately does **not** hide:

- the exact workspace root when new Local file authority is requested;
- the fact that ChatGPT app attachment/reauthorization is a product-setting boundary;
- the fact that the external Secure Tunnel has a different owner;
- exact revision evidence used to prove upgrade/rollback correctness;
- authority/mutation conflicts that require reconciliation.

## 12. Restart, reconnect, and same-execution semantics

A connection lifecycle event must never be interpreted as permission to start fresh logical work.

- Runtime restart/reboot changes process identity, not task/Parent/workspace authority.
- Secure Tunnel reconnect changes transport reachability, not workspace/mutation authority.
- ChatGPT connector reattachment changes product reachability, not Local authorization.
- A bounded execution that was interrupted or became unknown must use the existing durable reconciliation rules before mutation ownership can be reacquired.
- A replacement/fresh conversation performs runtime capability rediscovery and recovers durable mission context; the façade must not create a second execution to make the connection look green.

## 13. Privacy and sanitization contract

Façade evidence returned to ChatGPT or written to GitHub may include:

- lifecycle state;
- exact runtime revision;
- bounded readiness booleans/status codes;
- opaque binding digest;
- fixed failure phase/remediation code;
- whether authorized roots are configured;
- whether a product-setting action is required.

It must not include by default:

- private machine paths;
- config path;
- dataRoot;
- workspace-root values;
- file names/content;
- device/account identifiers;
- OAuth tokens, cookies, API keys, credentials, refresh tokens;
- raw process lists;
- routine raw logs;
- workspace/job/task/step/thread/turn IDs used only for internal orchestration.

## 14. Validation against current implementation

The design was checked against current `main` behavior at `b4c4b127cefa483f0ce81851b104c5f94d62e1bb`.

### Mapping validation

- Exact activation exists and requires an exact SHA, exact bounded profile, exact Local revision proof, and external tunnel readiness.
- Stable Runtime activation/recovery requires `tunnel.external=true`; the runtime owns readiness verification only and refuses to take tunnel lifecycle ownership.
- `/healthz` and `/readyz` expose exact runtime revision and bounded readiness facts.
- Exact workspace-root authorization already performs no directory enumeration, preserves unrelated config, force-reloads the exact accepted runtime, rolls back safely when possible, and sanitizes the root from evidence.
- Windows recovery accepts only explicit exact SHA or validated same-profile exact durable state and fails closed on ambiguous/wrong listeners.
- Workspace binding is explicit and canonical-root-contained.
- MutationOwner prevents silent reacquisition across writer/unknown-interrupted boundaries.
- Repository mutation remains subject to Repository Identity Fence.
- Remote lifecycle status must remain non-sensitive fixed-schema evidence; this design does not reopen the #66/#67 rejected always-available sensitive diagnostic surface.

### Human relay inventory

Normal façade operation must not require the Human Principal to relay:

- workspace/job/task/step/thread/turn IDs;
- raw RESULT payloads;
- routine shell output;
- raw logs;
- config/dataRoot paths once an exact connection binding already exists.

Remaining unavoidable Human-owned inputs/actions are:

1. one exact workspace root when new Local file authority is intentionally granted;
2. ChatGPT connector/custom-app attachment or reauthorization when the product requires it;
3. external Secure Tunnel provisioning/repair/revocation where its provider owns that lifecycle;
4. optional OS startup-trigger installation/removal;
5. explicit selection when a future multi-binding design is ever accepted.

### No-new-hosted-service proof

Every selected normal-flow transition uses:

- current local Stable Runtime/Local MCP code;
- current external Secure Tunnel;
- current ChatGPT product attachment;
- thin local/read-only aggregation only.

No selected transition requires a project-hosted relay, OAuth server, device registry, realtime channel, public Internet service, or second authority plane.

## 15. Future Option-2/3 trigger — recorded, not implemented

Reconsidering a self-hosted device/relay layer or DesktopCommander remote-device reuse requires a separate Parent architecture decision and new material evidence.

A trigger must show a recurring requirement that the current Secure Tunnel + ChatGPT product attachment + this façade cannot satisfy, such as:

- material compliance/data-handling requirement;
- recurring provider outage or availability failure that the retained current path cannot absorb;
- a required multi-device/product SLO that explicit local bindings cannot satisfy;
- transport-enforced semantics unavailable from current providers;
- demonstrated 24-month forward TCO/control case that exceeds realistic build + security + operations cost.

Until such evidence exists, Options 2/3 remain outside this design.

## 16. Design handoff

This contract is ready for Parent review when the PR head is independently verified to contain only this design artifact and no runtime/default/release mutation.

Candidate Parent decision after review:

```text
DESIGN_READY_FOR_PARENT_REVIEW
```

Implementation remains unauthorized until a later Parent acceptance/implementation mission explicitly selects which BUILD items, if any, to materialize.
