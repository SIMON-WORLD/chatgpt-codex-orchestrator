# RFC: v0.2 — Implementation Architecture & Migration

- **Status:** Proposed design input — no implementation (N2, final architecture phase)
- **Target version:** v0.2 (concrete architecture + migration; does **not** implement runtime behavior)
- **Relates to:** [`docs/rfc-v0.2-chatgpt-native-capability-inventory.md`](rfc-v0.2-chatgpt-native-capability-inventory.md) (accepted N0), [`docs/rfc-v0.2-capability-routing.md`](rfc-v0.2-capability-routing.md) (accepted N1)
- **Date:** 2026-09-01 · N2
- **Artifact:** this document only, under `docs/`. No runtime/source/package version change, no release.

---

## 0. Purpose and audit approach

This RFC turns the accepted **N0 inventory** and **N1 routing contract** into the **concrete implementation architecture and migration plan** for v0.2. It is the **final architecture-only phase**. It does **not** implement runtime behavior and does **not** rewrite the repository from scratch.

**Audit-first rule applied:** no module name was invented without first inspecting the real codebase (`src/`, `scripts/`, `test/`, `package.json`). Where an existing module already satisfies a responsibility, we **adapt** it rather than create a parallel duplicate.

**Baseline audited:** current repo HEAD = the accepted architecture branch `rfc/v0.2-chatgpt-native-capability-inventory` @ `7195f84`. Current package `version` = `0.1.0-alpha.3`; current canonical path = Alpha.4 **Direct Brain Loop** over the **Codex in-app browser (IAB)** (see `src/direct-run-controller.js`, `src/direct-mode.js`, `src/iab-transport.js`). A **legacy / experimental detached runtime** (worker host, `TaskService` / `TaskManager`, durable recovery) is retained for compatibility (`src/task-*.js`, `src/worker-client.js`, `scripts/codex-worker-host.mjs`).

**Key audit facts:**
- `package.json` has **no runtime `dependencies`** and no MCP / App Server / tunnel dependency. All code is built-in Node. **No MCP server, no Codex App Server integration, and no tunnel-client integration exist in this repository yet.**
- The only "app-server" text hit under `src/scripts` is in `scripts/codex-worker-host.mjs` (comment), not a real App Server client.
- The current executor is the **Codex CLI** (`codex-executor.js` uses `node <codex.js>` `exec` / `exec resume <session>`), **not** the Codex App Server.
- The current Brain transport is **IAB** (`iab-transport.js` + `atomic-turn.js`), with a provider facade in `direct-mode.js`.

---

## A. Current-code audit (classification)

> `KEEP` = unchanged & still valid responsibility. `ADAPT` = responsibility valid but needs modification for v0.2. `REPLACE` = superseded; swap for a v0.2 module. `LEGACY_FALLBACK` = retain behind explicit legacy/experimental flag; not canonical. `REMOVE_LATER` = delete after v0.2 dogfood proves the new route.

### A.1 src/ (governance + context + config)

| FILE | CURRENT ROLE | TARGET ROLE | ACTION | TARGET | RISK | TESTS |
|---|---|---|---|---|---|---|
| `protocol.js` | Structured Brain protocol: `CONTROLS`, parse/normalize/validate, result, evidence, packet | Same **semantics**; reuse for governance, expose to MCP | `ADAPT` | reuse in-place | Low — keep `CONTROLS` incl. `PLAN/REPLAN/PUBLISH` | `protocol.test.js`, `direct-governance.test.js` |
| `directives.js` | parse/extract legacy control tokens | Same | `KEEP` | in-place | Low | `directives.test.js` |
| `protocol-integrity.js` | Envelope extraction, milestone acceptance, proof ledger, idempotency helpers | Same **semantics**; decouple from browser | `ADAPT` | reuse for governance + reconciliation | Medium — keep `evaluateMilestoneAcceptance` etc. | `protocol-integrity.test.js` |
| `direct-governance.js` | Acceptance/evidence gate, proof reuse, metrics | Same semantics (browser-agnostic) | `ADAPT` | reuse | Low | `direct-governance.test.js` |
| `verification.js` | Verification tiers/policy/authority | Add `verify_effect` classification | `ADAPT` | reuse + add read_only/workspace_effect | Low | `verification.test.js`, `verification-operational.test.js` |
| `safety.js` | Secret redaction, path normalize, bypass detect | Add workspace path-containment + credential-path blocking | `ADAPT` | reuse + extend | Medium | `safety.test.js` |
| `context-provider.js` | Bounded repo context packet with redaction | Same, used by Direct Local read/search | `KEEP`/`ADAPT` | reuse | Low | `context-provider.test.js` |
| `brain-context.js` | Project store / context | Same | `KEEP` | reuse | Low | `brain-context.test.js` |
| `runtime-env.js` | Trusted-REPL env adapter | Same | `KEEP` | reuse | Low | `runtime-env.test.js` |
| `runtime-paths.js` | Data-root paths | Same | `KEEP` | reuse | Low | — |
| `data-root.js` | Durable data-root resolver | Same | `KEEP` | reuse | Low | — |
| `config.js` | Alpha config | Fold into v0.2 config; keep defaults | `ADAPT` | v0.2 config | Low | — |
| `bootstrap.js` | brain-command config/bootstrap/discovery/status | Extend for MCP + tunnel + `CONTROL_PLANE_*` keys | `ADAPT` | reuse + extend | Medium | `bootstrap.test.js`, `brain-command-status.test.js` |
| `doctor.js` | Self-check | Add v0.2 checks (MCP server, App Server, tunnel) | `ADAPT` | reuse + extend | Low | — |
| `task-lock.js` | Crash-safe O_EXCL lock | Reuse for **single-session** ownership/reconciliation (not distributed) | `KEEP`/`ADAPT` | reuse | Low | `task-lock.test.js` |

### A.2 src/ (browser transport — IAB)

| FILE | CURRENT ROLE | TARGET ROLE | ACTION | TARGET | RISK | TESTS |
|---|---|---|---|---|---|---|
| `iab-transport.js` | `InAppBrowserTransport` + `BrainSession` (IAB) | **Not canonical**; keep as legacy transport behind explicit flag | `LEGACY_FALLBACK` | `src/legacy/iab-transport.js` | Medium — do not delete | `iab-browser-isolation.test.js`, `iab-dispatch.test.js` |
| `atomic-turn.js` | Composer-safe turn controller for IAB | **Not canonical**; legacy | `LEGACY_FALLBACK` | `src/legacy/atomic-turn.js` | Medium — part of IAB | `atomic-turn.test.js` |
| `direct-mode.js` | `createChatGPTBrowserProvider` + Direct defaults | Replace browser provider with MCP/App Server provider path | `REPLACE` + keep legacy | `src/transport/brain-local.js` (new); legacy in `src/legacy/` | High — browser coupling removed | `direct-mode.test.js`, `existing-conversation.test.js` |
| `direct-run-controller.js` | Alpha.4 controller (browser-bound) | Split: transport-agnostic controller (governance) + router; browser part to legacy | `ADAPT`/`REPLACE` | `src/controller/` (new); legacy in `src/legacy/` | High | `direct-run-controller.test.js`, `plan-identity.test.js` |

### A.3 src/ (legacy executor/worker/state)

| FILE | CURRENT ROLE | TARGET ROLE | ACTION | TARGET | RISK | TESTS |
|---|---|---|---|---|---|---|
| `loop-controller.js` | Legacy Brain<->Codex loop | **Not canonical**; legacy | `LEGACY_FALLBACK` | `src/legacy/` | Low | `loop-controller.test.js` |
| `codex-executor.js` | Codex CLI executor (`exec`/`resume`) | Superseded by App Server executor | `LEGACY_FALLBACK` | `src/legacy/` | Medium | `codex-executor.test.js` |
| `task-state.js` | Durable task state (schema v1) | Reuse patterns; add `mutation_owner`/operation state | `ADAPT` | reuse + new state module | Medium | `task-state.test.js`, `alpha2.test.js` |
| `task-manager.js` | Durable lifecycle | **Not canonical**; legacy | `LEGACY_FALLBACK` | `src/legacy/` | Medium | `task-manager.test.js`, `advance-task.test.js` |
| `task-service.js` | Durable entry | **Not canonical**; legacy | `LEGACY_FALLBACK` | `src/legacy/` | Medium | `task-service.test.js`, `task-service-conversation.test.js` |
| `worker-client.js` | localhost IPC worker client | **Not canonical**; legacy | `LEGACY_FALLBACK` | `src/legacy/` | Medium | `worker-client.test.js` |

### A.4 scripts/

| FILE | CURRENT ROLE | TARGET ROLE | ACTION | TARGET | RISK |
|---|---|---|---|---|---|
| `brain-command-launcher.mjs` | Legacy launcher (TaskService) | Not canonical; replace with v0.2 MCP+AppServer entry | `REPLACE` | `scripts/v0.2-start.mjs` (new) | High |
| `brain-command-worker.mjs` | Worker bootstrap | Not canonical; legacy | `LEGACY_FALLBACK` | keep | Low |
| `codex-worker-host.mjs` | Worker host | Not canonical; legacy | `LEGACY_FALLBACK` | keep | Low |
| `codex-run-cli.mjs` | CodexExecutor CLI | Superseded; legacy / move toward App Server | `LEGACY_FALLBACK` | keep | Low |
| `runtime-host.mjs` | Legacy single-shot | Not canonical; legacy | `LEGACY_FALLBACK` | keep | Low |
| `live-loop.mjs` | Live demo (IAB) | Not canonical; remove after dogfood | `REMOVE_LATER` | — | Low |
| `live-smoke.mjs` | Live smoke (IAB) | Not canonical; remove after dogfood | `REMOVE_LATER` | — | Low |
| `brain-command-status.mjs` | Status/doctor | Extend for v0.2 | `ADAPT` | keep + extend | Low |
| `setup-brain-command.mjs` | Setup skill/config | Extend for v0.2 MCP/tunnel | `ADAPT` | keep + extend | Medium |

### A.5 Classification counts (src/ + scripts/ current modules)

| Action | count |
|---|---|
| `KEEP` | 6 |
| `ADAPT` | 13 |
| `REPLACE` | 3 |
| `LEGACY_FALLBACK` | 13 |
| `REMOVE_LATER` | 2 |

---

## B. Target runtime architecture

Translation of the accepted conceptual chain into concrete runtime components:

```
ChatGPT Web/Desktop
  → Custom MCP App            (brain-to-local transport, product-side)
  → OpenAI Secure Tunnel       (external tunnel-client, supported dependency)
  → local orchestration MCP server   (NEW: src/mcp/server.js)
  → Capability Router               (NEW: src/router/capability-router.js)
       ├─ CHATGPT_DIRECT_LOCAL      (NEW: src/local/*)
       └─ CODEX_DELEGATE            (NEW: src/executor/app-server-executor.js)
           → Codex App Server        (external Codex; machine-control protocol)
           → Codex
```

`CHATGPT_NATIVE` capabilities remain **product-native** and are **not implemented** in this repository.

### B.1 Runtime components / responsibilities

| # | Component | Responsibility | Reuse |
|---|---|---|---|
| 1 | **MCP server / public tool surface** | Expose the v0.2 MCP tool surface (§C) over a local MCP endpoint. | new `src/mcp/server.js` |
| 2 | **Workspace binding / session** | Explicit `workspace_open`, canonicalized root, per-session workspace handle. | adapt `context-provider.js` + `safety.js` |
| 3 | **Capability Router** | Deterministic routing decision (§B of N1) → target route. | new `src/router/*` |
| 4 | **Mutation ownership state** | `mutation_owner = none | chatgpt | codex`, single-session. | new `src/state/mutation-owner.js` |
| 5 | **Direct Local executor** | Run workspace-scoped read/search/git_status/git_diff. | adapt `context-provider.js` |
| 6 | **Direct Local change-set/edit engine** | Diff-visible, base-hash/stale-write protected edits. | new `src/local/change-set.js` |
| 7 | **Verify policy** | `verify_effect` classification + narrow allowlist. | adapt `verification.js` |
| 8 | **AppServerExecutor** | Spawn/initialize App Server, thread/turn lifecycle, streaming, approvals, interrupt, shutdown, reconciliation. | new `src/executor/app-server-executor.js` |
| 9 | **Codex job/thread mapping** | Persist local job id ↔ App Server thread/turn identity for reconciliation. | new `src/executor/job-map.js`; adapt `task-lock.js` |
| 10 | **Approval handling** | Map `AskForApproval` ↔ `codex_respond_approval`. | new `src/executor/approval.js` |
| 11 | **Compact handoff/evidence contract** | Goal + scope + evidence + acceptance + risk; no transcript dump. | adapt `protocol-integrity.js` / `direct-governance.js` |
| 12 | **Governance integration** | PLAN/TASK/REVISE/REPLAN/ASK_USER/PUBLISH/DONE semantics over the router. | reuse `protocol.js`, `protocol-integrity.js`, `direct-governance.js` |
| 13 | **Operation/reconciliation state** | Operation id + base hash + result hash + operation journal; minimum idempotency boundary. | new `src/state/operation-state.js` |
| 14 | **Configuration/bootstrap** | v0.2 config: MCP endpoint, tunnel, `CONTROL_PLANE_*`, profile setup. | adapt `bootstrap.js` + `config.js` |
| 15 | **Observability/logging** | Structured, secret-redacted logging. | reuse `safety.js` redaction; new thin logger |

---

## C. MCP public surface (v0.2 first tool set)

No broad filesystem, no general bash, no `write`/`create` tool. Only the tools below.

### C.1 Direct Local tools

| Tool | Purpose | Input (key) | Output (key) | Semantics | mutation_owner | Failure contract | Idempotency | Bounded output |
|---|---|---|---|---|---|---|---|---|
| `workspace_open` | Bind a workspace root | `{ path }` | `{ workspaceId, root, ok }` | readOnly, session-scoped | sets session; not a mutation | `WorkspaceError` on illegal root | idempotent (re-open same root) | one workspace handle |
| `read` | Read a workspace-scoped file | `{ workspaceId, path }` | `{ path, content, bytes }` | readOnly | none | `PathError` (traversal/blocked) | idempotent | bounded bytes |
| `search` | Bounded search | `{ workspaceId, pattern, max? }` | `{ matches:[{path,line,hit}], truncated }` | readOnly | none | `SearchError` | idempotent | bounded matches |
| `edit` | Apply a change-set | `{ workspaceId, changes:[{path, operation, newText?, baseHash?}], baseHashId }` | `{ applied, diff, resultHash }` | mutating | requires `chatgpt` | `StaleWriteError`/`PathError` | operation id + base/result hash | bundled diff |
| `git_status` | Working-tree status | `{ workspaceId }` | `{ status }` | readOnly | none | `GitError` | idempotent | bounded |
| `git_diff` | Diff of a change-set | `{ workspaceId, ref? }` | `{ diff }` | readOnly | none | `GitError` | idempotent | bounded |
| `verify` | Focused verification | `{ workspaceId, command, effect? }` | `{ ok, exitCode, summary, output }` | readOnly **or** workspace_effect | requires owner if `workspace_effect` | `VerifyUnavailableError` | idempotent per command | bounded |

### C.2 Codex Delegate tools (thin MCP facade over App Server)

| Tool | Purpose | Input | Output | Semantics | mutation_owner | Failure | Idempotency |
|---|---|---|---|---|---|---|---|
| `codex_start` | create/start thread + turn | `{ prompt, cwd?, sandbox? }` | `{ jobId, threadId, turnId, state }` | mutating (codex) | requires `codex` | `AppServerError`, `NoThreadError` | job mapping persisted; reconcile on retry |
| `codex_get` | `thread/read` state | `{ jobId, includeTurns? }` | `{ threadId, turnId, state, items? }` | readOnly | none | `AppServerError` | idempotent |
| `codex_continue` | continue same thread | `{ jobId, instruction }` | `{ jobId, threadId, turnId, state, result }` | mutating | requires current `codex` | `AppServerError` | idempotency via job map |
| `codex_interrupt` | interrupt running turn | `{ jobId }` | `{ jobId, state }` | control | requires `codex` | `AppServerError` | idempotent |
| `codex_respond_approval` | answer `AskForApproval` | `{ jobId, approvalId, decision }` | `{ jobId, ok }` | control | requires `codex` | `AppServerError` | idempotent |

**Each tool** documents: purpose, input schema shape, output shape, readOnly/mutating/control semantics, mutation_owner interaction, failure contract, idempotency/reconciliation requirement, bounded-output behavior.

---

## D. Direct Local implementation boundaries

Make `CHATGPT_DIRECT_LOCAL` concrete.

**Required properties (all enforced by `workspace.js` / `change-set.js` / `safety.js`):**
- explicit `workspace_open` before any repo operation;
- **canonicalized** workspace root (`path.resolve` + realpath check);
- **path traversal prevention** (all inputs must resolve inside the bound root; reject `..`, symlink escape, absolute outside);
- workspace-only access;
- **secret/credential path blocking** (reuse `safety.js` `SENSITIVE` patterns; block `.env`, `.pem`, `.key`, `credentials`, `token`, `.git`/`node_modules` read/write where sensible);
- blocked cache/build/generated paths (`node_modules`, `.next`, `dist`, `build`, `.venv`, `.state`) — read may be allowed, write/replace blocked;
- bounded file reads/search (reuse `context-provider.js` bounds: `maxBytes`, `maxFiles`, matched hits);
- **base-hash stale-write protection** (each `edit` carries a base hash; mismatch → `StaleWriteError`);
- diff-visible edit/change-set;
- **new small file creation through the same change-set primitive** (no independent `write`/`create` tool);
- no independent unrestricted write tool;
- no arbitrary shell.

### D.1 Practical initial meaning of "small bounded edit"

Rather than a vague natural-language concept, define a **default boundary** as a routing heuristic plus a few **hard safety limits**:

| Dimension | Default heuristic value | Type |
|---|---|---|
| max changed files | `<= 3` | routing heuristic |
| max changed bytes/lines | `<= 300` lines / `<= 20KB` | routing heuristic |
| known target files | all target files named before mutation | routing heuristic |
| exact change intent known | full intended diff known before mutation | routing heuristic |
| root cause unknown | must be false (no unknown-root-cause exploration) | routing heuristic |
| max changed files (hard) | `<= 5` after which router must escalate conservatively | **hard safety limit** |
| max changed bytes (hard) | `<= 40KB` after which router must escalate conservatively | **hard safety limit** |
| max single file line delta | `<= 500` lines | **hard safety limit** |

**Rule:** a `CHATGPT_DIRECT_LOCAL` edit is allowed only when **all** heuristics are satisfied **and** none of the hard limits are exceeded. The router escalates **conservatively before reaching hard limits** (e.g. if `changedFiles` is approaching 5, escalate to `CODEX_DELEGATE`). Hard limits are fail-closed; heuristics are guidance. Above a hard limit the request is rejected with `DirectLocalLimitError` and the router must escalate.

---

## E. Verify implementation

`verify` is **not** inherently read-only (§N1 r1). Classify each command.

```
verify_effect = read_only | workspace_effect
```

- **`read_only` verify** — allowed **without acquiring mutation ownership only when the command is explicitly classified / allowlisted as side-effect-free.**
- **`workspace_effect` verify** — **requires the current local mutation owner** (`chatgpt` or `codex`).
- While `codex` owns an active mutating turn, ChatGPT Direct may continue `read`/`search`/`git_status`/`git_diff`, but must **not** run Direct Local `edit` or `verify` by default.
- **No second locking subsystem** — reuse `mutation_owner`.
- Keep `verify` a narrow allowlisted tool; **no general bash**.

**Verify policy location recommendation:** prefer the **existing repo config surface**. Resolve the `verify` allowlist from an **existing repo file** (e.g. package config `["scripts"]` / a documented `orchestrator.verify.json`), falling back to a small built-in allowlist (`npm test`, a test filter, a documented linter, one build step). Do **not** create a new global config for verify if a repo config already exists.

---

## F. AppServerExecutor (concrete)

Productionized replacement for the spike, using **Codex App Server generated schema/protocol as authority**. Thin MCP facade; **no raw App Server protocol exposure to ChatGPT**.

**Covers:**
- **process launch** — spawn `codex app-server --listen stdio://crypto` (baseline `codex-cli 0.146.0`); manage stdin/stdout/stderr;
- **initialize** — `initialize` handshake;
- **capabilities.experimentalApi** — set `experimentalApi: true` for granular `AskForApproval`;
- **thread/start** — create a thread;
- **turn/start** — start a turn;
- **streaming notifications** — consume `turn/started`, `turn/completed`, approval notifications;
- **thread/read includeTurns** — read concurrent turn status/items;
- **same-thread continuation** — `codex_continue` reuses the same thread;
- **turn interrupt** — `codex_interrupt`;
- **approval requests/responses** — `codex_respond_approval`;
- **process shutdown** — graceful close + SIGTERM;
- **unexpected process death** — detect stdout/stderr close / exit code;
- **restart/reconciliation** — on restart, rehydrate from `job-map.js` using App Server thread/turn identity; never blindly duplicate a turn (§G CASE B);
- **structured result extraction** — extract a compact result + evidence (success/failure status, summary, diff) from `thread/read` items.

**What to reimplement from the spike vs NOT copied:**
- **Reimplement/adapt (productionize):** App Server client process lifecycle, thread/turn mapping to the MCP facade, streaming event handling, approval correlation, job-map persistence for reconciliation. (The isolated spike lives outside this repo; bring the *patterns*, not a copy.)
- **Deliberately NOT copied:** expose raw App Server protocol to ChatGPT (wrong boundary); a parallel thread/turn protocol (App Server is authoritative); any browser transport coupling.

---

## G. Minimal idempotency / reconciliation

No general exactly-once protocol. Only concrete side-effect boundaries.

**CASE A — Direct edit applies, response lost.**
- Minimum safe reconciliation: an **operation id** (returned from `edit`), plus **base hash** (before) and **result hash + diff** (after), and an **operation journal** entry if needed.
- On retry: the caller may call `git_diff`/`read` to inspect current state; if `resultHash` matches, the operation already applied → **no-op / success**; if not, re-evaluate against the current base hash (fail on stale).
- **MUST for first implementation:** operation id + base hash + result hash. **SHOULD after dogfood:** persisted operation journal.

**CASE B — `codex_start` creates an App Server thread/turn, bridge fails before returning job mapping.**
- Minimum safe reconciliation: **persist the local job mapping (threadId/turnId) as soon as it is known** (in `job-map.js`), even before returning to the caller. On restart, reconcile from the mapping; if a thread/turn already exists, **resume/readit rather than blind-duplicate** a new turn.
- **MUST:** persist thread/turn identity before acknowledging the job; reconcile on restart. **SHOULD after dogfood:** richer operation journal + lease-free single-session resume.

**Separated:** `MUST` for first implementation (operation id, base/result hash, job-map persistence, restart reconcile) vs `SHOULD` after dogfood (operation journal, richer resume).

---

## H. Governance integration

Map existing Alpha.4 governance semantics to the target runtime. **Reuse implementation where it already satisfies the responsibility.**

| Existing mechanism | Semantic? | Implementation? | Action in v0.2 |
|---|---|---|---|
| `PLAN` / `TASK` / `REVISE` / `REPLAN` / `ASK_USER` / `PUBLISH` / `DONE` (`protocol.js` `CONTROLS`) | **SEMANTIC TO KEEP** | **IMPLEMENTATION TO REUSE** | reuse |
| acceptance criteria (`direct-governance.js`) | keep | reuse | reuse |
| evidence + evidence ledger (`direct-governance.js`, `protocol.js`) | keep | reuse/adapt | reuse + expose to Direct Local verify |
| machine gate (`protocol-integrity.js`) | keep | reuse | reuse |
| Brain acceptance transition (`protocol-integrity.js`) | keep | reuse | reuse |
| publication/readback discipline (`publication-transaction.js`, `publish-policy.js`) | keep | reuse | reuse |
| controller state / task identity | mix | adapt | new controller over router; keep task identity where useful |
| result parser / protocol validation | keep | reuse | reuse `protocol.js` + `protocol-integrity.js` |

**Do NOT reintroduce browser transport machinery** (ACK/nonce/DOM/composer recovery/IAB exactly-once). Only **governance semantics** carry forward. Existing `controller state`, `task identity`, `evidence ledger`, `publication gate`, `result parser`, `protocol validation` **can be reused or adapted** — this is the preferred path, not replacement.

---

## I. IAB migration posture

The **official v0.2 canonical path** is:
```
Custom MCP App → Secure Tunnel → local MCP bridge → App Server
```
IAB/browser transport must **NOT** remain canonical.

**Recommended posture (safest, matched to current dependencies):**
- **Keep temporarily** behind an explicit legacy/experimental flag (e.g. `transport: 'iab'` / `--legacy-iab`).
- **Isolate** from the new architecture: move IAB modules under `src/legacy/`; the new MCP/App Server path does not import them.
- **Stop adding features** to the IAB path.
- **Remove only after v0.2 real dogfood** proves the new route (see milestone M6/M7).

**Why not immediate removal:** the IAB transport is the **only currently working Brain↔ChatGPT channel in this repo** (it has real, passing regression tests: `iab-browser-isolation.test.js`, `iab-dispatch.test.js`, `existing-conversation.test.js`, `direct-mode.test.js`, `direct-run-controller.test.js`). Removing it before the new MCP/tunnel path is dogfooded would leave no working path. No dependency evidence supports a safer instant removal, so **do not delete here**.

---

## J. Deployment / bootstrap design

How a real user runs v0.2.

| Item | Design |
|---|---|
| **orchestrator local server startup** | `npm run v0.2:` launcher (new script) starts a local Node process hosting the MCP server + router + App Server executor. |
| **MCP endpoint** | Local streamable-HTTP/stdio endpoint; configured via v0.2 config. |
| **tunnel-client relationship** | **Official `tunnel-client` is an external supported dependency** for first release — do **not** vendor/fork. The orchestrator mounts a route and exposes the tunnel URL; it does not reimplement tunneling. |
| **tunnel-client external prerequisite?** | **Yes** for first release (external prerequisite), unless evidence proves otherwise. |
| **profile setup** | `setup-brain-command` extended to register the v0.2 Custom MCP App and write the config; a distinct "v0.2 profile". |
| **CONTROL_PLANE_API_KEY** | Read from env/user secret store; **never committed to repo**; used by the tunnel/MCP runtime only. |
| **CONTROL_PLANE_TUNNEL_ID** | Read from env/user config; identifies the tunnel binding. |
| **no secrets committed** | All secrets are env / user-scoped secret store; `safety.js` redaction at log/context boundary. |
| **Custom MCP App discovery** | The MCP server advertises `tools/list`; the Custom MCP App in ChatGPT discovers it. |
| **Web/Desktop compatibility** | Supported via the Custom MCP App + tunnel (both surfaces). |
| **Codex install/auth req** | Codex CLI (baseline `0.146.0`) installed & authenticated locally; the App Server runs against the local Codex. |
| **Codex App Server startup** | Managed by `AppServerExecutor` spawn (`codex app-server --listen stdio://crypto`), not a separate user step for normal runs. |

**Key distinction (three identities, no OpenAI model API key for the Brain):**
- **ChatGPT account/auth** — product-side login; not an orchestrator key.
- **Tunnel runtime API key** — `CONTROL_PLANE_API_KEY` for tunnel-client/MCP runtime.
- **Codex auth/runtime** — local Codex CLI auth; not exposed to ChatGPT.

The orchestrator **does not require an OpenAI model API key for the Brain** — the Brain is ChatGPT (product), not an API key.

---

## K. Testing architecture (pre-implementation pyramid)

**UNIT:**
- routing decisions (`src/router/*`);
- workspace path containment (`src/local/workspace.js`);
- edit / base-hash (`src/local/change-set.js`);
- `mutation_owner` (`src/state/mutation-owner.js`);
- verify policy (`src/local/verify.js`, incl. `verify_effect`);
- compact handoff (`src/state/handoff.js`);
- job mapping / reconciliation (`src/executor/job-map.js`).

**INTEGRATION:**
- MCP server tool calls (fake/`fixtures` MCP client);
- fake / fixture App Server;
- real local App Server **optional** integration (gated offline);
- process death / restart;
- approval flow;
- interrupt / continue.

**LIVE E2E** (not part of every `npm test` run):
- ChatGPT Custom MCP → Secure Tunnel → local orchestrator → App Server → Codex → real small repo mutation/readback.

**Preserve existing useful Alpha.4 regression tests** where semantics remain relevant (e.g. `plan-identity.test.js`, `protocol-integrity.test.js`, `direct-governance.test.js`, `verification-operational.test.js`, `publication`/`publish` tests). Browser-transport tests (`iab-*`, `atomic-turn`, `existing-conversation`, `direct-mode`, `direct-run-controller`) remain but are **regression-only** for the legacy path after isolation.

---

## L. Migration milestones

Adapted to the actual repository. Each step is reviewable and rolls back independently.

| Milestone | Scope (exact) | Files/modules expected to change | Tests required | Acceptance criteria | Rollback boundary | Default-change? |
|---|---|---|---|---|---|---|
| **M0 — architecture landing** | Add this RFC as accepted; create first files for new dirs only where used. | docs; `src/router/`+`src/local/`+`src/executor/`+`src/state/` (first files) | no behavioral test | doc accepted; new structure compiles | revert docs only | no |
| **M1 — AppServerExecutor** | Implement `src/executor/app-server-executor.js` + `job-map.js` + fake App Server fixture; wire `codex_start`/`get`/`continue`/`interrupt`/`approval`. | `src/executor/*`, `test/executor/*` | unit + integration (fake App Server) | start/get/continue/interrupt/approve on fake App Server | keep module unused (no default path) | no |
| **M2 — local MCP server + read-only Direct Local** | `src/mcp/server.js`, `src/router/*`, `src/local/workspace.js` + read-only tools (`read`/`search`/`git_status`/`git_diff`). | `src/mcp/*`, `src/local/*`, `src/router/*` | unit + integration (MCP client) | read/search/status/diff work, path containment enforced | keep behind non-default flag | no |
| **M3 — edit + mutation ownership** | `src/local/change-set.js`, `src/state/mutation-owner.js`, `edit` tool + `verify_effect`. | `src/local/change-set.js`, `src/state/mutation-owner.js` | unit + integration | bounded edit + base-hash + owner guard | keep non-default | no |
| **M4 — Capability Router + Governance** | Route tools by §B; wire `PLAN/TASK/REVISE/REPLAN/ASK_USER/PUBLISH/DONE` over the router; reuse `protocol.js`/`direct-governance.js`. | `src/router/capability-router.js`, `src/governance/*` | unit + integration | routing + governance semantics verified; no browser coupled | keep non-default | **yes** (new MCP path selectable) |
| **M5 — Secure Tunnel real E2E** | Integrate official `tunnel-client` (external); pass `CONTROL_PLANE_*`; real Custom MCP App → tunnel → local server → App Server → Codex. | `src/transport/brain-local.js`, `config`, `scripts/v0.2-start.mjs` | **live E2E** (gated, not npm test) | real small repo mutation/readback end-to-end | disable tunnel path | yes when selected |
| **M6 — legacy IAB isolation** | Move IAB files under `src/legacy/`, behind `--legacy-iab`; stop new features. | `src/legacy/*`, `index.js` | existing IAB regression tests | canonical path no longer imports IAB | re-enable IAB flag | no (IAB becomes non-canonical) |
| **M7 — real project dogfood** | Run v0.2 on a real small project; collect metrics. | operational | live E2E | DONE via v0.2 path; metrics captured | revert to M5 | yes (default flips to v0.2) |
| **M8 — release candidate** | Full verification, doc/version review, publish gate (no earlier release). | docs, `CHANGELOG` | full suite + live E2E | gate passes; dogfood stable | freeze | yes |

**Rule:** no massive all-at-once rewrite; each milestone is additive and rollback-safe.

---

## M. File-level change map + target structure

### M.1 Current -> target change map (real current paths)

| CURRENT FILE/MODULE | CURRENT ROLE | TARGET ROLE | ACTION | TARGET FILE/MODULE | MILESTONE | NOTES/RISK |
|---|---|---|---|---|---|---|
| `src/protocol.js` | structured Brain protocol | same semantics | `ADAPT` | `src/protocol.js` | M4 | keep CONTROLS |
| `src/directives.js` | control token parse | same | `KEEP` | `src/directives.js` | M4 | — |
| `src/protocol-integrity.js` | envelope/acceptance/idempotency | same semantics | `ADAPT` | `src/protocol-integrity.js` | M4/M1 | decouple browser |
| `src/direct-governance.js` | acceptance/evidence gate | same | `ADAPT` | `src/direct-governance.js` | M4 | reuse |
| `src/verification.js` | verify policy/tiers | add verify_effect | `ADAPT` | `src/verification.js` | M3 | add effect |
| `src/safety.js` | redaction/path normalize | add containment | `ADAPT` | `src/safety.js` | M2 | path guard |
| `src/context-provider.js` | bounded repo context | reuse for Direct Local read | `KEEP`/`ADAPT` | `src/context-provider.js` | M2 | bounds |
| `src/brain-context.js` | project store | same | `KEEP` | `src/brain-context.js` | M2 | — |
| `src/runtime-env.js` | env adapter | same | `KEEP` | `src/runtime-env.js` | M0 | — |
| `src/runtime-paths.js` | data-root paths | same | `KEEP` | `src/runtime-paths.js` | M0 | — |
| `src/data-root.js` | data-root resolver | same | `KEEP` | `src/data-root.js` | M0 | — |
| `src/config.js` | alpha config | fold into v0.2 config | `ADAPT` | `src/config.js` | M0 | merge |
| `src/bootstrap.js` | config/bootstrap/discovery/status | add MCP/tunnel keys | `ADAPT` | `src/bootstrap.js` | M0/M5 | add keys |
| `src/doctor.js` | self-check | add v0.2 checks | `ADAPT` | `src/doctor.js` | M0/M5 | add checks |
| `src/task-lock.js` | crash-safe lock | reuse single-session | `KEEP`/`ADAPT` | `src/task-lock.js` | M1 | not distributed |
| `src/iab-transport.js` | IAB transport | legacy | `LEGACY_FALLBACK` | `src/legacy/iab-transport.js` | M6 | do not delete yet |
| `src/atomic-turn.js` | composer turn | legacy | `LEGACY_FALLBACK` | `src/legacy/atomic-turn.js` | M6 | part of IAB |
| `src/direct-mode.js` | browser provider | replace + legacy | `REPLACE` | `src/transport/brain-local.js` (new) + `src/legacy/` | M4/M6 | high risk |
| `src/direct-run-controller.js` | alpha4 controller | split controller/router + legacy | `ADAPT`/`REPLACE` | `src/controller/` + `src/router/` + `src/legacy/` | M4/M6 | high risk |
| `src/loop-controller.js` | legacy loop | legacy | `LEGACY_FALLBACK` | `src/legacy/loop-controller.js` | M6 | — |
| `src/codex-executor.js` | codex CLI executor | legacy (superseded) | `LEGACY_FALLBACK` | `src/legacy/codex-executor.js` | M6 | app-server replaces |
| `src/task-state.js` | durable task state | reuse patterns + add owner/op state | `ADAPT` | `src/task-state.js` + `src/state/*` | M3 | add fields |
| `src/task-manager.js` | durable lifecycle | legacy | `LEGACY_FALLBACK` | `src/legacy/task-manager.js` | M6 | — |
| `src/task-service.js` | durable entry | legacy | `LEGACY_FALLBACK` | `src/legacy/task-service.js` | M6 | — |
| `src/worker-client.js` | worker client | legacy | `LEGACY_FALLBACK` | `src/legacy/worker-client.js` | M6 | — |
| `scripts/brain-command-launcher.mjs` | legacy launcher | replace with v0.2 | `REPLACE` | `scripts/v0.2-start.mjs` | M5 | high |
| `scripts/brain-command-worker.mjs` | worker bootstrap | legacy | `LEGACY_FALLBACK` | keep | M6 | — |
| `scripts/codex-worker-host.mjs` | worker host | legacy | `LEGACY_FALLBACK` | keep | M6 | — |
| `scripts/codex-run-cli.mjs` | executor CLI | legacy | `LEGACY_FALLBACK` | keep | M6 | — |
| `scripts/runtime-host.mjs` | legacy single-shot | legacy | `LEGACY_FALLBACK` | keep | M6 | — |
| `scripts/live-loop.mjs` | demo | remove later | `REMOVE_LATER` | — | M7 | after dogfood |
| `scripts/live-smoke.mjs` | demo | remove later | `REMOVE_LATER` | — | M7 | after dogfood |
| `scripts/brain-command-status.mjs` | status | extend | `ADAPT` | keep | M0/M5 | add v0.2 status |
| `scripts/setup-brain-command.mjs` | setup skill/config | extend for MCP/tunnel | `ADAPT` | keep | M0/M5 | add MCP setup |
| **NEW** `src/router/capability-router.js` | — | router | new | `src/router/` | M4 | routing rules |
| **NEW** `src/local/workspace.js` | — | workspace bind/containment | new | `src/local/` | M2 | path guard |
| **NEW** `src/local/change-set.js` | — | edit engine | new | `src/local/` | M3 | base-hash |
| **NEW** `src/local/verify.js` | — | verify allowlist | new | `src/local/` | M3 | effect |
| **NEW** `src/executor/app-server-executor.js` | — | executor | new | `src/executor/` | M1 | App Server |
| **NEW** `src/executor/job-map.js` | — | job/thread mapping | new | `src/executor/` | M1 | reconcile |
| **NEW** `src/mcp/server.js` | — | MCP server | new | `src/mcp/` | M2 | tool surface |
| **NEW** `src/state/mutation-owner.js` | — | ownership | new | `src/state/` | M3 | owner |
| **NEW** `src/state/operation-state.js` | — | reconciliation | new | `src/state/` | M1/M3 | idempotency |
| **NEW** `src/state/handoff.js` | — | compact handoff | new | `src/state/` | M4 | evidence |

### M.2 Proposed target directory/module structure

```
src/
  mcp/            # MCP server + tool registry (v0.2)
    server.js
    tools.js
  router/         # Capability Router + decision rules
    capability-router.js
    decide.js
  local/          # CHATGPT_DIRECT_LOCAL
    workspace.js
    change-set.js
    verify.js
    read.js
    search.js
    git.js
  executor/       # CODEX_DELEGATE (App Server)
    app-server-executor.js
    app-server-client.js
    job-map.js
    approval.js
  state/          # mutation ownership + reconciliation + handoff
    mutation-owner.js
    operation-state.js
    handoff.js
  transport/      # Brain-to-local transport
    brain-local.js       # Custom MCP App + tunnel bridge
    registry.js          # transport selection (v0.2 | iab-legacy)
  governance/     # reuse protocol / direct-governance semantics
    index.js
  legacy/         # IAB + detached runtime (NOT canonical)
    iab-transport.js
    atomic-turn.js
    direct-mode.js
    loop-controller.js
    codex-executor.js
    task-manager.js
    task-service.js
    worker-client.js
    direct-run-controller.js (browser-bound controller)
  config.js, bootstrap.js, doctor.js, safety.js, protocol.js,
  protocol-integrity.js, direct-governance.js, verification.js,
  context-provider.js, brain-context.js, runtime-env.js,
  runtime-paths.js, data-root.js, task-lock.js
scripts/
  v0.2-start.mjs        # new launcher for MCP+App Server
  setup-brain-command.mjs  # extend
  brain-command-status.mjs # extend
  (legacy: brain-command-worker.mjs, codex-worker-host.mjs,
           codex-run-cli.mjs, runtime-host.mjs, live-loop.mjs, live-smoke.mjs)
```

> **No empty speculative layers.** Only directories that hold at least one concrete v0.2 module are created. Reuse `src/` existing modules rather than duplicating them under `legacy/` unless they become non-canonical.

---

## N. Reference & decisions

### 1. Accepted target architecture

The canonical v0.2 path is:
```
ChatGPT Web/Desktop → Custom MCP App → OpenAI Secure Tunnel → local orchestration MCP server → Capability Router → { CHATGPT_DIRECT_LOCAL | CODEX_DELEGATE → Codex App Server → Codex }
```
`CHATGPT_NATIVE` stays product-native. `mutation_owner = none | chatgpt | codex` single-session. Governance semantics preserved from Alpha.4; browser transport is **not** canonical and moves to legacy.

### 2. Exact first implementation milestone

**M1 — AppServerExecutor** (the first coherent, additive, non-default change). It delivers a productionized Codex App Server executor behind a thin MCP facade, isolated from the browser path, with a fake/fixture App Server test harness. Nothing else changes.

### 3. File-level first-change list (M1)

- `src/executor/app-server-executor.js` (new) — create/start/continue/interrupt/approval/shutdown/reconcile.
- `src/executor/app-server-client.js` (new) — spawn `codex app-server --listen stdio://crypto`, `initialize`, `capabilities.experimentalApi`, streaming events.
- `src/executor/job-map.js` (new) — persist local job ↔ App Server thread/turn identity (reconciliation).
- `src/executor/approval.js` (new) — map `AskForApproval` ↔ `codex_respond_approval`.
- `src/state/mutation-owner.js` (new) — owner state for `codex`.
- `test/executor/app-server-executor.test.js` (new), `test/executor/job-map.test.js` (new), `test/executor/fixtures/fake-app-server.mjs` (new).
- `src/index.js` (ADAPT) — export the new executor/job-map (additive).

### 4. Interfaces/contracts to implement first (M1)

- `AppServerExecutor` interface: `start({prompt,cwd,sandbox}) → {jobId,threadId,turnId}`, `get({jobId})`, `continue({jobId,instruction})`, `interrupt({jobId})`, `respondApproval({jobId,approvalId,decision})`, `shutdown()`.
- `JobMap` contract: persist `{jobId → {threadId, turnId, state}}`; load/resume on restart; no blind duplicate turn.
- `MutationOwner` for `codex`: acquire/release/guard.

### 5. Tests to write first (M1)

- Unit: job-map persistence + reconcile.
- Integration (fake App Server): `codex_start` → `codex_get` → `codex_continue` (same thread) → `codex_interrupt` → `codex_respond_approval` → shutdown; process-death/restart reconcile.

### 6. Deferred items

- General `bash` tool (never in v0.2); separate `write`/`create` tool (change-set sufficient); distributed lock / cross-session lease (until evidence); full local IDE or another Codex implementation; reimplementing ChatGPT-native capabilities; a general end-to-end exactly-once protocol; operation journal (after dogfood).

### 7. Explicit non-goals

- Do not implement ChatGPT-native capabilities (research, image, vision, docs, connectors) in this repo.
- Do not vendor/fork `tunnel-client`; use official as external dependency.
- Do not require an OpenAI model API key for the Brain.
- Do not build a second locking subsystem for verification; reuse `mutation_owner`.
- Do not expose raw App Server protocol to ChatGPT.

### 8. Migration risks

- **High:** browser coupling removal (`direct-mode.js`, `direct-run-controller.js`) — keep regression tests + legacy isolation flag.
- **High:** new MCP server surface (tool semantics, approval, bounded output) — need fixture tests + bounded-output checks.
- **Medium:** App Server process lifecycle (death/restart/reconcile) — persist job mapping before acknowledge.
- **Medium:** path containment / secret blocking — reuse `safety.js` + add tests; a mistake could cause a write outside the workspace.
- **Medium:** `mutation_owner` correctness — a single-session bug could allow a conflicting write; keep it fail-closed.
- **Low:** governance reuse — most code already browser-agnostic.

### 9. GO / REVISE / STOP recommendation for implementation

**GO** — proceed with **M1 (AppServerExecutor)** as the first implementation milestone. The audit shows the governance semantics are already largely reusable (`protocol.js`, `protocol-integrity.js`, `direct-governance.js`, `verification.js`, `publication-*`, `safety.js`), so M1 is additive and isolated with a strong fake-App-Server test harness. The browser-transport path is **not** touched in M1, so existing behavior is preserved and rollback is trivial.

---

## Sources / cross-references

- [`docs/rfc-v0.2-chatgpt-native-capability-inventory.md`](rfc-v0.2-chatgpt-native-capability-inventory.md) — accepted N0 inventory.
- [`docs/rfc-v0.2-capability-routing.md`](rfc-v0.2-capability-routing.md) — accepted N1 routing contract.
- [`docs/architecture.md`](architecture.md) — current Alpha.3/Alpha.4 state.
- [`docs/development-history.md`](development-history.md) — historical notes.
- Codex App Server spike (local oracle): `codex-cli 0.146.0`, `codex app-server --listen stdio://crypto`, `capabilities.experimentalApi`, `thread/read {includeTurns:true}`, `TurnStatus`.
- CodexBridge (pattern reference): https://github.com/naplesblue/codexbridge.

---

*This RFC is design input only. No runtime/source/package version changes were made. It is concrete enough that the next Brain TASK can begin implementation (recommended first milestone M1) without another architecture RFC. The audit classifies real modules; no module name was invented without inspecting the current codebase.*
