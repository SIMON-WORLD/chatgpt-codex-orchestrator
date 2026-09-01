# RFC: v0.2 — ChatGPT-Native Capability Inventory

- **Status:** Research / Proposed design input — no implementation (Revision 1)
- **Target version:** v0.2 (pre-redesign inventory; does **not** implement v0.2)
- **Scope:** evidence-backed inventory of ChatGPT-native capabilities to **reuse** (not reimplement), CodexBridge reusable patterns, Codex delegate capabilities, a routing matrix, and a minimal workspace ownership rule.
- **Date:** 2026-09-01 · Revised per Brain REVISE `v0.2-n0-...-001-r1`.
- **Artifact:** this document only, under `docs/`. No runtime/source change, no version bump, no release.

---

## 0. Purpose and constraints

This is a **research / architecture** RFC. It precedes the actual v0.2 redesign. Its only deliverable is this document.

Established by prior proof-of-concept (evidence, not assumption — see §Sources):

1. **ChatGPT Web and Desktop ordinary Chat** can invoke a **Custom MCP App** through the **OpenAI Secure Tunnel** and perform real **local read / write / readback**. This is the observed baseline that makes "ChatGPT as Brain over a local MCP" viable.
2. A **local MCP bridge** can control **Codex through Codex App Server**: `initialize`, `thread/start`, `turn/start`, streamed completion (`turn/started`, `turn/completed`), `thread/read` (with `includeTurns`), same-thread continuation, and clean shutdown. This is the observed baseline that makes "Codex as local Delegate" viable.
3. The **Alpha.4 in-app browser (IAB) transport** is **no longer assumed** to be the future canonical transport. It is a candidate among several, not the default.

**The intended v0.2 architecture is a capability router, not "ChatGPT OR Codex":**

```
ChatGPT Capability Router
├─ CHATGPT_NATIVE         (server-side ChatGPT features reuse)
├─ CHATGPT_DIRECT_LOCAL   (local read/search/small-edit/verify via local MCP)
├─ CODEX_DELEGATE         (multi-file/debug/refactor/long-running/compile via App Server)
└─ HYBRID                 (combined research + local work, with ownership boundary)
```

### Evidence model

Two distinct classes of evidence are kept **separate** throughout:

| Class | Definition |
|---|---|
| `OFFICIAL_SUPPORT` | What OpenAI **currently documents / guarantees** by plan & surface. |
| `OBSERVED_LOCAL` | What was **actually verified** on this user's Plus environment on **2026-09-01**. |

`OBSERVED_LOCAL` is scoped to this machine/account/date and must **not** be generalized into a claim that every Plus account behaves the same.

**Observed local evidence (2026-09-01):**
- ordinary ChatGPT **Web** Chat can invoke a **Developer Mode Custom MCP App** via the **OpenAI Secure Tunnel**;
- `probe_read` → **PASS**;
- modifying `probe_write` → **PASS**;
- `probe_read_written` → **PASS**;
- actual **local filesystem readback** → **PASS**;
- ordinary ChatGPT **Desktop** Chat can invoke the same Custom MCP App and perform the **modifying** action successfully.

These observations support the `CHATGPT_DIRECT_LOCAL` capability claim on this environment; they are **not** evidence of universal Plus behavior.

### Notation

| Mark | Meaning |
|---|---|
| `✓` | documented / officially supported (`OFFICIAL_SUPPORT`) |
| `obs` | observed verified locally on 2026-09-01 (`OBSERVED_LOCAL`) |
| `gate` | plan-gated; specific tier availability **unverified** |
| `?` | not documented here / unverified |
| `—` | not applicable |

**Surfaces:** `Web` = chatgpt.com; `Desktop` = ChatGPT desktop app; `Work` = ChatGPT for Work/Enterprise; `Codex` = the Codex agent/runtime as an executor surface.

**Routing roles (used consistently):** `CHATGPT_NATIVE` · `CHATGPT_DIRECT_LOCAL` · `CODEX_DELEGATE` · `HYBRID`.

---

## Transport & backend layering

**Custom MCP App + Secure Tunnel** and **Codex App Server** are **not alternative default transports**. They are **separate layers** that compose:

```
ChatGPT Web/Desktop
  → Custom MCP App
  → OpenAI Secure Tunnel
  → local MCP / orchestration bridge
  → Codex App Server
  → Codex
```

| Layer | Role |
|---|---|
| **Custom MCP App + Secure Tunnel** | **Brain-to-local transport.** The channel that carries Brain (ChatGPT) commands/results to the local orchestrator bridge. |
| **local MCP / orchestration bridge** | The orchestrator's local surface that routes a command to the right local backend. |
| **Codex App Server** | **Local executor backend / machine-control protocol for Codex.** The protocol that actually drives a local Codex thread (thread/turn/session). |

Consequence: there is **no "pick Custom MCP App vs Codex App Server" default decision** — both are needed for the full chain. Custom MCP App is the Brain-to-local transport; Codex App Server is the local executor backend.

---

## A. ChatGPT Native Capability Inventory

> Rule applied throughout: **Where a capability is a strong, already-productized ChatGPT feature, reuse it.** Where it requires **local repo/filesystem read or a small bounded write**, it may still be served by `CHATGPT_DIRECT_LOCAL` (workspace-scoped). Where it requires **multi-file mutation, unknown-root-cause debugging, large refactor, or long-running compile/test**, it must route to `CODEX_DELEGATE`. The safety boundary is **execution ownership** (`mutation_owner`), not a blanket write prohibition.

### A.1 Core reasoning / context

| Capability | Source | Web | Desktop | Work | Codex | Read | Mutate | Async | Approval | Stay native | Wrap? | Routing role |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Reasoning / normal Chat | [1] | ✓ | ✓ | ✓ | — | ✓ | ✓ (reply only) | — | — | yes | no | `CHATGPT_NATIVE` |
| Projects (project context / shared memory) | [2] | ✓ | ✓ | ✓ | — | ✓ | ✓ (project-bound) | — | — | yes | optionally expose read | `CHATGPT_NATIVE` |
| Memory / knowledge within a project | [2] | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | — | yes | maybe read into context | `CHATGPT_NATIVE` |

### A.2 Research & browsing

| Capability | Source | Web | Desktop | Work | Codex | Read | Mutate | Async | Approval | Stay native | Wrap? | Routing role |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Web search | [3] | ✓ | ✓ | ✓ | — | ✓ | — | — | — | yes | no | `CHATGPT_NATIVE` |
| Deep research | [4] | ✓ | ✓ | ✓ | — | ✓ | — | ✓ (long-running) | — | yes | no | `CHATGPT_NATIVE` |
| Built-in browser | [5] | ✓ | ✓ | ✓ | — | ✓ | ✓ (in-page) | — | — | yes | no | `CHATGPT_NATIVE` |
| Cloud browser (Work) | [6] | ✓ | ✓ | ✓ | — | ✓ | ✓ (sandboxed) | ✓ (async sessions) | — | yes | no | `CHATGPT_NATIVE` |

### A.3 Media

| Capability | Source | Web | Desktop | Work | Codex | Read | Mutate | Async | Approval | Stay native | Wrap? | Routing role |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Image generation | [7] | ✓ | ✓ | ✓ | — | — | ✓ | ✓ (queued) | — | yes | no | `CHATGPT_NATIVE` |
| Image editing | [7] | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | — | yes | no | `CHATGPT_NATIVE` |
| Vision / image understanding | [7] | ✓ | ✓ | ✓ | (codex-adjacent) | ✓ | — | — | — | yes | no | `CHATGPT_NATIVE` |
| Voice | [9] | obs | ✓ | ✓ | — | — | ✓ | — | — | yes | no | `CHATGPT_NATIVE` |

### A.4 Document ingestion & creation

| Capability | Source | Web | Desktop | Work | Codex | Read | Mutate | Async | Approval | Stay native | Wrap? | Routing role |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| File upload / PDF understanding | [8] | ✓ | ✓ | ✓ | — | ✓ | — | — | — | yes | no | `CHATGPT_NATIVE` |
| Data analysis / Python (notebook) | [8] | ✓ | ✓ | ✓ | — | ✓ | ✓ (sandbox) | ✓ | — | yes | no | `CHATGPT_NATIVE` |
| Charts / tables | [8] | ✓ | ✓ | ✓ | — | ✓ | ✓ (sandbox) | — | — | yes | no | `CHATGPT_NATIVE` |
| Documents (create/edit) | [10] | ✓ | ✓ | ✓ | — | ✓ | ✓ (Workspace) | — | — | yes | no | `CHATGPT_NATIVE` |
| Spreadsheets (create/edit) | [10] | ✓ | ✓ | ✓ | — | ✓ | ✓ (Workspace) | — | — | yes | no | `CHATGPT_NATIVE` |
| Presentations (create/edit) | [10] | ✓ | ✓ | ✓ | — | ✓ | ✓ (Workspace) | — | — | yes | no | `CHATGPT_NATIVE` |

**Important distinction.** ChatGPT `data analysis / Python` sandbox is **stateless and sandboxed** — it is **not** a local repo executor. It is excellent for *exploratory* analysis and quick charts, but it **cannot** mutate a local git worktree. Any task that must edit a **local repository** uses either `CHATGPT_DIRECT_LOCAL` (small bounded edit) or `CODEX_DELEGATE` (multi-file/debug/refactor). Document/spreadsheet/presentation creation is a strong ChatGPT-native surface (especially Work) and should **not** be reimplemented locally.

### A.5 Apps / integrations

| Capability | Source | Web | Desktop | Work | Codex | Read | Mutate | Async | Approval | Stay native | Wrap? | Routing role |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Apps / Plugins / Connectors | [11] | ✓ | ✓ | ✓ | — | ✓ | ✓ (via connector) | ✓ | gate | yes | no | `CHATGPT_NATIVE` |
| GitHub integration | [12] | ✓ | ✓ | ✓ | — | ✓ | ✓ (repo ops via connector) | ✓ | gate | yes | optionally | `CHATGPT_NATIVE` / `HYBRID` |
| Gmail / Calendar / Drive / Notion / Slack style | [11] | ✓ | ✓ | ✓ | — | ✓ | ✓ (via connector) | ✓ | gate | yes | no | `CHATGPT_NATIVE` |
| **Custom MCP Apps** | [13] | ✓ | obs | obs | — | ✓ | ✓ (via MCP tool) | ✓ (streamable) | gate | yes | **YES — brain-to-local transport** | `CHATGPT_DIRECT_LOCAL` |
| **Secure MCP Tunnel** | [14] | ✓ | obs | obs | — | ✓ | ✓ (via tunnel) | ✓ | gate | yes | **YES** | `CHATGPT_DIRECT_LOCAL` |

**This is the pivotal cluster.** The combination of **Custom MCP Apps + Secure MCP Tunnel** is the **Brain-to-local transport** that makes "ChatGPT Brain over a local MCP" real — and it is the observed mechanism (on 2026-09-01) by which a ChatGPT conversation reaches a local server and, via the orchestration bridge, a local Codex App Server.

### A.6 Automation & monitoring

| Capability | Source | Web | Desktop | Work | Codex | Read | Mutate | Async | Approval | Stay native | Wrap? | Routing role |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Scheduled tasks / monitoring | [15] | ✓ | ✓ | ✓ | — | ✓ | ✓ (scheduler) | ✓ | gate | yes | optionally observe | `CHATGPT_NATIVE` (monitoring) / `HYBRID` (monitor + local action) |

---

## B. Local / direct coding capability patterns (CodexBridge)

`naplesblue/codexbridge` is a strong reference for **"ChatGPT as Brain over a local coding agent via MCP + tunnel."** We studied it as a pattern source. **It is not our target architecture** — but its **Direct Local execution model** is a **first-class source of patterns**, specifically for `CHATGPT_DIRECT_LOCAL`. CodexBridge's direct tools should inform the `CHATGPT_DIRECT_LOCAL` branch, not be treated mainly as fallback behavior.

| Pattern | Reference | Classify | Rationale |
|---|---|---|---|
| Workspace-scoped `read` | CodexBridge | `REUSE` | Bound reads to a configured workspace root; deterministic, safe, cheap. Feeds `CHATGPT_DIRECT_LOCAL`. |
| Workspace-scoped `write` / `edit` returning diffs | CodexBridge | `REUSE` | Any local write must be workspace-scoped and diff-visible; **small bounded edit** uses this. |
| `open_workspace` (bind a root before tool use) | CodexBridge | `REUSE` | An explicit "which repo am I in" step is a clean ownership anchor. |
| `search` / `tree` (bounded) | CodexBridge | `REUSE` | Bounded repo discovery — no broad filesystem search. Feeds `CHATGPT_DIRECT_LOCAL`. |
| Safe bash (allowlist) | CodexBridge | `ADAPT` | Allowlist approach is good; our `danger-full-access` policy differs by task risk. Keep the *principle*, tune per repo. |
| `git_status` / `git_diff` | CodexBridge | `REUSE` | Deterministic repo-state reporter; core to `CHATGPT_DIRECT_LOCAL` read/verify and evidence gates. |
| `preview_change_set` / `apply_change_set` (base-hash checks) | CodexBridge | `REUSE` | **Base-hash protection** guards against stale applied changes; used by both local write paths. |
| `preview_rollback_change_set` / rollback | CodexBridge | `ADAPT` | Valuable but only where a true git snapshot is available; keep it git-backed, not custom state. |
| `operation_journal` | CodexBridge | `REUSE` | Append-only operation log is a good audit/observability primitive. |
| `task_brief` / `plan` / `verify` / `report` / `resume` | CodexBridge | `ADAPT` | The *shape* (brief → plan → verify → report) is right; the orchestrator owns plan/verification authority. |
| Skill / AGENTS context (`load_skill`, `codex_context`) | CodexBridge | `REUSE` | Loading repo `AGENTS.md` / skill context deterministically is a proven, cheap pattern. |
| `minimal` / `standard` / `full` tool surfaces | CodexBridge | `ADAPT` | Tiered tool surface maps to our `verificationPolicy` / risk tiers and to `mutation_owner` scope. |
| `approval_review` | CodexBridge | `REUSE` | Structured approval gate maps cleanly to our `ASK_USER` / approval requirement. |
| `handoff_to_agent` / `handoff_to_codex` (CLI `execute-handoff` / `watch-handoff`) | CodexBridge | `DO_NOT_COPY` | CLI-only handoff is not our model and conflicts with a single-turn control loop. |
| `export_pro_context` | CodexBridge | `ADAPT` | Serializing context is useful; we already do compact deltas, so this is optional. |
| `server_config` | CodexBridge | `ADAPT` | Config is useful, but our canonical launcher/config path already exists. |
| Token-protected URLs / not OS sandbox | CodexBridge | `ADAPT` | Token auth is good; "not OS sandbox" is a limitation we improve with workspace-write sandboxing. |

**Key take-aways from CodexBridge:**
1. **Bind a workspace explicitly first** (`open_workspace`) — the cleanest ownership anchor.
2. **Base-hash protection** on every change-set — prevents applying stale edits.
3. **Diffs, always** — the Brain/reviewer needs to see exactly what changed.
4. **Tiered tool surfaces** — minimal by default, expand on explicit need.
5. **Operation journal / audit** — cheap and gives the Brain evidence.

These patterns directly inform **both** local write branches (`CHATGPT_DIRECT_LOCAL` for bounded ops and `CODEX_DELEGATE` for multi-file/long-running ops).

---

## C. Codex Delegate capability inventory

Using the completed Codex App Server spike + official schema. **Codex App Server is the local executor backend / machine-control protocol for Codex** (see Transport & backend layering).

| Capability | Available | Notes / evidence |
|---|---|---|
| **Thread / turn lifecycle** | ✓ | `thread/start`, `turn/start`, `thread/read`, `turn/started`, `turn/completed`; same-thread continuation proven. |
| **Sandbox modes** | ✓ | `SandboxMode = read-only \| workspace-write \| danger-full-access`. Default to `workspace-write`. |
| **Shell** | ✓ | Via `danger-full-access` (and gated approve) — allowlist-recommended. |
| **Filesystem mutation** | ✓ | Via `workspace-write`; workspace-scoped, diff-visible. |
| **git** | ✓ | Local git operations: status/diff/commit/push/PR. |
| **tests / build** | ✓ | Run arbitrary test/build commands in a turn; report status + evidence. |
| **Approvals** | ✓ | `AskForApproval` (incl. granular) requires `capabilities.experimentalApi`. |
| **Interrupt** | ✓ | `TurnStatus` includes `interrupted`; a running turn can be interrupted. |
| **Resume** | ✓ | Same-thread continuation; re-open existing thread. |
| **Skills / AGENTS** | ✓ | Load repo `AGENTS.md` / skill context deterministically. |
| **Subagents** | ? | Not established via app-server in this spike; treat as unverified at this layer. |
| **Long-running work** | ✓ | Long-running turns supported; durable thread + `thread/read` for progress. |
| **Publishing workflows** | ✓ | git commit/push/PR/tag/release via shell (`danger-full-access`), gate-driven. |

**Codex is preferred for** multi-file implementation, unknown-root-cause debugging, large refactors, long-running tests/builds, complex git/publish workflows, and multi-turn implementation. It is the **only** surface that coherently mutates a local source tree across many files and long-running work. It does **not** own everything small — bounded local read/search/small-edit/verify is `CHATGPT_DIRECT_LOCAL`.

**Baseline recorded (spike):** `codex-cli 0.146.0`; app-server launch `codex app-server --listen stdio://crypto`; protocol async via `capabilities.experimentalApi`.

---

## D. Routing matrix (representative tasks)

> Reading/searching/git-status/diff, small bounded edits, and simple focused verification default to **`CHATGPT_DIRECT_LOCAL`**. Multi-file implementation, unknown-root-cause debugging, large refactor, and long-running compile/test default to **`CODEX_DELEGATE`**. Combined research + local work defaults to **`HYBRID`**. `mutation_owner` gates who may mutate.

| Representative task | Default executor | Rationale |
|---|---|---|
| Web research (general) | `CHATGPT_NATIVE` | Web search/deep research are native strengths. |
| Literature research | `CHATGPT_NATIVE` (+ `HYBRID` when downloading) | Discovery + summarization native; local file download needs a local executor. |
| Image generation / editing | `CHATGPT_NATIVE` | Native, not reimplemented. |
| PDF analysis (uploaded doc) | `CHATGPT_NATIVE` | File upload + PDF understanding native. |
| Exploratory data analysis | `CHATGPT_NATIVE` (sandbox) | Sandbox Python/charts native; no local repo needed. |
| Production data pipeline | `CODEX_DELEGATE` | Must mutate local repo/scripts consistently across files/long-running. |
| **Inspect repository (read)** | `CHATGPT_DIRECT_LOCAL` | Workspace-scoped read; no mutation. |
| **Search repository** | `CHATGPT_DIRECT_LOCAL` | Bounded search; no mutation. |
| **git status / git diff** | `CHATGPT_DIRECT_LOCAL` | Deterministic repo-state reporter. |
| **Small bounded text edit** | `CHATGPT_DIRECT_LOCAL` | Workspace-scoped, diff-visible, single small write. |
| **Simple focused verification** | `CHATGPT_DIRECT_LOCAL` | Run a focused check under `mutation_owner`; report evidence. |
| Multi-file implementation | `CODEX_DELEGATE` | Coherent milestone TASK executed in one repo. |
| Debugging unknown root cause | `CODEX_DELEGATE` | Turn-local exploration + test, reporter of evidence. |
| Large refactor | `CODEX_DELEGATE` | Multi-file, test-gated, diff-visible. |
| Run tests | `CODEX_DELEGATE` | Tests live in repo; executor runs them (or `CHATGPT_DIRECT_LOCAL` for a focused check). |
| commit / push / PR | `CODEX_DELEGATE` (+ `CHATGPT_NATIVE` review) | Publishing is local git; release/PR review can be native. |
| Browser interaction (web pages) | `CHATGPT_NATIVE` | Built-in / cloud browser native. |
| Create document / spreadsheet / presentation | `CHATGPT_NATIVE` | Native Work surface, not reimplemented. |
| **Research + local edit** | `HYBRID` | Research native; small local edit via `CHATGPT_DIRECT_LOCAL`; explicit ownership boundary. |
| **Research / image / document + implementation** | `HYBRID` | Research/image/doc native; implementation via `CODEX_DELEGATE`; explicit ownership boundary. |

---

## E. Workspace ownership rule

**Recommendation:** a **minimal, single-owner** model, **no distributed lock** unless evidence proves one necessary.

```
mutation_owner = none | chatgpt | codex
```

- `none` — no active mutation owned; the workspace is stable (initial / post-DONE).
- `chatgpt` — the **`CHATGPT_DIRECT_LOCAL`** side owns workspace mutation for the current unit.
- `codex` — the **`CODEX_DELEGATE`** side owns workspace mutation for the current unit.

**The safety boundary is execution ownership, not a blanket write prohibition.** ChatGPT may read/search/review at any time; only **mutation** is gated by `mutation_owner`.

**Rules (smallest viable):**
1. Exactly **one** `mutation_owner` at a time per target repo / workspace.
2. A unit (a TASK or a Brain control) starts with `mutation_owner` set to the executor that will mutate; it is cleared to `none` on unit completion / DONE.
3. A writer must be the current `mutation_owner`. A non-owner attempting a mutation fails closed (no-op + structured error).
4. **When `codex` owns an active mutating turn, ChatGPT may continue read/review operations but must not independently mutate the same workspace until ownership is released (or Codex is interrupted).** This is the concrete serialization guarantee.
5. `mutation_owner` is **in-process / single-session**. It is **not** a distributed lock; it is a lightweight in-session state that prevents two paths from thinking they both own the repo in one loop.
6. **Read is always allowed**; only **mutation** is gated.
7. If a future requirement proves concurrent writers across multiple sessions (e.g. parallel executors) need real mutual exclusion, the next RFC must add a **lock file / lease** with evidence.

**Why not a distributed lock now:** the Default Direct Brain Loop is a single Brain + a single local workspace owner over one repo. A lock file/lease adds failure modes (stale locks, recovery) without a proven concurrent-writer scenario. Keep it minimal; add a lock only when a real cross-session writer conflict is demonstrated.

**Note.** ChatGPT-native (server-side) mutations and local mutations do not share a filesystem, so `mutation_owner` only governs **local workspace** mutations (the local `CHATGPT_DIRECT_LOCAL` / `CODEX_DELEGATE` paths).

---

## F. Deliverable summary

### 1. What ChatGPT should do natively
- Web / literature research, deep research, browsing.
- Image generation / editing, vision, voice.
- File upload / PDF understanding, sandboxed data analysis, charts / tables.
- Document / spreadsheet / presentation creation.
- Apps / connectors (GitHub, Gmail, Calendar, Drive, Notion, Slack class).
- Scheduled tasks / monitoring (async schedule only).
- Brain-level planning, review, `DONE`, and durable project knowledge (Projects).

### 2. What ChatGPT should do directly through local MCP (`CHATGPT_DIRECT_LOCAL`)
- **Custom MCP Apps + Secure Tunnel** is the **Brain-to-local transport** to expose (see Transport & backend layering).
- **Read / search / git status / git diff** — workspace-scoped, bounded, no mutation.
- **Small bounded write / edit** — diff-visible, base-hash protected.
- **Simple focused verification** — run a focused check under `mutation_owner`.
- These are the `CHATGPT_DIRECT_LOCAL` routes that do **not** require a full Codex turn, but still respect `mutation_owner`.

### 3. What should be delegated to Codex (`CODEX_DELEGATE`)
- Multi-file implementation, unknown-root-cause debugging, large refactors, long-running tests/builds.
- Production data pipeline work.
- Complex git / publishing workflows (commit / push / PR / tag / release) — gated, with identity pre-flight.
- Multi-turn implementation that must survive turn boundaries.
- Local shell / filesystem mutation under `workspace-write` (or gated `danger-full-access`).

### 4. What existing Alpha.4 mechanisms should NOT carry forward
**Keep as governance semantics:**
- milestone / task identity where useful;
- acceptance criteria;
- evidence;
- machine gate;
- Brain acceptance;
- `PUBLISH` / `DONE` lifecycle;
- publication / readback discipline.

**Do not automatically carry forward (browser-transport reliability machinery):**
- browser ACK semantics;
- composer delivery recovery;
- browser nonce / retransmit;
- DOM / conversation binding;
- browser-specific payload correlation;
- transport-specific exactly-once machinery **already provided by MCP / App Server** — unless a new dogfood proves an additional need.

Rationale: those mechanisms existed to make a brittle **IAB browser** path work. With a native MCP / App Server transport, the transport itself provides reliability; carrying forward browser-specific recovery would be dead weight and would re-couple the orchestrator to the browser DOM.

### 5. Open questions requiring user/product decision
1. **Plan tier availability** for Custom MCP Apps, Secure MCP Tunnel, and Apps/Connectors — which plans actually expose them? (marked `gate`/`unverified`; needs the user's actual Plan/account verification.)
2. **Local write path scope for the Brain** — how much of a single unit do we allow `CHATGPT_DIRECT_LOCAL` to mutate (only small bounded edits? any bounded edit?) vs routing all real mutations to `CODEX_DELEGATE`? This is the biggest ownership policy call.
3. **`danger-full-access` scope** — which repos/tasks justify it, and what is the allowlist? Needs repo/security input.
4. **Subagent capability** at the Codex Delegate layer — unverified; confirm whether Codex subagents are needed for v0.2.
5. **Cloud browser (Work) vs built-in browser** — which browsing surface is canonical for the mix of research tasks the user actually runs.
6. **Project memory scope** — should Brain project knowledge be shared with the orchestrator durable state, or kept exclusively in ChatGPT Projects?
7. **`mutation_owner` idempotency** — confirm that in-session single-owner semantics are sufficient for the real dogfood volume, or whether a cross-session lease is needed (defer to evidence).

> **Not an open decision:** choosing "Custom MCP App vs Codex App Server" as a default transport. They are **layered** (Brain-to-local transport vs local executor backend), not alternatives.

### 6. Recommended scope for the next Routing RFC
The next RFC (`rfc-v0.3-...`) should cover **transport + routing** narrowly:
- **A. Transport layering** — formalize the chain `Custom MCP App → Secure Tunnel → orchestration bridge → Codex App Server → Codex` as the composition, with the bridge owning routing.
- **B. Routing policy** — formalize the §D matrix into an executable/default rule set, keyed by task category and `CHATGPT_DIRECT_LOCAL` vs `CODEX_DELEGATE`.
- **C. Workspace ownership** — land `mutation_owner = none | chatgpt | codex` (§E) as a first-class state field with a test; include the "Codex owns a mutating turn → ChatGPT may read but not mutate" rule.
- **D. Change-set safety** — adopt CodexBridge base-hash protection + diff-visible writes, plus observe/apply/rollback primitive (shared by both local write branches).
- **E. Tool-surface tiers** — map `minimal / standard / full` to the orchestrator's `verificationPolicy` and risk tiers.
- **F. Evidence/audit** — operation journal + acceptance/evidence ledger over the new transport, preserving the Alpha.4 gate **semantics** (not its browser machinery).
- **Out of scope for the Routing RFC:** reimplementing ChatGPT-native capabilities (image, research, docs, connectors); any distributed lock (defer until evidence).

---

## Sources (research references)

Official OpenAI / ChatGPT:
1. https://help.openai.com/en/articles/10169521-projects-in-chatgpt
2. https://help.openai.com/en/articles/10169521-projects-in-chatgpt
3. https://help.openai.com/en/articles/9237897-searching-the-web-with-chatgpt
4. https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt
5. https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-app
6. https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt
7. https://learn.chatgpt.com/docs/image-inputs ; https://help.openai.com/en/articles/20001274-chatgpt-voice
8. https://help.openai.com/en/articles/8555545-file-uploads-faq ; https://learn.chatgpt.com/docs/artifacts-viewer
9. https://help.openai.com/en/articles/20001274-chatgpt-voice
10. https://help.openai.com/en/articles/20001278-creating-and-editing-documents-spreadsheets-and-presentations-with-chatgpt-work
11. https://learn.chatgpt.com/docs/plugins ; https://help.openai.com/en/articles/11487775
12. https://help.openai.com/en/articles/11145903-connecting-github-to-chatgpt
13. https://developers.openai.com/api/docs/guides/developer-mode ; https://developers.openai.com/apps-sdk/build/mcp-server
14. https://developers.openai.com/api/docs/guides/secure-mcp-tunnels ; https://github.com/openai/tunnel-client
15. https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt

CodexBridge (pattern reference):
- https://github.com/naplesblue/codexbridge (README: https://raw.githubusercontent.com/naplesblue/codexbridge/main/README.md)

Local oracle / spike evidence:
- Codex App Server spike: `codex app-server --listen stdio://crypto`; `codex-cli 0.146.0`; `capabilities.experimentalApi` for approval granularity; `thread/read {includeTurns:true}`; `TurnStatus`.
- Local MCP bridge → App Server → local Codex, same-thread continuation proven.
- Custom MCP App Secure Tunnel probing on 2026-09-01 (`probe_read`/`probe_write`/`probe_read_written` PASS; local filesystem readback PASS; Desktop modifying action PASS).

---

*This RFC is design input only. No runtime/source/version changes were made. See `docs/architecture.md` and `docs/development-history.md` for the current Alpha.3/Alpha.4 state; this inventory is a v0.2 pre-design artifact. Revision r1 aligns `CHATGPT_DIRECT_LOCAL`, transport layering, evidence model, CodexBridge sourcing, Alpha.4 carry-forward, and default routing with the Brain's v0.2 design space.*
