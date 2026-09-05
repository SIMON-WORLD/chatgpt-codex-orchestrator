# RFC: v0.2 Brain Continuity

> Status: **ACCEPTED CONTRACT — implementation / real dogfood pending**
>
> This RFC records the current best-known design based on M7 dogfood and subsequent Parent Brain review. It is intentionally revisable: new production evidence may trigger `REPLAN`. Acceptance of this contract does not accept any future implementation automatically.
>
> 2026-09-05 clarification: project-level Parent authority has one active holder at a time, Parent sessions are replaceable holders of that role, and implementation/research/review conversations are disposable mission sessions rather than current durable Child-Brain authority entities. This clarification does not expand the Brain Continuity Core runtime scope.

## 1. Problem

M7 proved the core capability-routing model:

- `CHATGPT_NATIVE` real-project work can complete without Codex;
- `CODEX_DELEGATE` can complete sustained local coding without manual ID/RESULT relay;
- `HYBRID` can combine Native investigation, Codex implementation, and Native independent verification.

M7-C also closed the executor-level re-entry gap for long-running Codex work by adding durable orchestration binding and bounded `codex_recover`.

However, the layer above the executor is not yet equally durable. The canonical `GovernanceService` is constructed with fresh in-memory state, and `BrainLocalRuntime` currently creates a fresh Governance instance on runtime construction. A Local MCP/runtime restart can therefore lose task/step/acceptance/evidence/Brain-acceptance lifecycle state even while the underlying Codex execution remains durably recoverable.

Real project use has also exposed a broader continuity constraint: a ChatGPT Parent conversation can become too long, be interrupted, or need to be replaced. A replacement conversation must not require the human to carry internal orchestration identifiers or a giant transcript handoff.

The problem is therefore not only **Governance persistence**. It is **Brain Continuity**:

> A Brain session may be replaced, a local runtime may restart, and a capability provider may change availability, while the logical project/task authority, accepted evidence, active execution identity, and next safe action remain recoverable without duplicate execution or human message-bus work.

## 2. Evidence from the current implementation

The current main branch already contains durable patterns that should be reused rather than replaced:

- `src/executor/job-map.js` persists Codex job/thread/turn plus M7-C `taskId / stepId / identity` bindings under the runtime data root using atomic temp-write + rename.
- `src/state/operation-state.js` persists bounded Direct Local operation state under the same data root.
- legacy `src/task-state.js` already implements versioned JSON state, atomic write, `.bak` fallback, hydration, and corruption handling that refuses silent fresh reset when both primary and backup are invalid.
- `src/runtime-paths.js` provides a unified user-level durable `dataRoot` outside both the orchestrator repository and target repositories.
- `src/governance/index.js` already has strong task/step lifecycle semantics, terminal `DONE` idempotency/immutability, acceptance/evidence gates, and fail-closed task/step identity checks.
- current `MutationOwner` is intentionally single-process and is not a distributed lock.
- `proofLedger` is currently an in-memory verification-reuse cache. Losing it may reduce reuse efficiency, but continuity must never turn loss of proof freshness data into an implicit acceptance.

The smallest correct design should therefore extend canonical Governance with durable state and re-entry semantics. It should not introduce a database, Temporal-like workflow service, distributed lock system, or a second orchestration stack without evidence that the existing data-root patterns are insufficient.

## 3. Design principles

### 3.1 Brain sessions are disposable; work state is durable

A ChatGPT conversation is an interaction/session surface, not the durable identity of the Parent Brain or a task.

Replacing Conversation A with Conversation B must not create a new logical task or duplicate an already-running executor action.

### 3.2 Conversation context is not authority

Conversation transcripts, generated summaries, and handoff prose are context caches. They are not authoritative sources for acceptance, evidence, terminal state, or mutation ownership.

If a narrative summary conflicts with structured durable Governance state or authoritative GitHub/runtime evidence, the structured/authoritative evidence wins.

### 3.3 Capabilities are observed, not assumed

Capability availability is an ephemeral runtime observation scoped by capability, provider, resource, operation, and observation time. Re-entry and meaningful execution boundaries require re-discovery when prior observations may be stale.

A persisted statement that a capability was previously available must never be treated as proof that it is still available now.

### 3.4 Delegate outcomes, not keystrokes

The active Parent controls goal, scope, constraints, acceptance, routing, and final project-level decision. A sustained executor such as Codex controls local implementation tactics inside its delegated boundary.

Governance should use milestone-sized execution authorization rather than forcing the Parent to dispatch each shell/edit/test action individually.

### 3.5 Bounded recovery; never guess the most recent task

Recovery must use reconstructable logical identity and resource scope. The contract is:

- zero match -> `not_found`;
- exactly one valid match -> recover;
- more than one valid match -> `ambiguous`, fail closed;
- corrupt/stale/foreign-resource state -> fail closed.

There is no generic `resume most recent task` fallback.

### 3.6 Parallel work does not imply parallel authority

v0.2 retains one **active project-level Parent authority** at a time.

Separate ChatGPT implementation, research, or review sessions may perform bounded missions and return evidence/critique/execution results, but their existence does not create parallel project-level acceptance authority. They are disposable working/context surfaces unless future evidence justifies a different durable workstream model.

Parent authority may move from Parent Session A to Parent Session B only through bounded takeover/re-entry semantics; it does not multiply because multiple conversations exist.

### 3.7 Complexity must be earned by evidence

This RFC must not be used as justification to pre-build recursive multi-agent scheduling, a generic DAG engine, shared-authority consensus, reviewer consensus, or distributed locking.

## 4. Authority and state layers

Continuity depends on separating four kinds of state.

### 4.1 Project truth — GitHub / external authoritative resources

Current code, formal architecture/status docs, commits, PRs, CI, releases, and other authoritative external resources remain implementation/project truth.

The local continuity store must not silently overwrite contradictory current GitHub evidence.

### 4.2 Durable Governance state — local control truth

The Local Capability Plane persists the control state required to safely resume the same logical task:

- logical project identity;
- logical task identity and internal `taskId`;
- current control / route / local route;
- plan revision;
- current and previous step identity;
- acceptance contracts and their structured evidence status;
- executor status;
- machine gate;
- Brain acceptance;
- publication state;
- blocker / awaiting-user state;
- terminal state;
- authority generation/fencing state;
- bounded history required for recovery/audit.

Verification-reuse caches and metrics are not automatically control truth. If reusable proof freshness cannot be safely rehydrated/revalidated after restart, the safe fallback is to require re-verification, not to infer pass. Observability metrics may reset if they are not required for correctness.

### 4.3 Executor durable state — execution truth

Codex execution identity continues to be owned by the existing JobMap/AppServer recovery contract. Brain Continuity must reuse `codex_recover`, `reconcile`, mutation ownership, and permission contracts rather than duplicating them inside Governance.

### 4.4 Brain Context Capsule — derived working context

A replacement Parent session receives a bounded derived capsule generated from durable state and freshly reacquired evidence. It is not a free-form transcript dump.

A capsule should contain only what the Parent needs to continue safely, for example:

- project/task semantic identity;
- current phase/control/route;
- current milestone/step;
- acceptance summary;
- evidence references/status;
- active execution summary;
- unresolved blockers/risks;
- next safe action;
- current authority generation;
- canonical external references that should be re-read.

Low-level IDs may remain available for debug but are not part of normal user-visible handoff.

## 5. Durable storage contract

### 5.1 Reuse the existing data root

Canonical Governance persistence should live in a dedicated namespace under the existing `dataRoot`, separate from legacy task-state files and target repositories. A shape such as `runtime/governance/<taskId>.json` is preferred unless implementation evidence shows a better existing namespace.

### 5.2 Versioned schema

Persistent Governance state must carry an explicit schema version.

Future incompatible changes require deterministic migration or explicit fail-closed handling. An unknown/future schema must never silently hydrate into a trusted fresh task.

### 5.3 Atomic write + backup

Reuse the proven repository pattern:

1. write temporary JSON;
2. atomically rename;
3. retain a known-good backup;
4. on load, try primary, then backup;
5. if both are corrupt/invalid, return a named corruption/recovery error — never `_freshState()` as if no prior task existed.

### 5.4 Snapshot plus bounded history

The current authoritative Governance snapshot is sufficient for normal resume. A bounded/event history may be retained for audit/recovery diagnostics, but v0.2 does not need a general event-sourced workflow engine.

### 5.5 One canonical local Governance writer per namespace

Parent authority fencing assumes Governance mutations pass through one serialized authoritative local writer.

v0.2 does not need a distributed lock manager, but it must not allow two canonical Local MCP/runtime processes to concurrently mutate the same Governance namespace/dataRoot as independent writers. The implementation must either prevent that configuration with a lightweight runtime/namespace ownership guard or detect contention and fail closed.

This process-level writer boundary is separate from Parent conversation authority generation and from workspace mutation ownership. All three scopes must remain explicit:

- Parent authority: which active Parent generation may issue new project-level Brain controls;
- Governance runtime writer: which local runtime may persist control state;
- resource mutation owner: who may mutate a workspace/resource.

Implementation/research/review session labels are not a fourth durable locking scope in v0.2.

## 6. Logical identity and bounded re-entry

Internal IDs are implementation details. A new Parent session must recover by a stable, reconstructable logical identity.

At minimum, recovery should be scoped by:

- a stable `projectKey` reconstructable by the Brain (for example a canonical repository full name or explicit project identity), and
- an optional semantic task/work identity when more than one task may exist for the same project/resource.

Workspace root/path may be used as an authorization/resource-scope check but must not be the only long-term project identity because paths can vary across machines.

The Brain should be able to derive the recovery key from canonical project state or the user's natural-language project reference. The human must not be asked to preserve or relay `taskId`, `stepId`, `jobId`, `threadId`, `turnId`, or an authority token.

If the logical scope resolves to multiple active candidates, the system asks the user only for the minimum semantic disambiguation; it does not expose internal IDs.

## 7. Parent authority takeover and split-brain fencing

Conversation rollover introduces a new safety risk: Parent Session A may still be alive when Parent Session B takes over.

The continuity contract therefore requires a durable **authority generation/fencing token** for project-level Parent-authored Governance mutations.

Semantics:

1. Initial task authority starts at generation `g`.
2. A bounded Parent re-entry/takeover increments the generation and issues a new opaque fencing token to the new Parent session.
3. After takeover, a mutating Governance request carrying an older generation/token is rejected as `stale_authority`.
4. The token is an internal Brain/runtime concern; the human never relays it.
5. Read-only status/recovery discovery may remain available without mutation authority.

Exact API names are implementation details, but the semantic property is mandatory: **old Parent control cannot mutate the task after a newer Parent has taken authority.**

This fencing requirement is intentionally narrow. It does not require reviewer, implementation, or research sessions to receive their own hierarchy of Parent-style generation tokens merely because they exist as separate conversations.

### 7.1 Takeover does not cancel delegated execution

Parent authority and executor delegation are separate scopes.

If Parent A already authorized Codex to complete a bounded milestone, Parent B takeover does not automatically cancel or restart that Codex execution. The existing durable execution binding remains valid; the new Parent reconciles it and becomes the only authority for new project-level controls (`REVISE`, new `TASK`, `PUBLISH`, `DONE`, scope change, etc.).

## 8. Governance re-entry semantics

A replacement Parent session should follow this conceptual flow:

```text
Resolve project/task semantic identity
-> bounded Governance recovery
-> validate schema / state integrity
-> acquire new Parent authority generation
-> build bounded Context Capsule
-> re-discover required runtime capabilities
-> reconcile any active local/Codex execution
-> reacquire stale authoritative GitHub/Web/runtime evidence
-> continue with the next safe Governance action
```

Recovery must preserve terminal and safety semantics:

- `DONE` remains terminal and cannot become executable after restart;
- a step with a recorded RESULT is not silently re-executed;
- any local execution state that requires reconciliation remains fail-closed until authoritative reconciliation;
- `ASK_USER` remains blocked pending a user decision;
- ambiguous state never becomes a fresh trusted task.

## 9. Capability observation freshness

A capability observation is scoped evidence, conceptually:

```text
CapabilityObservation {
  capability,
  provider,
  resourceScope,
  operation,
  status,
  observedAt
}
```

This is not necessarily a public persisted API shape. The required semantics are:

- read capability does not imply write capability;
- authorization for one repository/resource does not imply another;
- prior availability does not imply current availability;
- a replacement conversation must rediscover capabilities it needs;
- long-running execution, provider/tool errors, resource changes, write/destructive boundaries, and publish/release boundaries invalidate assumptions enough to require refresh.

Capability observations may be recorded for diagnostics, but persistence never converts them into timeless truth.

## 10. Mission-session / future-workstream boundary

This RFC does **not** implement multi-Child orchestration or a permanent Child-Brain authority hierarchy.

Current v0.2 execution remains optimized for one active authoritative Parent and the minimum necessary bounded work. Separate implementation, research, or review ChatGPT conversations are disposable mission sessions used for context isolation and specialist work; the persistence model must not treat their conversation IDs as durable project/work authority identity.

If real future dogfood demonstrates multiple independent long-lived lines (for example different repositories/resources), the durable entity should be a **workstream** with its own goal/scope/status/evidence/dependency checkpoint. A ChatGPT specialist session would be a replaceable interaction surface attached to that workstream, not the durable workstream itself.

For v0.2:

- no recursive Child Brain spawning contract;
- no permanent Child/Scoped-Brain authority registry;
- no generic multi-workstream scheduler;
- no multi-authoritative-Brain model;
- no reviewer consensus engine / agent council runtime;
- no concurrency merely because it is technically possible;
- existing resource-scoped single-writer policy remains authoritative.

Independent reviewers are governance evidence sources, not a new runtime workstream subsystem.

## 11. Dogfood isolation

Continuity/fault-injection tests must not share authoritative runtime state or mutable resources with the project control task that is supervising the test.

A real continuity dogfood should use:

- a dedicated branch/worktree or disposable target repository;
- an isolated `dataRoot`;
- a unique logical project/task identity;
- no shared production Governance files;
- no destructive release/default-flip action as the crash test payload.

The orchestrator code under test can be the real candidate build, but the failure-injection workload must be isolated.

## 12. Required acceptance before closing the default-flip blocker

### 12.1 Automated / deterministic tests

At minimum:

1. Governance snapshot survives Local MCP/runtime restart with the same task/step/acceptance/evidence/gate state.
2. Terminal `DONE` remains terminal after restart; non-DONE mutations remain rejected.
3. A RESULT-bearing step is not silently re-executed after restart.
4. `ASK_USER` and any recovery-required local condition survive restart without becoming executable fresh state.
5. Primary-state corruption with a valid backup recovers the backup.
6. Primary + backup corruption fails closed with a named error.
7. Unknown/future schema fails closed or performs an explicit tested migration.
8. Bounded recovery returns `not_found` / unique match / `ambiguous` deterministically and never guesses the most recent task.
9. Parent takeover increments authority generation and stale Parent mutations are rejected.
10. Parent takeover does not duplicate/cancel a still-valid delegated Codex execution.
11. Re-entry reuses the existing Codex durable binding/reconciliation path.
12. Capability availability from a prior session is not trusted as current proof after re-entry.
13. A second canonical runtime attempting to own the same Governance namespace is rejected or fails closed; two concurrent control-state writers are never accepted.
14. Loss of a non-authoritative proof-reuse cache can only force conservative re-verification; it cannot create a pass/acceptance that was not durably justified.

No new automated test is required merely to model reviewers as a runtime authority class, because this clarification explicitly does not create that class.

### 12.2 Real runtime dogfood

A controlled isolated test must demonstrate:

```text
Conversation A
-> PLAN / TASK
-> real Codex execution starts and becomes durable
-> Parent/session interruption
-> Local runtime restart
-> Conversation B
-> user only says the semantic equivalent of “continue this project”
-> bounded logical recovery
-> new Parent authority generation
-> same execution is reconciled (no duplicate turn/job)
-> required capabilities are rediscovered
-> Brain independently verifies authoritative evidence
-> ACCEPT / DONE
```

Required metrics:

- manual internal-ID relay = `0`;
- manual RESULT relay = `0`;
- duplicate execution = `0`;
- stale Parent mutation accepted = `0`;
- concurrent Governance writer accepted = `0`;
- lost required acceptance/evidence = `0`;
- production/control-state pollution from the dogfood = `0`.

## 13. Non-goals for this hardening

This RFC does not require:

- a database or distributed workflow service;
- generic event sourcing;
- a distributed lock manager;
- a multi-agent DAG scheduler;
- recursive Child Brain orchestration;
- a permanent Child/Scoped-Brain authority hierarchy;
- multi-authoritative-Brain voting / consensus;
- reviewer scheduler / reviewer consensus engine / agent council runtime;
- Codex Desktop sidebar integration;
- a rich dashboard/UI;
- generic automatic recovery of “the most recent” task;
- transcript scraping as a source of control truth;
- operational default flip, release, or version bump as part of implementation.

## 14. Implementation guidance

After this RFC is accepted, implementation should be delegated as a **milestone-sized Codex task**, not a sequence of low-level edit commands.

The implementation should prefer these existing primitives:

- `runtimePaths(dataRoot)`;
- atomic JSON persistence pattern from `task-state.js`;
- existing `GovernanceService` lifecycle semantics;
- current JobMap / `codex_recover` contract;
- current mutation-owner and permission contracts;
- existing MCP tool boundary.

The active Parent remains responsible for:

- approving the final contract;
- optional Independent Review Gate when impact/uncertainty warrants it;
- independent review of implementation diff/evidence;
- CI verification;
- controlled real restart/re-entry dogfood;
- deciding whether the default-flip blocker is actually closed.

Independent reviewers may challenge the Parent with evidence, but they do not replace the Parent acceptance boundary or create a majority-vote decision model.

## 15. Decision boundary

Acceptance of this RFC means only:

> This is the current minimum continuity contract to implement and test.

It does **not** mean:

- the first implementation is automatically correct;
- operational default should automatically flip;
- M8 has started;
- future architecture is frozen;
- reviewer/mission sessions form a new multi-agent authority subsystem.

New evidence may produce `REVISE` or `REPLAN`.