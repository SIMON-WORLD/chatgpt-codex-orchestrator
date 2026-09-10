# PROJECT_STATUS

> 本文件记录 `chatgpt-codex-orchestrator` 的项目状态基线。实现事实以 GitHub 当前 `main`、代码、PR 与 CI 为最高权威；正式 publication truth 以 GitHub tag / Release readback 为准。`v0.2.0` 已正式发布，M8 / Issue #46 已 DONE；Issue #46 保留为 release-control 历史证据，而不是当前 live authority。本文件用于 Brain 快速恢复稳定上下文，不替代 current active Issue/mission 或 durable Local Governance 的 live control truth。

## North Star

`chatgpt-codex-orchestrator` 的目标是构建一个**以 ChatGPT 为当前 authoritative Brain 的 Capability Orchestrator**：

**Evidence first → Decision → Runtime Capability Discovery → Capability Routing → Execute → Independent Evidence Reacquisition → ACCEPT / REVISE / DONE**

ChatGPT 负责调查、架构、决策、路由与最终验收。Codex 是 sustained local coding executor，不是默认下游。Executor RESULT 是 evidence candidate，不等于 Brain truth。

长期连续性原则：**Brain session 可以替换，但 logical work / authority / evidence 不能依赖单一 conversation 或单一 runtime process 的内存存活。** Conversation 是 interaction/context surface，不是 project/control truth。

当前项目 operating model 已通过 Issue #43 / PR #44 与 Issue #48 / PR #49 固化为 **Thin Parent / Strong Mission / exception-based escalation**，并补充 ongoing Parent / bounded Parent delegation 区分、No Human Relay fallback 与 Act-or-Escalate / no Continue Tax。Project-level Parent 保持 project policy / mission contract / material REPLAN / independent acceptance / default-release authority；bounded non-Parent mission session 在既定 contract 内持续推进 routine implementation，并通过 durable pointer 恢复，不让用户充当 conversation message bus。

## 当前发布 / operational 状态

- **Formal publication truth:** GitHub tag / Release readback 已证明 `v0.2.0` 正式发布；tag `v0.2.0` 指向 release commit `f59930661379fec6ef8b327257f83ddcee015862`，GitHub Release `v0.2.0` 为 non-draft / non-prerelease。后续若 publication 状态发生变化，仍以 GitHub live readback 为准。
- **Repository/default operational contract:** capability-first v0.2；Alpha.3 legacy IAB 仅显式 feature-frozen compatibility/fallback。
- **v0.2:** M0–M8、Brain Continuity、Direct Local canonical-path hardening、bounded implementation-session continuity、Stable Runtime activation bootstrap、explicit default-policy review 与 operational-default flip 均已完成/接受；Issue #33 / PR #45 已 materialize default semantics；Issue #46 已完成 gated publication 并由 Parent final acceptance 关闭。
- **Brain Continuity:** implementation + exact-head CI + formal Conversation A → real runtime restart → Conversation B dogfood **ACCEPTED / COMPLETE**。
- **Issue #34:** **CLOSED / ACCEPTED**；bounded non-Parent execution continuation claim 已通过 preserved Issue #33 real dogfood。
- **Issue #36:** **CLOSED / ACCEPTED**；Stable Runtime exact-revision activation bootstrap 已完成并支持 #34 real dogfood。
- **Issue #43 / PR #44:** **CLOSED / ACCEPTED / MERGED**；Thin Parent / Strong Mission operating policy 已进入 `main`。
- **Issue #33 / PR #45:** **ACCEPTED / MATERIALIZED**；capability-first v0.2 operational-default flip 已闭环。
- **Issue #46 / M8:** **CLOSED / DONE / RELEASED**；`v0.2.0` publication 已完成，GitHub tag/Release 为 publication truth，Issue #46 的 final Parent checkpoint 为 release-control 历史证据。
- **Issue #48 / PR #49:** **CLOSED / ACCEPTED / MERGED**；human-facing Parent discoverability、full Parent replacement vs bounded Parent delegation、No Human Relay fallback、Act-or-Escalate / no Continue Tax 已 materialize 到 current `CAPABILITY_ROUTING.md`。
- **Version metadata:** release line 使用 `0.2.0` metadata；metadata 本身不证明 publication，formal release 仍由 GitHub tag / Release readback 证明。

当前规范性 routing / executor / operating policy 见 [`CAPABILITY_ROUTING.md`](CAPABILITY_ROUTING.md)。Brain Continuity contract 见 [`docs/rfc-v0.2-brain-continuity.md`](docs/rfc-v0.2-brain-continuity.md)。v0.2.0 release/operator contract 见 [`docs/releases/v0.2.0.md`](docs/releases/v0.2.0.md)。

## 已接受基线

| Milestone / Gate | 状态 | 结果 |
|---|---|---|
| M0 | **ACCEPTED** | v0.2 architecture / RFC baseline |
| M1 | **ACCEPTED** | Codex App Server Executor |
| M2 | **ACCEPTED** | Local MCP read/search/git surface |
| M3 | **ACCEPTED** | Direct Local edit/verify + local mutation ownership |
| M4 | **ACCEPTED** | Deterministic Router + Governance |
| M5 | **ACCEPTED** | Secure Tunnel + production runtime + real ChatGPT/Codex E2E |
| M6 | **ACCEPTED** | Legacy IAB isolation under `src/legacy/` |
| N3 | **ACCEPTED** | Capability-First operating model / control-plane re-baseline |
| M7 | **ACCEPTED / COMPLETE** | Native-only + Codex-required + Hybrid real-project dogfood |
| Brain Continuity | **ACCEPTED / COMPLETE** | Issue #23 / PR #24 merged；durable Governance + semantic re-entry + Parent fencing + SAME-execution recovery + formal restart/re-entry dogfood PASS |
| Direct Local canonical-path hardening | **CLOSED / ACCEPTED** | Issue #27；canonical symlink/junction sensitive-path policy hardening merged and accepted |
| Operational default-policy review | **CLOSED / ACCEPTED** | Issue #32；authorized Issue #33 default-flip implementation |
| Bounded implementation-session continuity | **CLOSED / ACCEPTED** | Issue #34；execution continuation claim separated from Parent control authority；real #33 dogfood PASS |
| Stable Runtime activation bootstrap | **CLOSED / ACCEPTED** | Issue #36；exact accepted revision activation with preserved stable profile/state |
| Thin Parent / Strong Mission policy correction | **CLOSED / ACCEPTED** | Issue #43 / PR #44 merged；policy/docs only |
| v0.2 operational default flip | **ACCEPTED / MATERIALIZED** | Issue #33 / PR #45；capability-first v0.2 is repository operational default；Alpha.3 explicit compatibility only |
| M8 RC / Release | **CLOSED / RELEASED** | Issue #46 DONE；`v0.2.0` tag + GitHub Release formally published |
| Parent continuity / no Continue Tax correction | **CLOSED / ACCEPTED** | Issue #48 / PR #49 merged；human-facing naming + bounded Parent delegation + direct durable handoff + Act-or-Escalate |

## M7 — Real-Project Capability Routing Dogfood

**状态：COMPLETE / ACCEPTED**

- **M7-A Native-only = PASS**：GitHub Native evidence / mutation / PR / CI / merge，Codex calls = 0，Local MCP calls = 0，manual relay = 0。
- **M7-B Codex-required = PASS**：`agent-workspace-playbook` nested `.git` hygiene 通过真实 Codex workspace-write execution、tests、commit、push 与 Brain independent GitHub/CI verification 闭环。
- **M7-C Hybrid = PASS**：Native investigation / architecture decision → `CODEX_DELEGATE` implementation → Native diff / PR / CI independent acceptance；accepted merge `994185503f7cbbf1ed8cd3d1276d8c5654e893f2`。

M7-C 已提供 durable execution binding + bounded `codex_recover`，禁止 generic `codex_list`、most-recent guessing 与 generic force unlock。

## Brain Continuity — ACCEPTED / COMPLETE

Post-M7 evidence 证明 executor durability 还不够：ChatGPT Parent conversation 可能因 context、interruption 或 product capability surface 变化而被替换，Local runtime 也可能 restart。因此项目接受并实现最小 Brain Continuity contract。

### Accepted core

Issue #23 / PR #24 已实现并合并：

- versioned durable canonical Governance state under existing `dataRoot`；
- atomic write + known-good backup；corruption / future schema fail closed；
- restart preservation of task / step / acceptance / evidence / executorStatus / machineGate / brainAcceptance / blocked / terminal semantics；
- bounded semantic re-entry：`0 -> not_found`、`1 -> recover`、`>1 -> ambiguous/fail closed`；never most-recent；
- durable Parent authority generation / fencing；stale Parent mutation → `stale_authority`；
- takeover 不 cancel/restart/duplicate already-authorized Codex execution；
- one canonical Governance writer per namespace/dataRoot；conflict fail closed；
- bounded Context Capsule derived from durable state, not transcript dump；
- capability observations remain ephemeral and must be rediscovered；
- proof-cache loss only forces conservative re-verification and cannot create PASS。

Accepted implementation lineage：

- PR #24 — `feat: implement Brain Continuity core`
- accepted candidate head `27b9cb53ffdf2e71cfd6b6fbf1721e180df6def5`
- merge commit `d57bc275805f60bfbe47c9a1f4440e72f1c7d4d6`

### Formal real-runtime dogfood

Formal isolated dogfood completed the required boundary:

`Conversation A → preserved SAME logical task/execution → real Local runtime stop/restart → fresh Conversation B → semantic Governance recovery → SAME Codex recovery/reconciliation → Parent takeover/fencing → independent evidence reacquisition → isolated ACCEPT/DONE`

Final required metrics：

- manual internal-ID relay = `0`；
- manual RESULT relay = `0`；
- duplicate execution = `0`；
- stale Parent mutation accepted = `0`；
- concurrent Governance writer accepted = `0`；
- lost required acceptance/evidence = `0`；
- production/control-state pollution = `0`。

The dogfood additionally observed real ChatGPT product capability volatility: some conversations that had previously invoked Developer MCP later returned `FORBIDDEN: This conversation does not support developer MCPs`, while a fresh conversation on the SAME Local MCP/tunnel could invoke successfully. This is treated as capability-plane evidence, not as Governance corruption. Brain Continuity provides safe session rollover；it does not claim to repair the upstream ChatGPT capability gate itself。

## Post-Brain-Continuity hardening — CLOSED / ACCEPTED

### Issue #27 — Direct Local canonical-path hardening

The symlink/junction sensitive-path alias bypass identified before default review is closed. Current accepted Direct Local behavior evaluates sensitive/blocked policy against canonical targets and preserves apply-time canonical safety；Issue #27 is no longer an operational-default blocker。

### Issue #34 — bounded implementation-session continuity

Issue #33 fresh-session dogfood exposed that Parent fencing alone did not let a disposable bounded non-Parent mission session continue an already-authorized Direct Local step without receiving the Parent token. Issue #34 added a narrow task/step/workspace execution continuation claim, kept Parent generation/control authority separate, fenced stale claims, and passed real dogfood on the preserved Issue #33 worktree.

### Issue #36 — Stable Runtime activation bootstrap

Issue #34 dogfood required activating the accepted exact runtime revision without manual shell choreography. Issue #36 added the bounded exact-revision Stable Runtime activation boundary and completed the real activation path while preserving the stable profile/dataRoot/Governance namespace/tunnel identity.

## Current operating model — Issue #43 + Issue #48 accepted; Issue #33 default flip materialized

Issue #43 was a **project-policy correction**, not another runtime prerequisite. It is **CLOSED / ACCEPTED / MERGED** through PR #44. Issue #48 / PR #49 subsequently applied the smallest post-v0.2 policy correction without changing runtime/Governance schema, fencing, release/version, or routing architecture。

Current policy is:

`Thin Parent / Strong Mission / exception-based escalation`

Key operating rules:

- Parent owns North Star / architecture / project policy / mission acceptance contract / material REPLAN / cross-resource authority conflicts / milestone independent acceptance / default-release decisions；
- bounded mission owns continuous progression inside its contract：`inspect → diagnose → implement → test → debug/retry → commit/push → PR → exact-head verification`；
- ordinary bugs/tool boundaries are not Parent escalation points；known next safe action + unchanged acceptance + sufficient current capability means act, not wait for another user `continue`；
- GitHub Issue/PR/CI/current code remain implementation/project truth；durable Local Governance remains live local control truth；
- direct durable handoff is preferred；only when direct durable read/write is genuinely unavailable may Human Relay be used, and then only for the minimal verdict / material delta / durable evidence pointer；
- Issue body + Parent durable decision define mandatory acceptance；ordinary prompts may not add hidden gates；
- dogfood friction uses P0/P1/P2 classification before creating new Governance work。

Parent continuity / naming rules：

- ongoing project Parent uses sidebar-first `① 总控 · Gnn · ACTIVE | Orchestrator`；current adoption starts at `G01` and does not back-count pre-adoption historical conversations；a genuinely superseded ongoing Parent may be labeled `① 总控 · Gnn · RETIRED | Orchestrator` for human discoverability；
- `Gnn` increments only after a legitimate full replacement of the same durable ongoing Parent completes under the existing authority/reconciliation contract；arbitrary new conversations, ordinary bounded missions/reviews/investigations, and bounded Parent delegation do not increment or use `Gnn`；
- ordinary bounded missions use sidebar-first, project-last `#<issue> · <MISSION_TYPE> | Orchestrator` where `MISSION_TYPE ∈ {IMPLEMENT, DOGFOOD, REVIEW, RUNTIME, INVESTIGATE}`；
- an explicitly authorized bounded Parent delegation / takeover uses `#<issue> · PARENT | Orchestrator`, ends with that bounded scope, and does not use `Gnn`；
- conversation title、`Gnn`、`ACTIVE/RETIRED`、human-readable numbering and rename/archive state are human-facing continuity/discoverability only；they do **not** grant authority or replace durable Governance generation/fencing when Local Capability Plane control is involved；
- no project-level generation registry, conversation pointer service, heartbeat, watcher, lease, scheduler, session manager, Parent/Child topology, or parallel authority source is introduced。

Issue #43 acceptance unblocked the SAME Issue #33 implementation mission. Issue #33 / PR #45 subsequently materialized the accepted capability-first v0.2 default under Strong Mission rules without creating a second Codex execution or new project-level scope. Issue #48 / PR #49 then corrected post-release Parent/session operating policy only。

## Operational default flip — Issue #33

Issue #32 already completed the explicit operational-default review with **ACCEPT** and authorized Issue #33. Therefore the old `DEFER until #27 closes` statement is historical and no longer current policy。

Issue #33 / PR #45 materialized the accepted v0.2 capability-first model as the repository operational default while keeping Alpha.3 legacy IAB explicit, feature-frozen compatibility/fallback。

Accepted/materialized semantics include：

- effective `brain-command` runtime family defaults to `v0.2` when `defaultRuntime` is absent；
- explicit `defaultRuntime='alpha3'` / explicit compatibility opt-in remains supported；
- unknown runtime and capability/provider failure never silently map to Alpha.3；
- canonical Skill begins with runtime capability discovery / Native-first routing；
- Stable Runtime Direct Local is used for bounded local work；Codex is selected only when sustained coding is actually required；
- formal published-version truth is never inferred from local Skill/status/version prose and must be read from GitHub tag / Release state。

The #33 implementation mission is no longer an active gate. Its ACCEPT/materialization did not itself authorize M8；Issue #46 later provided the separate M8 contract and completed publication under its own Parent gates。

## M8 — Issue #46 release control — CLOSED / RELEASED

Issue #46 defined the two-stage bounded release-control contract around exact `v0.2.0` publication and is now **CLOSED / DONE**。The accepted RC was merged，post-merge CI was verified，tag `v0.2.0` was created at release commit `f59930661379fec6ef8b327257f83ddcee015862`，and the matching non-draft / non-prerelease GitHub Release was published。Final Parent reconciliation recorded `PARENT_FINAL — M8 DONE / v0.2.0 RELEASED`。

Historical release-readiness evidence included：

- exact candidate SHA on a release branch；
- Draft PR to `main`；
- semantic version/tag contract (`0.2.0` / `v0.2.0`)；
- release/operator notes distinguishing operational-default state from formal publication；
- release-hardening regressions for Governance migration/recovery, Stable Runtime exact-revision rollback, and runtime-default/no-silent-fallback behavior；
- normal deterministic suite；
- exact-head GitHub CI on Node 22.x and 24.x；
- residual P0/P1/P2 risk classification。

That history remains durable in Issue #46 / PR #47, but it is no longer a live project gate. GitHub tag/Release remains the publication truth。

## Non-blocking observations retained

1. **Codex Desktop thread visibility:** external/independent App Server thread 的 Desktop sidebar live visibility 不可靠；作为 upstream/product investigation，不回退 IAB。
2. **Passive execution observability:** long-running execution 缺少稳定用户 status/notification surface；后续作为 UX/observability candidate。
3. **Developer MCP conversation volatility:** per-conversation invocation may disappear even when the SAME local transport is healthy；availability must be rediscovered rather than assumed。
4. **Node 24 executor test timing:** ownership/permission continuation tests have shown transient timing failures that pass on same-head rerun；retain as test-stability evidence unless reproducible correctness evidence emerges。
5. **Branch protection:** current `main` is not protected by required checks；delivery-hardening candidate，not an automatically authorized new milestone。
6. **Parent direct-main process mistake:** Issue #43 records two no-net-content direct-main commits from Parent preparation；accepted response is branch + PR discipline, not history rewrite or a new runtime feature。

## Fresh-Parent bootstrap / recovery

Fresh Parent / replacement / bounded mission recovery starts from authoritative pointers, not from transcript reconstruction：

`current main → CAPABILITY_ROUTING.md → PROJECT_STATUS.md → ROADMAP.md → current active Issue/mission if any → runtime capability discovery → act or escalate`

Use that sequence as follows：

1. **Current `main`:** establish current repository/code/merged-policy truth before relying on mirrors。
2. **`CAPABILITY_ROUTING.md`:** load current authoritative routing/executor/operating policy, including Parent continuity, mission escalation, No Human Relay and Act-or-Escalate semantics。
3. **`PROJECT_STATUS.md`:** recover the stable accepted baseline and completed publication state without treating this mirror as live control truth。
4. **`ROADMAP.md`:** recover the accepted high-level sequence and current post-v0.2 stabilization / evidence-driven steady-state；do not infer a new v0.2.1/v0.3 milestone。
5. **Current active Issue/mission, if any:** use its body + latest durable Parent decision/checkpoint as the mission outcome/scope/acceptance contract；if none exists, do not invent work from old milestones。
6. **Runtime capability discovery:** treat capability availability as current-session fact and prove required operations before routing。
7. **Act or escalate:** if the next safe action is known, acceptance is unchanged, and required capability is available, act；otherwise escalate only the material blocker through the existing durable surface。

Release-specific recovery remains simple：capability-first v0.2 is the repository operational default；Alpha.3 remains explicit compatibility/fallback only；`v0.2.0` is formally released and M8 / Issue #46 is DONE；formal publication truth remains GitHub `main` + exact tag / Release readback rather than package metadata or prose。

## Authority

- **GitHub `main` / current code / PR / CI / tag / Release:** implementation and publication truth / canonical authority。
- **`CAPABILITY_ROUTING.md`:** current routing / executor / operating policy, including current Parent continuity and Act-or-Escalate semantics。
- **`docs/rfc-v0.2-brain-continuity.md`:** Brain Continuity contract and historical design rationale；current implementation state is also reflected by GitHub code/tests/issues。
- **`docs/architecture.md`:** current technical architecture facts。
- **`docs/releases/v0.2.0.md`:** v0.2.0 release/operator contract, including upgrade/rollback and publication boundary。
- **`ROADMAP.md`:** accepted high-level sequence and post-v0.2 stabilization / evidence-driven steady-state。
- **GitHub Issues / PR comments:** durable mission/checkpoint/review surfaces；Issue #46 is closed release history，while any current active Issue/mission supplies its own durable contract/checkpoints；these surfaces do not replace live Local Governance authority for mutating local control state。
- **Durable Local Governance:** live local control truth when Local Capability Plane execution is involved；human-facing conversation names do not replace its authority generation/fencing semantics。
- **ChatGPT Project Library:** Brain-readable slow-changing reference mirror；must not silently override current GitHub truth。
