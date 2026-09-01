# RFC: v0.2 — ChatGPT-Native Capability Inventory

- **Status:** Research / Proposed design input — no implementation
- **Target version:** v0.2 (pre-redesign inventory; does **not** implement v0.2)
- **Scope:** evidence-backed inventory of ChatGPT-native capabilities to **reuse** (not reimplement), CodexBridge reusable patterns, Codex delegate capabilities, a routing matrix, and a minimal workspace ownership rule.
- **Date:** 2026-09-01
- **Artifact:** this document only, under `docs/`. No runtime/source change, no version bump, no release.

---

## 0. Purpose and constraints

This is a **research / architecture** RFC. It precedes the actual v0.2 redesign. Its only deliverable is this document.

Established by prior proof-of-concept (evidence, not assumption — see §Sources):

1. **ChatGPT Web and Desktop ordinary Chat** can invoke a **Custom MCP App** through the **OpenAI Secure Tunnel** and perform real **local read / write / readback**. This is the observed baseline that makes "ChatGPT as Brain over a local MCP" viable.
2. A **local MCP bridge** can control **Codex through Codex App Server**: `initialize`, `thread/start`, `turn/start`, streamed completion (`turn/started`, `turn/completed`), `thread/read` (with `includeTurns`), same-thread continuation, and clean shutdown. This is the observed baseline that makes "Codex as local Delegate" viable.
3. The **Alpha.4 in-app browser (IAB) transport** is **no longer assumed** to be the future canonical transport. It is a candidate among several, not the default.

Everything below separates **official documentation** from **observed local capability**; unsupported plan availability is marked **unverified**, never guessed.

### Notation

| Mark | Meaning |
|---|---|
| `✓` | documented / officially supported |
| `obs` | observed verified locally (proof-of-concept, not a Plan guarantee) |
| `gate` | plan-gated; specific tier availability **unverified** |
| `?` | not documented here / unverified |
| `—` | not applicable |

**Surfaces:** `Web` = chatgpt.com; `Desktop` = ChatGPT desktop app; `Work` = ChatGPT for Work/Enterprise; `Codex` = the Codex agent/runtime as an executor surface.

**Routing roles (used consistently):** `CHATGPT_NATIVE` · `CHATGPT_DIRECT_LOCAL` · `CODEX_DELEGATE` · `HYBRID`.

---

## A. ChatGPT Native Capability Inventory

> Rule applied throughout: **Where a capability is a strong, already-productized ChatGPT feature, reuse it. Where it requires local repo/filesystem mutation, it must route through a local executor (Codex) — ChatGPT-native surfaces cannot mutate a local repo without a local transport.**

### A.1 Core reasoning / context

| Capability | Source | Web | Desktop | Work | Codex | Read | Mutate | Async | Approval | Stay native | Wrap? | Routing role |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Reasoning / normal Chat | [1] | ✓ | ✓ | ✓ | — | ✓ | ✓ (reply only) | — | — | yes | no | `CHATGPT_NATIVE` |
| Projects (project context / shared memory) | [2] | ✓ | ✓ | ✓ | — | ✓ | ✓ (project-bound) | — | — | yes | optionally expose read | `CHATGPT_NATIVE` |
| Memory / knowledge within a project | [2] | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | — | yes | maybe read into context | `CHATGPT_NATIVE` |

**Notes.** Projects give durable, shared project context — strongly relevant for a Brain that must stay consistent across many turns. Reads can be surfaced to the orchestrator; writes should stay ChatGPT-native (Brain owns project knowledge).

### A.2 Research & browsing

| Capability | Source | Web | Desktop | Work | Codex | Read | Mutate | Async | Approval | Stay native | Wrap? | Routing role |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Web search | [3] | ✓ | ✓ | ✓ | — | ✓ | — | — | — | yes | no | `CHATGPT_NATIVE` |
| Deep research | [4] | ✓ | ✓ | ✓ | — | ✓ | — | ✓ (long-running) | — | yes | no | `CHATGPT_NATIVE` |
| Built-in browser | [5] | ✓ | ✓ | ✓ | — | ✓ | ✓ (in-page) | — | — | yes | no | `CHATGPT_NATIVE` |
| Cloud browser (Work) | [6] | ✓ | ✓ | ✓ | — | ✓ | ✓ (sandboxed) | ✓ (async sessions) | — | yes | no | `CHATGPT_NATIVE` |

**Notes.** Web research, deep research and browsing are **strong ChatGPT-native advantages**. Do not reimplement them in the orchestrator. Deep research is async/background by nature — perfect for long research sub-tasks that do not need a local repo. The cloud browser is a Work-tier sandboxed browsing surface, distinct from the local-built-in browser.

### A.3 Media

| Capability | Source | Web | Desktop | Work | Codex | Read | Mutate | Async | Approval | Stay native | Wrap? | Routing role |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Image generation | [7] | ✓ | ✓ | ✓ | — | — | ✓ | ✓ (queued) | — | yes | no | `CHATGPT_NATIVE` |
| Image editing | [7] | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | — | yes | no | `CHATGPT_NATIVE` |
| Vision / image understanding | [7] | ✓ | ✓ | ✓ | (codex-adjacent) | ✓ | — | — | — | yes | no | `CHATGPT_NATIVE` |
| Voice | [9] | obs | ✓ | ✓ | — | — | ✓ | — | — | yes | no | `CHATGPT_NATIVE` |

**Notes.** Image generation/editing and vision are first-class ChatGPT features. The orchestrator should **not** reimplement them. When a task combines "research + code + visual", route visual generation natively and code to Codex — that is the `HYBRID` case.

### A.4 Document ingestion & creation

| Capability | Source | Web | Desktop | Work | Codex | Read | Mutate | Async | Approval | Stay native | Wrap? | Routing role |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| File upload / PDF understanding | [8] | ✓ | ✓ | ✓ | — | ✓ | — | — | — | yes | no | `CHATGPT_NATIVE` |
| Data analysis / Python (notebook) | [8] | ✓ | ✓ | ✓ | — | ✓ | ✓ (sandbox) | ✓ | — | yes | no | `CHATGPT_NATIVE` |
| Charts / tables | [8] | ✓ | ✓ | ✓ | — | ✓ | ✓ (sandbox) | — | — | yes | no | `CHATGPT_NATIVE` |
| Documents (create/edit) | [10] | ✓ | ✓ | ✓ | — | ✓ | ✓ (Workspace) | — | — | yes | no | `CHATGPT_NATIVE` |
| Spreadsheets (create/edit) | [10] | ✓ | ✓ | ✓ | — | ✓ | ✓ (Workspace) | — | — | yes | no | `CHATGPT_NATIVE` |
| Presentations (create/edit) | [10] | ✓ | ✓ | ✓ | — | ✓ | ✓ (Workspace) | — | — | yes | no | `CHATGPT_NATIVE` |

**Important distinction.** The ChatGPT `data analysis / Python` sandbox is **stateless and sandboxed** — it is **not** a local repo executor. It is excellent for *exploratory* data analysis and quick chart/table generation, but it **cannot** mutate a local git worktree. Any task that must edit a **local repository** belongs to `CODEX_DELEGATE` (or `CHATGPT_DIRECT_LOCAL` if a local MCP write path is used). Document/spreadsheet/presentation creation is a strong ChatGPT-native surface (especially Work) and should **not** be reimplemented locally.

### A.5 Apps / integrations

| Capability | Source | Web | Desktop | Work | Codex | Read | Mutate | Async | Approval | Stay native | Wrap? | Routing role |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Apps / Plugins / Connectors | [11] | ✓ | ✓ | ✓ | — | ✓ | ✓ (via connector) | ✓ | gate | yes | no | `CHATGPT_NATIVE` |
| GitHub integration | [12] | ✓ | ✓ | ✓ | — | ✓ | ✓ (repo ops via connector) | ✓ | gate | yes | optionally | `CHATGPT_NATIVE` / `HYBRID` |
| Gmail / Calendar / Drive / Notion / Slack style | [11] | ✓ | ✓ | ✓ | — | ✓ | ✓ (via connector) | ✓ | gate | yes | no | `CHATGPT_NATIVE` |
| **Custom MCP Apps** | [13] | ✓ | ✓ | ✓ | — | ✓ | ✓ (via MCP tool) | ✓ (streamable) | gate | yes | **YES — this is the key** | `CHATGPT_DIRECT_LOCAL` |
| **Secure MCP Tunnel** | [14] | ✓ | ✓ | ✓ | — | ✓ | ✓ (via tunnel) | ✓ | gate | yes | **YES** | `CHATGPT_DIRECT_LOCAL` |

**This is the pivotal cluster.** The combination of **Custom MCP Apps + Secure MCP Tunnel** is what makes "ChatGPT Brain over a local MCP" real. It is the observed mechanism that lets a ChatGPT conversation reach a local server (and, via a MCP bridge, a local Codex). This is the capability the orchestrator should **expose and codify**, not reimplement.

### A.6 Automation & monitoring

| Capability | Source | Web | Desktop | Work | Codex | Read | Mutate | Async | Approval | Stay native | Wrap? | Routing role |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Scheduled tasks / monitoring | [15] | ✓ | ✓ | ✓ | — | ✓ | ✓ (scheduler) | ✓ | gate | yes | optionally observe | `CHATGPT_NATIVE` (monitoring) / `HYBRID` (monitor + local action) |

**Notes.** ChatGPT scheduled tasks give durable async monitoring. But a *monitor that must run local checks/commands* still needs a local executor. So orchestrated monitoring is typically `HYBRID`: ChatGPT holds the async schedule; Codex performs the local read/validate/publish work.

### A.7 Cross-cutting: capability surface decision rule

For every capability, the decision is driven by **where the work must physically happen**:

- **Work only needs the model + conversation context** → `CHATGPT_NATIVE`.
- **Work needs to read local repo/files and possibly mutate them** → local executor (`CODEX_DELEGATE`, or `CHATGPT_DIRECT_LOCAL` via a local MCP write path).
- **Work needs both** → `HYBRID`, with an explicit ownership boundary (§E).

---

## B. Local / direct coding capability patterns (CodexBridge)

`naplesblue/codexbridge` is a strong reference implementation of **"ChatGPT as Brain over a local coding agent via MCP + tunnel."** We studied it as a pattern source. **It is not our target architecture** — we borrow patterns, not its product.

| Pattern | Reference | Classify | Rationale |
|---|---|---|---|
| Workspace-scoped `read` | CodexBridge | `REUSE` | Bound reads to a configured workspace root; deterministic, safe, cheap. |
| Workspace-scoped `write` / `edit` returning diffs | CodexBridge | `REUSE` | Any local write must be workspace-scoped and diff-visible. |
| `open_workspace` (bind a root before tool use) | CodexBridge | `REUSE` | An explicit "which repo am I in" step is a clean ownership anchor. |
| `search` / `tree` (bounded) | CodexBridge | `REUSE` | Bounded repo discovery — no broad filesystem search. |
| Safe bash (allowlist) | CodexBridge | `ADAPT` | Allowlist approach is good; our `danger-full-access` policy differs by task risk. Keep the *principle*, tune the allowlist per repo. |
| `git_status` / `git_diff` | CodexBridge | `REUSE` | Deterministic repo-state reporter; core to evidence and safety gates. |
| `preview_change_set` / `apply_change_set` (base-hash checks) | CodexBridge | `REUSE` | **Base-hash protection** is exactly the guard against stale applied changes. |
| `preview_rollback_change_set` / rollback | CodexBridge | `ADAPT` | Valuable but only where a true git snapshot is available; keep it git-backed, not custom state. |
| `operation_journal` | CodexBridge | `REUSE` | Append-only operation log is a good audit/observability primitive. |
| `task_brief` / `plan` / `verify` / `report` / `resume` | CodexBridge | `ADAPT` | The *shape* (brief → plan → verify → report) is right; our orchestrator already owns plan/verification authority, so the orchestrator should drive these, not the executor. |
| Skill / AGENTS context (`load_skill`, `codex_context`) | CodexBridge | `REUSE` | Loading repo `AGENTS.md` / skill context deterministically is a proven, cheap pattern. |
| `minimal` / `standard` / `full` tool surfaces | CodexBridge | `ADAPT` | Tiered tool surface is a good safety default. Map to our `verificationPolicy` / risk tiers. |
| `approval_review` | CodexBridge | `REUSE` | Structured approval gate maps cleanly to our `ASK_USER` / approval requirement. |
| `handoff_to_agent` / `handoff_to_codex` (CLI `execute-handoff` / `watch-handoff`) | CodexBridge | `DO_NOT_COPY` | CLI-only handoff is not our model and conflicts with a single-turn control loop. |
| `export_pro_context` | CodexBridge | `ADAPT` | Serializing context is useful; we already do compact deltas, so this is optional. |
| `server_config` | CodexBridge | `ADAPT` | Config is useful, but our config lives in a canonical launcher/config path already. |
| Token-protected URLs / not OS sandbox | CodexBridge | `ADAPT` | Token auth is good; "not OS sandbox" boundary is a real limitation we should improve with workspace-write sandboxing. |

**Key take-aways from CodexBridge:**
1. **Bound a workspace explicitly first** (`open_workspace`) — this is the cleanest ownership anchor and avoids accidental cross-repo writes.
2. **Base-hash protection** on every change-set — prevents applying stale edits.
3. **Diffs, always** — the Brain/reviewer needs to see exactly what changed.
4. **Tiered tool surfaces** — minimal by default, expand on explicit need.
5. **Operation journal / audit** — cheap and gives the Brain evidence.

---

## C. Codex Delegate capability inventory

Using the completed Codex App Server spike + official schema:

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

**Codex should be preferred for:** any task that reads/mutates a **local repo**, runs **tests/build**, does **git** operations, performs **long-running** work that must survive turn boundaries, or requires **publishing**. It is the **only** surface that mutates local source/repo state.

**Baseline recorded (spike):** `codex-cli 0.146.0`; app-server launch `codex app-server --listen stdio://crypto`; protocol async via `capabilities.experimentalApi`.

---

## D. Routing matrix (representative tasks)

| Representative task | Default executor | Rationale |
|---|---|---|
| Web research (general) | `CHATGPT_NATIVE` | Web search/deep research are native strengths. |
| Literature research | `CHATGPT_NATIVE` (+ `HYBRID` when downloading) | Discovery + summarization native; local file download needs a local executor. |
| Image generation / editing | `CHATGPT_NATIVE` | Native, not reimplemented. |
| PDF analysis (uploaded doc) | `CHATGPT_NATIVE` | File upload + PDF understanding native. |
| Exploratory data analysis | `CHATGPT_NATIVE` (sandbox) | Sandbox Python/charts native; no local repo needed. |
| Production data pipeline | `CODEX_DELEGATE` | Must mutate local repo/scripts consistently. |
| Inspect repository | `CODEX_DELEGATE` | Needs workspace-scoped local read. |
| One-line text edit | `CHATGPT_DIRECT_LOCAL` | Small, diff-visible write via local MCP; or `CODEX_DELEGATE` if in a repo. |
| Multi-file implementation | `CODEX_DELEGATE` | Coherent milestone TASK executed in one repo. |
| Debugging unknown root cause | `CODEX_DELEGATE` | Turn-local exploration + test, reporter of evidence. |
| Refactor | `CODEX_DELEGATE` | Multi-file, test-gated, diff-visible. |
| Run tests | `CODEX_DELEGATE` | Tests live in repo; executor runs them. |
| git diff | `CODEX_DELEGATE` | Local repo state. |
| commit / push / PR | `CODEX_DELEGATE` (+ `CHATGPT_NATIVE` review) | Publishing is local git; release/PR review can be native. |
| Browser interaction (web pages) | `CHATGPT_NATIVE` | Built-in / cloud browser native. |
| Create document / spreadsheet / presentation | `CHATGPT_NATIVE` | Native Work surface, not reimplemented. |
| **Mixed research + coding + visual** | `HYBRID` | Research/visual native; code/delegate local; explicit ownership boundary (§E). |

---

## E. Workspace ownership rule

**Recommendation:** a **minimal, single-owner** model, **no distributed lock** unless evidence proves one necessary.

```
mutation_owner = none | chatgpt | codex
```

- `none` — no active mutation owned; the workspace is stable (initial / post-DONE).
- `chatgpt` — the ChatGPT side (via local MCP write path) owns workspace mutation for the current unit.
- `codex` — the local Codex Delegate owns workspace mutation for the current unit.

**Rules (smallest viable):**
1. Exactly **one** `mutation_owner` at a time per target repo / workspace.
2. `<unit>` (a TASK or a Brain control) starts with `mutation_owner` set to the executor that will mutate; it is cleared to `none` on unit completion / DONE.
3. A writer must be the current `mutation_owner`. A non-owner attempting a mutation fails closed (no-op + structured error).
4. `mutation_owner` is **in-process / single-session**. It is **not** a distributed lock; it is a lightweight in-session state that prevents two paths from thinking they both own the repo in one loop.
5. Read access is always allowed; only **mutation** is gated.
6. If a future requirement proves concurrent writers across multiple sessions (e.g. parallel executors) need real mutual exclusion, the next RFC must add a **lock file / lease** with evidence.

**Why not a distributed lock now:** the Default Direct Brain Loop is a single Brain + single local executor over one repo. A lock file/lease adds failure modes (stale locks, recovery) without a proven concurrent-writer scenario. Keep it minimal; add a lock only when a real cross-session writer conflict is demonstrated.

**Out of scope here.** Interleaving ChatGPT-native (server-side) mutations and local mutations do not share a filesystem, so `mutation_owner` only governs **local workspace** mutations (the local executor / local MCP path).

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

### 2. What ChatGPT should do directly through local MCP
- **Custom MCP Apps + Secure MCP Tunnel** is the transport to expose.
- Small, diff-visible local writes (one-line edits) via a workspace-scoped local MCP write path.
- Local **read-only** repo inspection (bounded) when it is the Brain's decision to look at the repo.
- These are the `CHATGPT_DIRECT_LOCAL` routes that do not require a full Codex turn, but still must respect `mutation_owner`.

### 3. What should be delegated to Codex
- Any task that mutates a **local repo** (multi-file implementation, refactor, debug, tests/build, git ops).
- Production data pipeline work.
- Long-running work that must survive turn boundaries.
- Publishing workflows (commit / push / PR / tag / release) — gated, with identity pre-flight.
- Local shell / filesystem mutation under `workspace-write` (or gated `danger-full-access`).

### 4. What existing Alpha.4 mechanisms should NOT carry forward
- **IAB browser transport as the canonical default** — no longer assumed; should be replaced by explicit transport selection (MCP / App Server / IAB as candidates, chosen by configuration, not hard-coded).
- **Browser DOM selectors for the ChatGPT Brain** (composer/history selectors) — brittle; replaced by a native MCP/tunnel transport where possible.
- **Legacy detached worker / TaskService / nested Codex runtime** — retained as experimental only; not the canonical path.
- **Any hard-coded ChatGPT DOM coupling** in the canonical path — move behind a transport abstraction.
- **IAB-unavailable external-browser fallback** — the prior skill explicitly removed external-browser fallback; keep that decision (don't auto-attach to user's Edge/Chrome).
- Note: the Alpha.4 **protocol-integrity / controller advancement / publication gate / identity pre-flight** logic is *behavior* worth keeping — but it must be re-exposed over the new transport, not tied to the IAB browser.

### 5. Open questions requiring user/product decision
1. **Plan tier availability** for Custom MCP Apps, Secure MCP Tunnel, and Apps/Connectors — which plans actually expose these? (marked `gate`/`unverified` above; needs the user's actual Plan/account verification.)
2. **Transport default for v0.2** — Custom MCP App (ChatGPT-native over tunnel) vs Codex App Server (local) as the primary transport? Recommend an explicit config-selectable transport, but which is *default* is a product call.
3. **Local MCP write path** — does the user want the Brain to have a direct local write path (`CHATGPT_DIRECT_LOCAL`) or route *all* mutation through Codex Delegate (`CODEX_DELEGATE`)? This is the single biggest ownership decision.
4. **`danger-full-access` scope** — which repos/tasks justify it, and what is the allowlist? Needs repo/security input.
5. **Subagent capability** at the Codex Delegate layer — unverified; confirm whether Codex subagents are needed for v0.2.
6. **Cloud browser (Work) vs built-in browser** — which browsing surface is canonical for the mix of research tasks the user actually runs?
7. **Project memory scope** — should Brain project knowledge be shared with the orchestrator durable state, or kept exclusively in ChatGPT Projects?

### 6. Recommended scope for the next Routing RFC
The next RFC (`rfc-v0.3-...`) should cover **transport + routing** narrowly:
- **A. Transport abstraction** — define a `transport` interface with three adapters: `chatgpt-mcp` (Custom MCP App over Secure Tunnel), `codex-app-server` (local bridge), and `iab-browser` (legacy). Explicit config selects one; no hard-coded default until the open question in §F.5.2 is answered.
- **B. Routing policy** — formalize the §D matrix into an executable/default rule set, keyed by task category.
- **C. Workspace ownership** — land the `mutation_owner = none | chatgpt | codex` rule (§E) as a first-class state field with a test.
- **D. Change-set safety** — adopt CodexBridge base-hash protection + diff-visible writes, plus the observe/apply/rollback primitive.
- **E. Tool-surface tiers** — map `minimal / standard / full` to the orchestrator's `verificationPolicy` and risk tiers.
- **F. Evidence/audit** — operation journal + acceptance/evidence ledger over the new transport, preserving the Alpha.4 gate semantics.
- **Out of scope for the Routing RFC:** reimplementing ChatGPT-native capabilities (image, research, docs, connectors), and any distributed lock (defer until evidence).

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

---

*This RFC is design input only. No runtime/source/version changes were made. See `docs/architecture.md` and `docs/development-history.md` for the current Alpha.3/Alpha.4 state; this inventory is a v0.2 pre-design artifact.*
