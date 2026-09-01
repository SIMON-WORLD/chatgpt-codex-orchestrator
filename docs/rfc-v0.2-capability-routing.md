# RFC: v0.2 — Capability Routing

- **Status:** Proposed design input — no implementation (Revision 1)
- **Target version:** v0.2 (Routing contract; does **not** implement runtime behavior)
- **Relates to:** [`docs/rfc-v0.2-chatgpt-native-capability-inventory.md`](rfc-v0.2-chatgpt-native-capability-inventory.md) (accepted N0 inventory)
- **Date:** 2026-09-01 · N1 r1 (revised per Brain `v0.2-n1-capability-routing-rfc-001-r1`)
- **Artifact:** this document only, under `docs/`. No runtime/source change, no version bump, no release.

---

## 0. Purpose and relationship to N0

This RFC turns the accepted **N0 capability inventory** into a **precise, minimal, implementable Capability Routing contract** for `chatgpt-codex-orchestrator` v0.2. It stays an architecture/RFC — it does **not** implement runtime behavior.

It composes on the N0 transport layering:

```
ChatGPT Web/Desktop
  → Custom MCP App
  → OpenAI Secure Tunnel
  → local MCP / orchestration bridge
  → Codex App Server
  → Codex
```

- **Custom MCP App + Secure Tunnel** = Brain-to-local transport.
- **Codex App Server** = local executor backend / machine-control protocol for Codex.

And the N0 routing targets (this RFC defines their exact semantics):

```
ChatGPT Capability Router
├─ CHATGPT_NATIVE
├─ CHATGPT_DIRECT_LOCAL
├─ CODEX_DELEGATE
└─ HYBRID
```

**Notation / evidence:** `OFFICIAL_SUPPORT` vs `OBSERVED_LOCAL` follow the N0 RFC. Plan-tier availability is marked `gate` (unverified). Nothing here assumes a distributed lock.

---

## Transport identity & idempotency boundary

MCP / JSON-RPC / **Codex App Server** provide **structured request/response identities, thread/turn identities, lifecycle events, and recoverable state surfaces**. They do **not**, by themselves, justify a blanket **end-to-end exactly-once mutation guarantee** across:

```
ChatGPT
→ Custom MCP App
→ Secure Tunnel
→ local bridge
→ App Server
→ filesystem / git side effects
```

**What we do here:**
- do **not** carry forward Alpha.4 browser-specific ACK / nonce / retransmit machinery;
- use **native MCP / App Server identifiers and lifecycle** as the **primary correlation** mechanism;
- for side-effecting operations, define only the **minimum idempotency / reconciliation boundary** required by implementation and real dogfood;
- do **not** invent a general exactly-once protocol in this RFC.

**Failure examples that drive the minimum boundary (implementation concerns for the next architecture phase, not reasons to restore browser machinery):**

A. `edit` succeeds locally → response connection fails → the caller does **not** know whether a retry is safe.
B. `codex_start` creates/starts an App Server turn → the bridge fails **before** returning the local job mapping → recovery must **reconcile** rather than blindly duplicate.

These are handled as **implementation concerns** in the next architecture phase. They do not justify re-imposing browser transport machinery, nor a general exactly-once protocol.

---

## A. The four routing targets

> `CHATGPT_NATIVE` is **not a tool implementation inside this repository**. It denotes capabilities already provided by the ChatGPT product. The other three are executable local routes.

### A.1 CHATGPT_NATIVE

| Aspect | Definition |
|---|---|
| **Owns** | Product-provided capabilities: web research, deep research, built-in/cloud browser, image generation/editing, vision, file upload/PDF understanding, sandboxed data analysis, charts/tables, document/spreadsheet/presentation creation, apps/connectors. |
| **Must not own** | Local repository read/write, local git ops, local test/build execution, any work that must land in the target repo. |
| **Typical inputs** | A goal or sub-goal that maps to a product capability; e.g. "research X", "generate an image", "summarize this PDF", "create a slide deck". |
| **Expected outputs** | Product result: answer, researched summary, image, artifact, document, connector operation result. |
| **Mutation behavior** | None on the local workspace (server-side action only). |
| **Approval behavior** | Governed by the ChatGPT product (connector/mutation approvals as applicable). |
| **Failure / escalation** | If the result must land in the local repo → escalate: small/bounded → `CHATGPT_DIRECT_LOCAL`; multi-file/long-running → `CODEX_DELEGATE`; combined native + local → `HYBRID`. If pure product output → done. |

### A.2 CHATGPT_DIRECT_LOCAL

| Aspect | Definition |
|---|---|
| **Owns** | Workspace-scoped local read, bounded search, small bounded edit/write, `git_status`/`git_diff`, focused safe verification. |
| **Must not own** | Multi-file coherent implementation, unknown-root-cause debugging, large refactor, long-running test/build, complex git/publish, multi-turn implementation. |
| **Typical inputs** | "read this file", "search the repo", "git status/diff", "edit this one line", "create one small config file", "run a focused verify". |
| **Expected outputs** | Workspace-scoped read results, a small diff, focused verification evidence. |
| **Mutation behavior** | Small, bounded, diff-visible, base-hash protected; gated by `mutation_owner = chatgpt`. |
| **Approval behavior** | Mutation gated by `mutation_owner`; if the change is non-trivial, escalate rather than auto-approve beyond scope. |
| **Failure / escalation** | If the change exceeds bounded scope, or root cause is unknown → escalate to `CODEX_DELEGATE`. |

### A.3 CODEX_DELEGATE

| Aspect | Definition |
|---|---|
| **Owns** | Multi-file implementation, unknown-root-cause debugging, refactor, long-running tests/builds, complex git/publish workflows, multi-turn implementation. Uses **Codex App Server** as the local executor backend. |
| **Must not own** | Pure product-capability generation (web research, image, doc creation) unless in `HYBRID`; the Brain's planning/review decisions. |
| **Typical inputs** | A milestone `TASK`: code change scope + acceptance criteria + evidence policy. |
| **Expected outputs** | Executed work + structured evidence; diff/status; test/build results. |
| **Mutation behavior** | Multi-file, coherent, diff-visible; gated by `mutation_owner = codex`. |
| **Approval behavior** | `AskForApproval` via App Server (`capabilities.experimentalApi`); gated by machine gate / Brain acceptance. |
| **Failure / escalation** | Report evidence → `REVISE`; supports `interrupt` / `resume`. |

### A.4 HYBRID (composition route)

| Aspect | Definition |
|---|---|
| **Owns** | A single logical unit that requires **both** a native ChatGPT capability **and** local workspace work. It is a **composition route**, not a fallback executor. It always resolves a **local leg** independently and hands off that leg. |
| **Must not own** | Local mutation itself — the **local leg** owns mutation as `chatgpt` (for `CHATGPT_DIRECT_LOCAL`) or `codex` (for `CODEX_DELEGATE`). `HYBRID` is **never** a mutation owner. |
| **Typical inputs** | "research + one README edit", "image generation + integration into repo", "PDF/data analysis + production pipeline implementation", "browser investigation + repo fix". |
| **Expected outputs** | Combined product result + local diff/evidence. |
| **Mutation behavior** | Delegated to the local leg; `mutation_owner` is set by the local leg (`chatgpt` or `codex`), not by `HYBRID`. |
| **Approval behavior** | Product approvals natively + local approvals on the local leg. |
| **Failure / escalation** | If the local leg exceeds bounded scope, escalate that leg to `CODEX_DELEGATE`. |

---

## B. Routing decision rules

A small, deterministic decision model — **understandable rules over opaque scoring**. The router asks the **capability questions first**, then composes.

**Conceptual order:**

- **A.** Determine whether a **native ChatGPT capability** is required.
- **B.** Determine whether a **local workspace capability** is required.
- If **BOTH** are required → `HYBRID` (composition). Then route the **local leg** independently.
- If only one is required → route that one directly.

```
ROUTE(goal):
  requiresNative  = goal needs a native ChatGPT capability
                    (web/deep research, browser, image gen/edit, vision,
                     file/PDF/data analysis, docs/spreadsheets/presentations,
                     apps/connectors)
  requiresLocal   = goal needs local workspace capability
                    (repo read/search/edit/verify, local Codex, git, publish)

  # A. native required? B. local required?
  if requiresNative and not requiresLocal:
        -> CHATGPT_NATIVE

  if not requiresNative and not requiresLocal:
        -> CHATGPT_NATIVE          # pure knowledge / creation / reasoning

  if not requiresNative and requiresLocal:
        route the local leg directly (see below)

  if requiresNative and requiresLocal:
        -> HYBRID                  # composition route, NOT a fallback executor
           then route the local leg independently (see below)

  # local leg (chosen independently)
  if read-only (no mutation):
        -> CHATGPT_DIRECT_LOCAL    (read / search / git status/diff /
                                    read_only verify only)

  if mutation small AND bounded AND exact intended change already known:
        -> CHATGPT_DIRECT_LOCAL

  if root cause unknown OR multi-file OR iterative implementation/debug/test
     cycles OR long-running:
        -> CODEX_DELEGATE

  # ownership guard (always, before any mutation)
  if mutation_owner is not none and not the requesting route:
        if operation is a mutation:   fail closed (no write; structured error)
        if operation is a read:       allowed
```

**`HYBRID` is a composition route, not a late fallback executor.** It is selected **at routing time** when BOTH native and local are required — not after a local route is chosen first. The local leg inside `HYBRID` is routed independently (read-only / known-bounded → `CHATGPT_DIRECT_LOCAL`; unknown / complex / multi-file / iterative / long-running → `CODEX_DELEGATE`). `HYBRID` is **never** a `mutation_owner`.

**Examples that MUST resolve as `HYBRID`:**
- web research + one README edit;
- image generation + integration into repo;
- PDF/data analysis + production pipeline implementation;
- browser investigation + repo fix.

### Decision inputs (the questions the router resolves)

| # | Question | Resolution hint |
|---|---|---|
| 1 | Requires native ChatGPT capability? | No + no local → `CHATGPT_NATIVE`. |
| 2 | Requires local workspace capability? | No + no native → `CHATGPT_NATIVE`. |
| 3 | BOTH native AND local required? | **Yes → `HYBRID`** (then route the local leg). |
| 4 | Mutation required? | No → `CHATGPT_DIRECT_LOCAL` (read/search/git/read_only verify). |
| 5 | Mutation small, bounded, exact change known? | Yes → `CHATGPT_DIRECT_LOCAL`. |
| 6 | Root cause unknown, multi-file, iterative, or long-running? | Yes → `CODEX_DELEGATE`. |
| 7 | Active `mutation_owner` that is not the requester? | Mutation → fail closed; read → allowed. |

**Precedence:** capability-both-then-compose. `HYBRID` has precedence over a single local route when **both** native and local are required. The local-mutation-prohibited guard always wins over capability selection. If ambiguity remains (e.g., "small" vs "multi-file" both plausible), default to the **more conservative** local leg (`CODEX_DELEGATE`) rather than a partial write.

---

## C. CHATGPT_DIRECT_LOCAL — minimum v0.2 surface

**Minimum v0.2 Direct Local surface:**

| Tool | Purpose | Safety |
|---|---|---|
| `workspace_open` | Bind an explicit workspace root before any tool. | Repo must resolve to a declared/configured root. |
| `read` | Read a workspace-scoped file. | Path confined to bound workspace. |
| `search` | Bounded search (name/pattern) inside the workspace. | No broad filesystem search; bounded output. |
| `edit` | Apply a **change-set** (small, diff-visible). | Base-hash / stale-write protection; blocked secret/cache/build paths. |
| `git_status` | Report working-tree status. | Read-only, bounded. |
| `git_diff` | Report diff of a change-set. | Diff-visible, bounded. |
| `verify` | Run a **focused, allowlisted** verification command (see `verify_effect` below). | No general bash; fixed allowlist; classified `read_only` or `workspace_effect`. |

**Separate `write`/`create` tool?** For v0.2, **no** — `edit` change-set primitives are sufficient. Creating a new small file is modeled as a change-set that adds that file. This avoids a second overlapping mutation primitive and keeps the surface minimal.

**Borrowed CodexBridge safety patterns (all required):**
- explicit workspace binding (via `workspace_open`);
- workspace-scoped paths (all tool inputs confined to the bound root);
- blocked secret/cache/build paths;
- diff-visible mutations;
- base-hash / stale-write protection;
- bounded output (no unbounded dumps);
- focused safe verification.

**No arbitrary unrestricted filesystem access** — all paths are confined to the bound workspace, secret/cache/build paths are blocked.

**Shell:** v0.2 must **not** expose a general bash tool. Provide only the narrow `verify` command backed by a **fixed allowlist** (e.g. a repo-resolved test filter, a documented linter, one build step). This keeps the Direct Local surface small and safe; anything needing general shell routes to `CODEX_DELEGATE`.

### C.1 Verification side-effect model

`verify` is **not** inherently read-only. Tests / build / lint commands may create **cache, coverage, build output, snapshots, temp files, or generated source**.

```
verify_effect = read_only | workspace_effect
```

Rules:
- **`read_only` verify** — may run **without acquiring mutation ownership only when the command is explicitly classified / allowlisted as side-effect-free.**
- **`workspace_effect` verify** — **requires the current local mutation owner** (`chatgpt` or `codex`).
- **While `codex` owns an active mutating turn**, ChatGPT Direct may continue `read` / `search` / `git_status` / `git_diff`, but **MUST NOT run Direct Local `edit` or `verify` by default**.
- **Do not build a second locking subsystem for verification** — reuse `mutation_owner`.
- Keep `verify` as a **narrow allowlisted tool**; do **not** add general bash.

---

## D. CODEX_DELEGATE — minimum MCP-facing App Server delegation surface

**Minimum v0.2 MCP-facing delegation surface:**

| MCP tool | Maps to Codex App Server concept | Behavior |
|---|---|---|
| `codex_start` | create/start a **thread** + start a **turn** | Open/reuse a Codex thread, start the first turn. |
| `codex_continue` | continuation on the **same thread** | Start the next turn on the same thread. |
| `codex_get` | `thread/read` (with `includeTurns`) | Return current thread/turn state + items. |
| `codex_interrupt` | interruption of a running **turn** | Signal the running turn to stop. |
| `codex_respond_approval` | `AskForApproval` response | Approve/deny a pending approval request. |

**Relationship to App Server concepts:**
- **thread** — a Codex conversation/session; `codex_start` creates/opens one; `codex_continue` reuses it.
- **turn** — one execution unit within a thread; `codex_start` starts the first, `codex_continue` starts the next.
- **completion** — `turn/started` + `turn/completed` notifications; `codex_get` surfaces status.
- **thread/read** — persists and returns turns/items; backing for `codex_get`.
- **approvals** — `AskForApproval` (incl. granular) requires `capabilities.experimentalApi`; `codex_respond_approval` supplies the answer.
- **interruption** — a running turn can be interrupted; `codex_interrupt` issues it.

**Hard rule:** Codex App Server **generated schema / protocol remains authoritative.** Do **not** reinvent a parallel thread/turn protocol. These MCP tools are thin facades over the App Server protocol, not a new one.

---

## E. Mutation ownership

Formalized state:

```
mutation_owner = none | chatgpt | codex
```

| Concern | Rule |
|---|---|
| **Acquisition** | When a unit starts and will mutate, set `mutation_owner` to the executing route (`chatgpt` for `CHATGPT_DIRECT_LOCAL`, `codex` for `CODEX_DELEGATE`). When the unit is read-only, leave `none`. `HYBRID` itself is never an owner. |
| **Release** | Clear to `none` on the **executor mutation unit reaching a reconciled terminal state and required post-state evidence being captured**. This is the **executor mutation unit completion**, **not** the global project/milestone `DONE`. For `codex`, ownership releases after the mutating turn/unit is reconciled — it does **not** require the whole milestone to be globally `DONE`. For `chatgpt` (`CHATGPT_DIRECT_LOCAL`), ownership releases after its bounded mutation unit is successfully applied/reconciled. |
| **Failure** | If the writer fails, do **not** silently switch owner. Mark the unit `recovery_required` (or failed); release ownership only after the state is resolved/acknowledged. |
| **Interrupt** | If `codex` owns a mutating turn and is interrupted, ownership **stays `codex`** until the interrupted turn is resolved/released. ChatGPT may read but must not mutate. |
| **Read while another owner mutates** | Read is always allowed; only **mutation** is gated. |
| **Stale ownership recovery** | On process restart, if an in-flight mutating unit cannot be resolved, keep/mark `recovery_required` and require explicit resume. Do **not** auto-reassign to a new writer without evidence. |

**v0.2 scope:** single-process / single-session. **No distributed locking design.** A cross-session lease / lock file is deferred until evidence proves concurrent writers are necessary. Verification reuses `mutation_owner` — no second locking subsystem.

---

## F. Escalation and hybrid flows

### F.1 Required transitions

| Transition | Trigger | Handoff |
|---|---|---|
| `CHATGPT_NATIVE → CHATGPT_DIRECT_LOCAL` | Product result must land as a small local edit. | Goal + small change intent + (optionally) product output. |
| `CHATGPT_DIRECT_LOCAL → CODEX_DELEGATE` | Bounded edit reveals larger scope, unknown root cause, or multi-file need. | Goal + current diff + evidence + acceptance. |
| `CHATGPT_NATIVE → CODEX_DELEGATE` | Product result must be integrated as a multi-file change. | Goal + acceptance + product output reference. |
| `CHATGPT_NATIVE → HYBRID → CODEX_DELEGATE` | Native research/image/doc + implementation. | Goal + native output reference + accept/scope; local leg routed independently. |

### F.2 Worked examples

1. **web research + one README edit:** `HYBRID` — native research leg + small local edit leg (`CHATGPT_DIRECT_LOCAL`). Owner `chatgpt` for the edit leg.
2. **inspect repo → discover large refactor → delegate Codex:** `CHATGPT_DIRECT_LOCAL` (read/search) → `CODEX_DELEGATE` (refactor). Owner `codex`.
3. **generate image → delegate Codex to integrate asset:** `HYBRID` — native image leg + `CODEX_DELEGATE` integration leg. Owner `codex` for the repo mutation.
4. **PDF/data analysis → productionize result in repo:** `HYBRID` — native analysis leg + `CODEX_DELEGATE` productionize leg. Owner `codex`.
5. **simple config edit → focused verify → done:** `CHATGPT_DIRECT_LOCAL` (edit) + `verify` (workspace_effect, requires `chatgpt` owner) → `none`. Owner `chatgpt` for the edit; verify reuses the same owner.
6. **debugging with unknown root cause → Codex from the start:** `CODEX_DELEGATE` directly. Owner `codex`.
7. **browser investigation + repo fix:** `HYBRID` — native browser leg + `CODEX_DELEGATE` (or small `CHATGPT_DIRECT_LOCAL`) fix leg.

### F.3 Context handoff (no transcript dump)

Across routes, hand off a **compact handoff blob**, never the whole ChatGPT transcript:

```
{
  goal,
  scope,                // repo path + which files/area
  evidence,             // current diff / status / test results
  acceptance,           // acceptance criteria
  risk,                 // low | medium | high
  handoffFrom           // route that produced the evidence
}
```

The local sub-route receives only the bounded contract + current evidence — enough to act, not the full Brain conversation.

---

## G. Brain Governance interaction

**Governance controls preserved (semantics only):** `PLAN`, `TASK`, `REVISE`, `REPLAN`, `ASK_USER`, `PUBLISH`, `DONE`.

**Distinction:**
- **Routing** decides **WHO / WHICH capability executes** (`CHATGPT_NATIVE` / `CHATGPT_DIRECT_LOCAL` / `CODEX_DELEGATE` / `HYBRID`).
- **Governance** decides **WHAT should happen**, acceptance criteria, evidence, whether to revise, and **when the milestone is accepted**.

Routing is the executor-selection layer that sits under Governance. Governance remains the arbitrator of correctness and acceptance.

**Do not reintroduce** (browser-transport reliability machinery):
- browser ACK protocol;
- browser nonce / retransmit;
- DOM / conversation correlation;
- composer delivery recovery;
- IAB transport-specific exactly-once machinery.

Those existed to make a brittle IAB browser path work. Replace with the **Transport identity & idempotency boundary** (§Transport identity & idempotency boundary): use native MCP/App Server identifiers + lifecycle as the primary correlation, and define only the **minimum** idempotency/reconciliation boundary required by implementation and real dogfood. Do **not** invent a general exactly-once protocol. Only governance **semantics** carry forward.

---

## H. Decision tables

### H.1 Representative routing table

| Task | Default route | Possible escalation | Mutation owner | Reason |
|---|---|---|---|---|
| Web research | `CHATGPT_NATIVE` | → `HYBRID` if result must be saved to repo | `none` | Native strength. |
| Literature research | `CHATGPT_NATIVE` | → `HYBRID` if local download | `none` | Native discovery/summary. |
| Browser task | `CHATGPT_NATIVE` | → `HYBRID` if a repo fix follows | `none` | Built-in/cloud browser native. |
| Image generation | `CHATGPT_NATIVE` | → `HYBRID` if integrate in repo | `none` | Native. |
| Image editing | `CHATGPT_NATIVE` | — | `none` | Native. |
| PDF understanding | `CHATGPT_NATIVE` | → `HYBRID` if productionize | `none` | Native. |
| Exploratory data analysis | `CHATGPT_NATIVE` (sandbox) | → `HYBRID`/`CODEX_DELEGATE` if productionize | `none` | Sandbox, no repo. |
| Doc/spreadsheet/presentation | `CHATGPT_NATIVE` | — | `none` | Native Work surface. |
| Repo inspection | `CHATGPT_DIRECT_LOCAL` | → `CODEX_DELEGATE` if large refactor found | `none` | Workspace-scoped read. |
| Code search | `CHATGPT_DIRECT_LOCAL` | — | `none` | Bounded search. |
| One-line edit | `CHATGPT_DIRECT_LOCAL` | → `CODEX_DELEGATE` if scope grows | `chatgpt` | Small bounded write. |
| Create one small config file | `CHATGPT_DIRECT_LOCAL` | — | `chatgpt` | Small change-set (add file). |
| Focused test | `CHATGPT_DIRECT_LOCAL` | → `CODEX_DELEGATE` if long/full | `none` if `read_only`; `chatgpt` if `workspace_effect` | Narrow `verify`; side-effect classified. |
| Multi-file feature | `CODEX_DELEGATE` | — | `codex` | Coherent multi-file. |
| Unknown bug | `CODEX_DELEGATE` | — | `codex` | Unknown root cause. |
| Refactor | `CODEX_DELEGATE` | — | `codex` | Large, multi-file. |
| Full test/build | `CODEX_DELEGATE` | — | `codex` | Long-running. |
| Commit | `CODEX_DELEGATE` | `CHATGPT_NATIVE` for review | `codex` | Local git. |
| Push | `CODEX_DELEGATE` | — | `codex` | Local git. |
| PR | `CODEX_DELEGATE` | `CHATGPT_NATIVE` for review | `codex` | Local git + native review. |
| Release | `CODEX_DELEGATE` | — | `codex` | Local git + publish gate. |
| Mixed research + coding | `HYBRID` | → `CODEX_DELEGATE` (local leg) | `chatgpt` / `codex` | Research native + code local; local leg routed independently. |
| Mixed image + coding | `HYBRID` | → `CODEX_DELEGATE` (local leg) | `chatgpt` / `codex` | Image native + integrate local. |
| Mixed data analysis + production pipeline | `HYBRID` | → `CODEX_DELEGATE` (local leg) | `codex` | Analysis native + production pipeline local. |

---

## I. Product scope (minimal)

### MUST HAVE (first v0.2 implementation)
- Four-route router with the §B deterministic rules (capability-both-then-compose; `HYBRID` as composition route).
- `CHATGPT_DIRECT_LOCAL` minimal surface: `workspace_open`, `read`, `search`, `edit`, `git_status`, `git_diff`, `verify` (narrow allowlist, **no general bash**).
- `verify_effect = read_only | workspace_effect` classification for the `verify` tool.
- `CODEX_DELEGATE` surface: `codex_start`, `codex_get`, `codex_continue`, `codex_interrupt`, `codex_respond_approval` (thin facades over Codex App Server).
- `mutation_owner = none | chatgpt | codex` state field + §E rules (single-session; verification reuses the owner, no second lock).
- Base-hash / stale-write protection + diff-visible writes.
- Transport composition: Custom MCP App + Secure Tunnel (brain-to-local) → orchestration bridge → Codex App Server.
- Transport identity & idempotency boundary as the minimum correlation/reconciliation model (no general exactly-once).

### SHOULD HAVE (after dogfood)
- change-set **preview / apply / rollback** primitive (observe → apply → rollback).
- **operation journal** (append-only audit).
- **tool-surface tiers** (`minimal / standard / full`) mapped to `verificationPolicy`/risk.
- **subagent** support at the delegate layer (unverified; add only if needed).
- deeper HYBRID flow primitives / richer handoff blob.

### DEFER
- distributed lock / cross-session **lease** (until evidence proves concurrent writers).
- general **bash** tool (only the narrow `verify` in v0.2).
- separate `write`/`create` tool (change-set primitive is sufficient).
- turning v0.2 into a full local IDE or another Codex implementation.
- reimplementing ChatGPT-native capabilities (image, research, docs, connectors).
- a general end-to-end exactly-once protocol (only a minimum reconciliation boundary is defined here).

---

## Sources / cross-references

- [`docs/rfc-v0.2-chatgpt-native-capability-inventory.md`](rfc-v0.2-chatgpt-native-capability-inventory.md) — accepted N0 inventory (transport layering, evidence model, ownership rule).
- [`docs/architecture.md`](architecture.md) — current Alpha.3/Alpha.4 state.
- [`docs/development-history.md`](development-history.md) — historical notes.
- Codex App Server spike (local oracle): `codex-cli 0.146.0`, `codex app-server --listen stdio://crypto`, `capabilities.experimentalApi`, `thread/read {includeTurns:true}`, `TurnStatus`.
- CodexBridge (pattern reference): https://github.com/naplesblue/codexbridge.

---

*This RFC is design input only. No runtime/source/version changes were made. Revision r1 fixes HYBRID routing precedence (composition, not late fallback), removes the exactly-once overclaim in favour of a minimum reconciliation boundary, adds a `verify_effect` side-effect model, and clarifies ownership release (executor unit completion vs global Brain DONE). The N0 inventory references this document as `rfc-v0.2-capability-routing`.*
