# RFC: v0.2 — Capability Routing

- **Status:** Proposed design input — no implementation
- **Target version:** v0.2 (Routing contract; does **not** implement runtime behavior)
- **Relates to:** [`docs/rfc-v0.2-chatgpt-native-capability-inventory.md`](rfc-v0.2-chatgpt-native-capability-inventory.md) (accepted N0 inventory)
- **Date:** 2026-09-01 · N1
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

**Notation / evidence:** `OFFICIAL_SUPPORT` vs `OBSERVED_LOCAL` follow the N0 RFC. Plan-tier availability is marked `gate` (unverified). Nothing here assumes a distributed lock or extra transport reliability; the MCP/App Server transport already provides exactly-once behavior.

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
| **Failure / escalation** | If the result must land in the local repo → escalate: small/bounded → `CHATGPT_DIRECT_LOCAL`; multi-file/long-running → `CODEX_DELEGATE`; combined → `HYBRID`. If pure product output → done. |

### A.2 CHATGPT_DIRECT_LOCAL

| Aspect | Definition |
|---|---|
| **Owns** | Workspace-scoped local read, bounded search, small bounded edit/write, `git_status`/`git_diff`, focused safe verification. |
| **Must not own** | Multi-file coherent implementation, unknown-root-cause debugging, large refactor, long-running test/build, complex git/publish, multi-turn implementation. |
| **Typical inputs** | "read this file", "search the repo", "git status/diff", "edit this one line", "create one small config file", "run the focused test". |
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

### A.4 HYBRID

| Aspect | Definition |
|---|---|
| **Owns** | A single logical unit that needs **both** a product capability **and** local work. Splits: product capability natively (research/image/doc) + local mutation (`CHATGPT_DIRECT_LOCAL` if small, else `CODEX_DELEGATE`). |
| **Must not own** | An unclear split; an implicit handoff of the whole ChatGPT transcript. |
| **Typical inputs** | "research + local edit", "image + integrate asset", "data analysis + productionize in repo". |
| **Expected outputs** | Combined product result + local diff/evidence. |
| **Mutation behavior** | Delegated to the local sub-route; `mutation_owner` set accordingly. |
| **Approval behavior** | Product approvals natively + local approvals on the local sub-route. |
| **Failure / escalation** | If the local part exceeds bounded scope, escalate that sub-route to `CODEX_DELEGATE`. |

---

## B. Routing decision rules

A small, deterministic decision model — **understandable rules over opaque scoring**. The router asks the following **in order**; the first matching outcome wins.

```
ROUTE(goal):
  if goal requires a native ChatGPT capability AND no local mutation is needed:
        -> CHATGPT_NATIVE

  if goal does NOT require local repository access AND is pure knowledge/creation:
        -> CHATGPT_NATIVE

  if goal requires local repository access:
        if mutation is NOT required:
              -> CHATGPT_DIRECT_LOCAL        (read / search / git status/diff / verify)

        if mutation IS required:
              if mutation is small AND bounded AND the exact intended change is already known:
                    -> CHATGPT_DIRECT_LOCAL

              if root cause is unknown OR work is multi-file OR requires iterative
                 implementation/debug/test cycles OR is long-running:
                    -> CODEX_DELEGATE

  if goal requires BOTH a native ChatGPT capability AND local mutation:
        -> HYBRID (then route the local sub-part by the above local rules)

  # ownership guard (always, before any mutation)
  if mutation_owner is not none and not the requesting route:
        if operation is a mutation:   fail closed (no write; structured error)
        if operation is a read:       allowed
```

### Decision inputs (the questions the router resolves)

| # | Question | Resolution hint |
|---|---|---|
| 1 | Requires local repository access? | No → native route. |
| 2 | Requires mutation? | No → `CHATGPT_DIRECT_LOCAL` read/verify. |
| 3 | Mutation small and bounded? | Yes → `CHATGPT_DIRECT_LOCAL`. |
| 4 | Exact intended change already known? | Yes + small → `CHATGPT_DIRECT_LOCAL`. |
| 5 | Root cause unknown? | Yes → `CODEX_DELEGATE`. |
| 6 | Multi-file? | Yes → `CODEX_DELEGATE`. |
| 7 | Iterative impl/debug/test cycles? | Yes → `CODEX_DELEGATE`. |
| 8 | Long-running? | Yes → `CODEX_DELEGATE`. |
| 9 | Native capability needed (web/deep research, browser, image gen/edit, vision, doc/data analysis, apps/connectors)? | Yes + no local mutation → `CHATGPT_NATIVE`. |
| 10 | Local Codex capability needed (shell, multi-file, long-running, publish)? | Yes → `CODEX_DELEGATE`. |
| 11 | Active `mutation_owner` that is not the requester? | Mutation → fail closed; read → allowed. |

**Precedence:** local-mutation-prohibited guard always wins over capability selection. If ambiguity remains (e.g., "small" vs "multi-file" both plausible), default to the **more conservative** route (`CODEX_DELEGATE`) rather than a partial write.

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
| `verify` | Run a **focused, allowlisted** verification command. | No general bash; fixed allowlist. |

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
| **Acquisition** | When a unit starts and will mutate, set `mutation_owner` to the executing route (`chatgpt` for `CHATGPT_DIRECT_LOCAL`, `codex` for `CODEX_DELEGATE`). When the unit is read-only, leave `none`. |
| **Release** | On unit completion / `DONE`, clear to `none`. |
| **Failure** | If the writer fails, do **not** silently switch owner. Mark the unit `recovery_required` (or failed); release ownership only after the state is resolved/acknowledged. |
| **Interrupt** | If `codex` owns a mutating turn and is interrupted, ownership **stays `codex`** until the interrupted turn is resolved/released. ChatGPT may read but must not mutate. |
| **Read while another owner mutates** | Read is always allowed; only **mutation** is gated. |
| **Stale ownership recovery** | On process restart, if an in-flight mutating unit cannot be resolved, keep/mark `recovery_required` and require explicit resume. Do **not** auto-reassign to a new writer without evidence. |

**v0.2 scope:** single-process / single-session. **No distributed locking design.** A cross-session lease / lock file is deferred until evidence proves concurrent writers are necessary.

---

## F. Escalation and hybrid flows

### F.1 Required transitions

| Transition | Trigger | Handoff |
|---|---|---|
| `CHATGPT_NATIVE → CHATGPT_DIRECT_LOCAL` | Product result must land as a small local edit. | Goal + small change intent + (optionally) product output. |
| `CHATGPT_DIRECT_LOCAL → CODEX_DELEGATE` | Bounded edit reveals larger scope, unknown root cause, or multi-file need. | Goal + current diff + evidence + acceptance. |
| `CHATGPT_NATIVE → CODEX_DELEGATE` | Product result must be integrated as a multi-file change. | Goal + acceptance + product output reference. |
| `CHATGPT_NATIVE → HYBRID → CODEX_DELEGATE` | Native research/image/doc + implementation. | Goal + native output reference + accept/scope. |

### F.2 Worked examples

1. **research → small README edit:** `CHATGPT_NATIVE` (research) → `CHATGPT_DIRECT_LOCAL` (small edit). Owner `chatgpt` for the edit.
2. **inspect repo → discover large refactor → delegate Codex:** `CHATGPT_DIRECT_LOCAL` (read/search) → `CODEX_DELEGATE` (refactor). Owner `codex`.
3. **generate image → delegate Codex to integrate asset:** `CHATGPT_NATIVE` (image) → `HYBRID` → `CODEX_DELEGATE` (integrate). Owner `codex` for the repo mutation.
4. **PDF/data analysis → productionize result in repo:** `CHATGPT_NATIVE` (PDF/data analysis) → `CODEX_DELEGATE` (productionize). Owner `codex`.
5. **simple config edit → focused verify → done:** `CHATGPT_DIRECT_LOCAL` (edit) + `verify` (focused) → `none`. Owner `chatgpt` for the edit.
6. **debugging with unknown root cause → Codex from the start:** `CODEX_DELEGATE` directly. Owner `codex`.

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

Those existed to make a brittle IAB browser path work; MCP/App Server already provides the needed reliability. Only governance **semantics** carry forward.

---

## H. Decision tables

### H.1 Representative routing table

| Task | Default route | Possible escalation | Mutation owner | Reason |
|---|---|---|---|---|
| Web research | `CHATGPT_NATIVE` | → `CHATGPT_DIRECT_LOCAL` if result must be saved | `none` | Native strength. |
| Literature research | `CHATGPT_NATIVE` | → `HYBRID` if local download | `none` | Native discovery/summary. |
| Browser task | `CHATGPT_NATIVE` | — | `none` | Built-in/cloud browser native. |
| Image generation | `CHATGPT_NATIVE` | → `HYBRID` if integrate in repo | `none` | Native. |
| Image editing | `CHATGPT_NATIVE` | — | `none` | Native. |
| PDF understanding | `CHATGPT_NATIVE` | — | `none` | Native. |
| Exploratory data analysis | `CHATGPT_NATIVE` (sandbox) | → `CODEX_DELEGATE` if must productionize | `none` | Sandbox, no repo. |
| Doc/spreadsheet/presentation | `CHATGPT_NATIVE` | — | `none` | Native Work surface. |
| Repo inspection | `CHATGPT_DIRECT_LOCAL` | → `CODEX_DELEGATE` if large refactor found | `none` | Workspace-scoped read. |
| Code search | `CHATGPT_DIRECT_LOCAL` | — | `none` | Bounded search. |
| One-line edit | `CHATGPT_DIRECT_LOCAL` | → `CODEX_DELEGATE` if scope grows | `chatgpt` | Small bounded write. |
| Create one small config file | `CHATGPT_DIRECT_LOCAL` | — | `chatgpt` | Small change-set (add file). |
| Focused test | `CHATGPT_DIRECT_LOCAL` | → `CODEX_DELEGATE` if long/full | `none` (read/verify) | Narrow `verify`. |
| Multi-file feature | `CODEX_DELEGATE` | — | `codex` | Coherent multi-file. |
| Unknown bug | `CODEX_DELEGATE` | — | `codex` | Unknown root cause. |
| Refactor | `CODEX_DELEGATE` | — | `codex` | Large, multi-file. |
| Full test/build | `CODEX_DELEGATE` | — | `codex` | Long-running. |
| Commit | `CODEX_DELEGATE` | `CHATGPT_NATIVE` for review | `codex` | Local git. |
| Push | `CODEX_DELEGATE` | — | `codex` | Local git. |
| PR | `CODEX_DELEGATE` | `CHATGPT_NATIVE` for review | `codex` | Local git + native review. |
| Release | `CODEX_DELEGATE` | — | `codex` | Local git + publish gate. |
| Mixed research + coding | `HYBRID` | → `CODEX_DELEGATE` | depends | Research native + code local. |
| Mixed image + coding | `HYBRID` | → `CODEX_DELEGATE` | depends | Image native + integrate local. |
| Mixed data analysis + production pipeline | `HYBRID` | → `CODEX_DELEGATE` | `codex` | Analysis native + pipeline local. |

---

## I. Product scope (minimal)

### MUST HAVE (first v0.2 implementation)
- Four-route router with the §B deterministic rules.
- `CHATGPT_DIRECT_LOCAL` minimal surface: `workspace_open`, `read`, `search`, `edit`, `git_status`, `git_diff`, `verify` (narrow allowlist, **no general bash**).
- `CODEX_DELEGATE` surface: `codex_start`, `codex_get`, `codex_continue`, `codex_interrupt`, `codex_respond_approval` (thin facades over Codex App Server).
- `mutation_owner = none | chatgpt | codex` state field + §E rules (single-session).
- Base-hash / stale-write protection + diff-visible writes.
- Transport composition: Custom MCP App + Secure Tunnel (brain-to-local) → orchestration bridge → Codex App Server.

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

---

## Sources / cross-references

- [`docs/rfc-v0.2-chatgpt-native-capability-inventory.md`](rfc-v0.2-chatgpt-native-capability-inventory.md) — accepted N0 inventory (transport layering, evidence model, ownership rule).
- [`docs/architecture.md`](architecture.md) — current Alpha.3/Alpha.4 state.
- [`docs/development-history.md`](development-history.md) — historical notes.
- Codex App Server spike (local oracle): `codex-cli 0.146.0`, `codex app-server --listen stdio://crypto`, `capabilities.experimentalApi`, `thread/read {includeTurns:true}`, `TurnStatus`.
- CodexBridge (pattern reference): https://github.com/naplesblue/codexbridge.

---

*This RFC is design input only. No runtime/source/version changes were made. It finalizes for v0.2 the Routing contract; the N0 inventory references this document as `rfc-v0.2-capability-routing` (naming corrected to stay within product v0.2).*
