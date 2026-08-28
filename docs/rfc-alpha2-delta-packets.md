# RFC: Alpha.2 — Delta Packets + Fast Bootstrap

- **Status:** Accepted design — implementation pending
- **Target release:** `v0.1.0-alpha.2` (next dogfood milestone, following `v0.1.0-alpha.1`)
- **Scope:** minimal architecture change to make Brain <-> Codex orchestration **delta-based and compact by default**, and to make a fresh run **bootstrap fast**, based on Dogfood #1.

## 0. Alpha.2 Scope

**In scope (A–D):**

- **A. Fast Bootstrap / Discovery** — a deterministic, low-call startup path.
- **B. Delta Packet Orchestration** — compact `PLAN` / `TASK` / `RESULT` by default.
- **C. Tiered Verification** — step / milestone / final.
- **D. Completed-step Compaction** — active step detailed, done steps summarized.

**Still out of scope:** `adopt-current` stabilization, parallel executors, multiple Brain providers, Brain Council, MCP context provider, GUI, cost ledger, remote/Cloudflare runtime.

---

## 1. Problem

Dogfood #1 (the `v0.1.0-alpha.1` baseline) surfaced two distinct cost problems.

**1a. Context re-stating.** It took roughly **~36 minutes and 14 Brain/Codex rounds**. `TASK` packets repeatedly restated stable repository facts — repo map, scope, constraints, verification commands, and done criteria — even though they never changed. Full tests were rerun too often. This drove up **Brain tokens**, **Codex reading time**, **latency**, and **conversation length**.

**1b. Slow bootstrap.** A fresh Codex conversation spent many tool calls just to discover:
- which Skill implements ChatGPT command mode,
- where the orchestrator lives,
- old bridge / router / examples documentation,
- the target repository,
- whether the in-app browser (IAB) transport works.

Normal startup must not repeat this discovery.

## 2. Canonical Launcher Skill

The canonical user-facing launcher Skill is **`brain-command`**. It is **provider-neutral by name** (to avoid a future rename), but for Alpha.2:

- **default Brain = ChatGPT**
- **default Executor = Codex**

Natural-language triggers include:

- `用 ChatGPT 指挥模式完成...`
- `让 ChatGPT 指挥 Codex...`
- `Use ChatGPT as the brain and Codex as executor...`

Explicit invocation is documented conceptually as:

```
$brain-command ...
```

Do **not** implement Claude / DeepSeek / GLM providers in Alpha.2. The neutral name only keeps the door open without renaming later.

## 3. Design Principles

1. **Stable facts live in durable state, not in the per-turn packet.** Project Profile / Task State holds the repo map, scope, constraints, and done criteria; verification commands/policies are resolved from Project Profile / `verificationPolicy`.
2. **Task Contract and Plan are created once.** A single `PLAN` establishes the contract and milestones; later turns do not re-send them.
3. **Normal turns transmit only deltas.** A compact `TASK` Step Packet (one instruction + acceptance) and a compact `RESULT` Step Packet (changed + evidence). Nothing project-wide is repeated.
4. **Raw historical prompts/results are not required every turn.** Durable state is authoritative and rehydratable only when needed.
5. **Evidence is preserved; reproducible prompts are compactable.** Evidence stays in the ledger; verbose prompts/results compact into summaries reconstructable from Plan + summaries.
6. **Verification is step / milestone / final.** The cheapest sufficient check runs at step scope; the full suite runs at justified milestones and final.
7. **Compact-by-default, full contract only when risk requires.** Escalation switches a compact `TASK` to a full contract packet only for high-risk or ambiguous cases.
8. **Bootstrap is deterministic.** Startup resolves config and repo directly; it does not search the filesystem or historical docs.
9. **Repo Context is derived and refreshed, never frozen.** Only a bounded snapshot is built and it is refreshed at `PLAN` / pre-step / `REPLAN`, not treated as permanent repository truth.

## 4. Bootstrap / Discovery Fast Path

**Problem observed in Dogfood #1:** a fresh conversation spent many tool calls discovering the Skill, the orchestrator location, old bridge/router/examples docs, the target repo, and whether IAB works.

**Desired fast path:**

```
User goal
→ brain-command Skill match
→ resolve local orchestrator config
→ resolve repo deterministically
→ fast preflight
→ start Brain
→ first PLAN/TASK
```

**Normal startup must NOT require:**

- broad filesystem search
- searching for historical bridge Skills
- reading `router-policy` / `examples` on every run
- rediscovering the orchestrator installation

Historical bridge/router/examples docs may remain as developer references but are **not** runtime bootstrap dependencies.

## 5. Local Bootstrap Configuration

Use a canonical **user-scoped machine configuration**:

```
$CODEX_HOME/brain-command/config.json
```

where `CODEX_HOME` defaults conceptually to `~/.codex` when not otherwise configured. This configuration is **local machine state and is not committed to the target repository**. It may contain machine-local paths; this RFC itself does not hard-code this machine's actual paths.

Define at least:

- `orchestratorRoot`
- `dataRoot`
- `workspaceRoot`
- `defaultBrain = chatgpt`
- `defaultExecutor = codex`
- `defaultConversationMode = new`

The **brain-command installation/setup path creates or updates this configuration once**. Normal task startup **reads it directly**.

If the configuration is **absent, invalid, or points to an unavailable installation**:

- do **not** perform broad filesystem discovery;
- **fail fast** into setup / full-doctor guidance.

**First-install setup is separate from normal task bootstrap** and is not subject to the `<= 30s` already-configured-machine target.

## 6. Repository Resolution Policy

Use deterministic resolution, in order:

1. If invoked **inside the target repo**, prefer `cwd`.
2. If an explicit **local repo path** is supplied, use it.
3. If an explicit **GitHub repo** is supplied, resolve it through the configured workspace/clone policy.
4. **Broad recursive filesystem search is not part of normal startup.**

If repo identity is ambiguous, gather **targeted evidence first**, resolve automatically if possible, and **`ASK_USER` only if it cannot be resolved safely**.

## 7. Fast Preflight vs Full Doctor

Two levels:

**Fast preflight** (every task):
- orchestrator installation/config resolvable
- repo resolvable
- Codex executable available
- durable data root available
- IAB / Brain transport callable

**Full doctor** (only when needed):
- initial setup
- version / environment change
- fast-preflight failure
- explicit user request

Do **not** require full doctor on every task.

## 8. Repo Context Ownership & Freshness

`repoContext` is **not** a stable part of `taskContract`. Three distinct artifacts:

- **Task Contract** — `goal`, `constraints`, `done criteria`, and other **task-stable** requirements.
- **Project Profile** — **long-lived** repository/project rules, canonical docs, known commands/policies.
- **Repo Context** — **dynamic, bounded, derived context**: current status/diff, relevant files, test/error state.

**Refresh policy:**

- **PLAN** — build a bounded initial repo snapshot.
- **Before a Step** — refresh only context relevant to the current step when needed.
- **After RESULT** — incorporate changed paths/evidence into durable state.
- **REPLAN** — refresh the bounded repo snapshot.
- **Unknown fact** — targeted read/evidence first; no broad rediscovery; `ASK_USER` only if still non-resolvable.

**The first `PLAN` snapshot must not become permanently frozen repository truth.**

## 9. State Model Additions

Current durable task state (schema **v1**) exposes: `schemaVersion, taskId, repoDir, goal, status, conversationMode, adopted, conversationId, conversationUrl, ownedTabId, codexSessionId, round, lastControl, inFlightStep, steps[], completedSteps[], acceptanceRegistry[], createdAt, updatedAt`.

Alpha.2 adds these fields. All are **additive with safe defaults**, and **schemaVersion stays v1** — no explicit v2 migration, only load-time hydration/defaulting.

| Field | Type | Purpose |
|---|---|---|
| `taskContract` | object | Created by `PLAN`. **Task-stable only**: `goal`, `constraints[]`, `doneCriteria[]`, `verificationPolicyRef` (if needed), `createdAt`/`version` metadata. **Does NOT include** `repoContext`, `repoDir`, or generic `verificationCommands`. |
| `repoContext` | object | **Not part of `taskContract`**; bounded, derived, refreshed per the refresh policy (see §8). |
| `projectProfileRef` | string? | Reference to the durable Project Profile (long-lived rules / docs / commands / policies). |
| `plan` | object | Created by `PLAN`: `planId`, `planVersion`, `milestones[]`, `steps[]`, `status`. |
| `currentStepId` | string? | The active step; `null` when idle / waiting on the Brain. |
| `verificationPolicy` | object | `{ defaultLevel, stepRules, milestoneRules, finalRules, fullTestAt, docOnlyTier }`. |
| `completedSteps` | array | **Existing, retained** — the `reviewed` stepId list, used for compatibility/idempotency. |
| `stepSummaries` | array | **New** compact durable summaries produced by `reviewed -> compact`: `{ stepId, milestoneId, title, summary, status, acceptanceSummary, evidenceRefs[], verification, compactedAt }`. |
| `evidenceLedger` | array | Durable, append-only **real structured evidence** `{ id, stepId, acceptanceId, status: pass|fail|unknown, kind: command|test|file|diff|verify, summary, artifactRef?, at }`. |
| `unresolvedRisks` | array | Open risks `{ id, description, severity, status, milestoneId?, stepId?, owner }`. |

**Defaults on load:** `taskContract = null`, `repoContext = null`, `projectProfileRef = null`, `plan = null`, `currentStepId = null`, `verificationPolicy = { defaultLevel: 'step', fullTestAt: ['milestone', 'final'], docOnlyTier: 'step' }`, `stepSummaries = []`, `evidenceLedger = []` (unless real evidence can be recovered from persisted structured result data), `unresolvedRisks = []`.

## 10. Protocol

The control set grows from `CONTROLS = ['TASK','REVISE','ASK_USER','DONE']` to include `PLAN` and `REPLAN`. `RESULT` is the Codex->Brain response type. The **legacy text protocol fallback is kept** for Alpha.2 compatibility, but new runtime behavior **prefers/produces the structured protocol by default**.

### `PLAN` (Brain -> Orchestrator, once)

`repoDir` is an orchestrator / task-state identity, supplied by the Orchestrator — it is **not** carried in the Brain `PLAN` `taskContract` payload. Generic `verificationCommands` are **not** placed in `taskContract`; they resolve from Project Profile / `verificationPolicy` unless a task-specific requirement explicitly overrides them.

```json
{
  "control": "PLAN",
  "taskContract": {
    "goal": "Refactor the stats module and add tests",
    "constraints": ["preserve public API", "no new dependencies"],
    "doneCriteria": ["tests pass", "readme updated"],
    "verificationPolicyRef": "project-profile/default"
  },
  "plan": {
    "planId": "p-1",
    "milestones": [
      { "milestoneId": "m1", "title": "Refactor stats", "acceptanceIds": ["a1"], "verification": "milestone" },
      { "milestoneId": "m2", "title": "Add tests", "acceptanceIds": ["a2"], "verification": "milestone" }
    ],
    "steps": [
      { "stepId": "s1", "milestoneId": "m1", "title": "Extract helper" },
      { "stepId": "s2", "milestoneId": "m2", "title": "Write tests" }
    ]
  },
  "verificationPolicy": { "defaultLevel": "step", "fullTestAt": ["milestone", "final"], "docOnlyTier": "step" }
}
```

**Repo Context is not carried in the `PLAN` packet payload**; it is captured by the Orchestrator's bounded snapshot and refreshed per §8.

### `TASK` (Orchestrator -> Codex, compact by default)
```json
{
  "control": "TASK",
  "stepId": "s2",
  "instruction": "Add unit tests for the stats helper in test/stats.test.js",
  "acceptance": [ { "id": "a2", "text": "new tests pass" } ],
  "verification": { "level": "step" }
}
```

### `REVISE` (Orchestrator -> Codex)
```json
{ "control": "REVISE", "stepId": "s2", "instruction": "Cover the divide-by-zero branch", "reason": "test missed edge case" }
```

### `REPLAN` (Brain -> Orchestrator)
```json
{ "control": "REPLAN", "reason": "requirements changed", "planPatch": { "steps": [ ... ] }, "taskContractPatch": {} }
```

### `ASK_USER` (Brain -> Orchestrator, then pause)
```json
{ "control": "ASK_USER", "question": "Keep the legacy text protocol as a fallback?" }
```

### `DONE` (Brain -> Orchestrator)
```json
{ "control": "DONE" }
```

### `RESULT` (Codex -> Orchestrator, compact by default)
```json
{
  "type": "result",
  "stepId": "s2",
  "status": "success",
  "summary": "Added stats helper tests; all pass.",
  "changed": ["test/stats.test.js"],
  "evidence": [ { "acceptanceId": "a2", "status": "pass", "kind": "test" } ],
  "blockers": []
}
```
`summary` is an **optional one concise sentence**. There is **no separate verbose `tests` field** — test results belong in `evidence`.

## 11. Packet Policy

### Normal `TASK` contains only
- `control`
- `stepId`
- `instruction`
- `acceptance`
- `verification.level` **if needed** (omitted when it equals `verificationPolicy.defaultLevel`)

Nothing project-wide is repeated unless it changed.

### Normal `RESULT` contains only
- `type`
- `stepId`
- `status`
- `summary` (**optional**, one concise sentence)
- `changed`
- `evidence`
- `blockers`

No separate `tests` field; no project-wide constraint restatement.

## 12. Escalation Policy

A compact `TASK` becomes a **full contract packet** (re-attaching `taskContract` + relevant `plan` milestone + constraints + verification commands) when one or more apply:

1. **Destructive / high-risk change** — deletes, renames, migrations, large rewrites.
2. **Architecture migration** — orchestration architecture, protocol, durable schema, runtime/process boundaries.
3. **Security-sensitive work** — auth, redaction, secrets, IPC tokens, credentials.
4. **Ambiguous repo facts** — `repoContext` missing/stale, or step touches an uncovered area.
5. **Repeated failed revision** — after **2** failed `REVISE` attempts on the same step, the Brain may escalate that step to a fuller contract packet.

**Repository-fact ambiguity does NOT immediately trigger `ASK_USER`.** Preferred order:

```
targeted repo read/evidence
→ resolve automatically if possible
→ ASK_USER only if genuinely non-resolvable
```

## 13. Verification Policy & Authority

### Tiers (repository-agnostic)

- **Step verification** (`defaultLevel: 'step'`) — **project/step-specific cheap checks** (for this repository / Dogfood, examples: a targeted `node --test <affected>`, a single step command, or lightweight checks such as link/path validation, JSON/YAML parsing, targeted grep, `git diff --check`, relevant structural checks). **Documentation-only steps may skip the full suite**, but must still run relevant lightweight verification where applicable.
- **Milestone verification** (`level: 'milestone'`) — the **broader commands defined by the Project Profile / task verification policy**.
- **Final verification** (`level: 'final'`) — the **full acceptance suite defined for the target repository/task** (for this repository / Dogfood, examples: `npm test` + `npm run check` + `git diff --check` + link/JSON/YAML sanity).

`npm test`, `npm run check`, `git diff --check`, and link/JSON/YAML checks are **examples for this repository/Dogfood, not universal orchestrator requirements**. The full suite runs only at justified milestone/final boundaries.

### Authority
- **Orchestrator** — owns **mandatory milestone/final verification boundaries**; these cannot be silently downgraded.
- **Brain** — selects/proposes the verification level for the current step **within that policy**; may require a stronger level.
- **Codex** — executes the requested verification; may **escalate** verification when observed risk/change scope justifies it; must report the actual verification/evidence; may **not silently downgrade** the required level.

**Precedence:**

```
mandatory orchestrator boundary > Brain requested level > Codex local minimum
```

A downgrade, when otherwise permitted, requires an **explicit Brain decision / `REPLAN`** and can never bypass a mandatory milestone/final boundary.

## 14. Compaction Policy & Lifecycle

**Compaction is Orchestrator-owned**, not Brain- or Codex-owned.

**Trigger:** when a step reaches `reviewed`.

**Then (deterministic):**
- convert that completed step to a compact durable summary in `stepSummaries`;
- preserve acceptance outcome;
- preserve evidence in `evidenceLedger`;
- preserve unresolved risks;
- remove verbose historical TASK/RESULT text from future active Brain context.

`completedSteps` (the reviewed stepId list) is retained for compatibility/idempotency; `stepSummaries` holds the compact durable summaries produced by `reviewed -> compact`.

**Keep the latest active/unreviewed step detailed.**

Raw verbose TASK/RESULT material **may remain in append-only logs/artifacts** for audit/debugging, but it is **not repeatedly injected into later Brain turns**.

For Alpha.2, do **not** add context-pressure thresholds or adaptive compaction heuristics. Use the deterministic rule: **`reviewed -> compact`**.

## 15. Protocol / State Ownership

**Stable (owned by the project, not per-turn):**
- Brain rules
- Project Profile
- Task Contract (task-stable fields only; not `repoContext`)

**Durable (owned by task state):**
- Plan
- acceptance registry
- evidence ledger (`evidenceLedger`)
- completed-step summaries (`stepSummaries`)
- unresolved risks

**Per-turn delta:**
- current Step Packet
- latest Result Packet

**Repo Context** is **derived and refreshed** (see §8), never a permanently frozen fact. The active Brain context should not need verbose historical TASK/RESULT text once the durable summary/evidence has been recorded.

`PLAN` and `REPLAN` are **Brain -> Orchestrator control/state operations**. They are not ordinary Codex execution steps and are **not forwarded to Codex as filesystem tasks** unless they result in a concrete `TASK` / `REVISE` Step Packet.

## 16. Compatibility / Migration

- **Existing TASK / REVISE / ASK_USER / DONE workflows remain usable.** Compact `TASK` is a subset of the existing structured form; the full form is a superset. Extend `parseBrainOutput` / `validateControl` / `repairControl` to recognize `PLAN` / `REPLAN` (additive to `CONTROLS`).
- **Existing acceptance/evidence gate remains** — `checkAcceptanceGate` unchanged.
- **`evidenceLedger` is append-only real structured evidence.** New `RESULT` evidence is appended to `evidenceLedger`. Applying new evidence also updates `acceptanceRegistry` for compatibility and for the existing `DONE` gate.
- **`acceptanceRegistry` remains the compatibility/status projection** used by the current acceptance gate in Alpha.2. **Old v1 tasks hydrate `evidenceLedger` to `[]`** unless real evidence can be recovered from persisted structured result data. **A legacy `acceptanceRegistry` `pass` must not be converted into fabricated evidence.**
- **Existing task state migrates/defaults safely.** Keep **`schemaVersion = 1`**; add a load-time `hydrateTaskState(state)` filling the new fields with defaults. No stored data discarded; old tasks remain readable and re-runnable.
- Legacy text protocol fallback stays for compatibility; structured protocol is the Alpha.2 default.

## 17. Success Metrics

### Bootstrap metric
For the next dogfood run, measure:

```
user sends brain-command request
→ first valid Brain PLAN/TASK received
```

**Target:** normally **<= 30 seconds** on an already-configured machine. Also record:

- number of bootstrap tool calls
- whether any broad discovery / filesystem search occurred

*(First-install setup is separate and not subject to this target.)*

### Delta Packet metrics
- Normal Step Packets should be **at least ~60% smaller** than comparable Dogfood #1 TASK packets.
- Stable project facts should **not** be repeatedly restated.
- Full-suite verification should occur **only at justified milestone/final** boundaries.
- **Total Brain token use and elapsed time must be measured against Dogfood #1** rather than treated as a hard release gate yet.
- **Correctness / evidence quality must not regress.**

## 18. Implementation Readiness

The RFC is ready for **Alpha.2 implementation**, subject to one check: during implementation planning, confirm there is **no contradiction with the current codebase** (e.g. existing parser/state/loop assumptions that would conflict with the additive fields or the new `PLAN` / `REPLAN` controls). If no contradiction is found, implementation may proceed; the precise steps and any resulting code changes are tracked as a separate implementation task.
