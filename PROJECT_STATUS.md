# PROJECT_STATUS

> 本文件记录 `chatgpt-codex-orchestrator` 的当前项目状态基线。实现事实以 GitHub 当前 `main`、代码、PR 与 CI 为最高权威；本文件用于 Brain 快速恢复阶段上下文。实时 SHA 应重新读取 GitHub。

## North Star

`chatgpt-codex-orchestrator` 的目标是构建一个**以 ChatGPT 为当前 authoritative Brain 的 Capability Orchestrator**：

**Evidence first → Decision → Runtime Capability Discovery → Capability Routing → Execute → Independent Evidence Reacquisition → ACCEPT / REVISE / DONE**

ChatGPT 负责调查、架构、决策、路由与最终验收。Codex 是 sustained local coding executor，不是默认下游。Executor RESULT 是 evidence candidate，不等于 Brain truth。

长期连续性原则：**Brain session 可以替换，但 logical work / authority / evidence 不能依赖单一 conversation 或单一 runtime process 的内存存活。** Conversation 是 interaction/context surface，不是 project/control truth。

当前 operating model 为 **Thin Parent / Strong Mission / exception-based escalation**：project-level Parent 保持 project policy / mission contract / material REPLAN / independent acceptance / default-release authority；bounded non-Parent mission session 在既定 contract 内持续推进 routine implementation，并通过 durable pointer 恢复，不让用户充当 conversation message bus。

## 当前发布 / operational 状态

- **Latest tagged release:** `v0.1.0-alpha.3`
- **Repository operational contract in the Issue #33 candidate:** capability-first v0.2 / Native-first；Stable Runtime 只在需要 local capability 时进入
- **Alpha.3 legacy IAB:** feature-frozen；仅显式 compatibility/fallback opt-in；capability/provider failure 不得 silent fallback
- **M0–M7:** **ACCEPTED / COMPLETE**
- **Brain Continuity:** implementation + exact-head CI + formal Conversation A → real runtime restart → Conversation B dogfood **ACCEPTED / COMPLETE**
- **Issue #27:** **CLOSED / ACCEPTED**；Direct Local canonical symlink/junction sensitive-path hardening complete
- **Issue #32:** **CLOSED / ACCEPTED**；explicit operational default-policy review authorized Issue #33
- **Issue #34:** **CLOSED / ACCEPTED**；bounded non-Parent execution continuation claim 通过 preserved Issue #33 real dogfood
- **Issue #36:** **CLOSED / ACCEPTED**；Stable Runtime exact-revision activation bootstrap complete
- **Issue #43 / PR #44:** **CLOSED / ACCEPTED / MERGED**；Thin Parent / Strong Mission operating policy 已进入 `main`
- **Issue #33 / Draft PR #45:** **ACTIVE / SAME IMPLEMENTATION MISSION**；candidate 正在 materialize 已授权 v0.2 default semantics；仍需 exact-head CI + Parent independent acceptance
- **M8:** 尚未进入
- **Version bump / tag / release:** 尚未执行

当前规范性 routing / executor / operating policy 见 [`CAPABILITY_ROUTING.md`](CAPABILITY_ROUTING.md)。Brain Continuity contract 见 [`docs/rfc-v0.2-brain-continuity.md`](docs/rfc-v0.2-brain-continuity.md)。

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
| Brain Continuity | **ACCEPTED / COMPLETE** | Issue #23 / PR #24；durable Governance + semantic re-entry + Parent fencing + SAME-execution recovery + formal restart/re-entry dogfood PASS |
| Direct Local canonical-path hardening | **CLOSED / ACCEPTED** | Issue #27 |
| Operational default-policy review | **CLOSED / ACCEPTED** | Issue #32；authorized Issue #33 |
| Bounded implementation-session continuity | **CLOSED / ACCEPTED** | Issue #34；execution claim separated from Parent control authority；real #33 dogfood PASS |
| Stable Runtime activation bootstrap | **CLOSED / ACCEPTED** | Issue #36 |
| Thin Parent / Strong Mission policy correction | **CLOSED / ACCEPTED** | Issue #43 / PR #44 merged |
| v0.2 operational default flip | **ACTIVE / SAME MISSION** | Issue #33 / Draft PR #45；implementation candidate, awaiting exact-head CI then Parent review |
| M8 RC / Release | **PENDING** | only after explicit Issue #33 Parent acceptance |

## M7 — Real-Project Capability Routing Dogfood

**状态：COMPLETE / ACCEPTED**

- **M7-A Native-only = PASS**：GitHub Native evidence / mutation / PR / CI / merge，Codex calls = 0，Local MCP calls = 0，manual relay = 0。
- **M7-B Codex-required = PASS**：真实 Codex workspace-write execution、tests、commit、push 与 Brain independent GitHub/CI verification 闭环。
- **M7-C Hybrid = PASS**：Native investigation / architecture decision → `CODEX_DELEGATE` implementation → Native diff / PR / CI independent acceptance。

M7-C 提供 durable execution binding + bounded `codex_recover`，禁止 generic `codex_list`、most-recent guessing 与 generic force unlock。

## Brain Continuity — ACCEPTED / COMPLETE

Issue #23 / PR #24 已实现并合并最小 Brain Continuity contract：

- versioned durable canonical Governance state under existing `dataRoot`；
- atomic write + known-good backup；corruption / future schema fail closed；
- restart preservation of task / step / acceptance / evidence / executorStatus / machineGate / brainAcceptance / blocked / terminal semantics；
- bounded semantic re-entry：`0 -> not_found`、`1 -> recover`、`>1 -> ambiguous/fail closed`；never most-recent；
- durable Parent authority generation / fencing；stale Parent mutation → `stale_authority`；
- takeover 不 cancel/restart/duplicate already-authorized Codex execution；
- one canonical Governance writer per namespace/dataRoot；
- bounded Context Capsule derived from durable state；
- capability observations remain ephemeral；
- proof-cache loss only forces conservative re-verification。

Formal isolated dogfood completed:

`Conversation A → preserved SAME logical task/execution → real Local runtime stop/restart → Conversation B → semantic Governance recovery → SAME Codex recovery/reconciliation → Parent takeover/fencing → independent evidence reacquisition → isolated ACCEPT/DONE`

Required metrics all passed: manual internal-ID relay = 0；manual RESULT relay = 0；duplicate execution = 0；stale Parent mutation accepted = 0；concurrent Governance writer accepted = 0；lost required acceptance/evidence = 0；production/control-state pollution = 0。

## Post-Brain-Continuity hardening — CLOSED / ACCEPTED

### Issue #27 — Direct Local canonical-path hardening

Canonical symlink/junction sensitive-path alias bypass closed and no longer blocks operational-default work.

### Issue #34 — bounded implementation-session continuity

Adds a narrow task/step/workspace-scoped execution continuation claim for disposable bounded non-Parent sessions, keeps Parent generation/control authority separate, fences stale claims, and passed real dogfood on the preserved Issue #33 worktree.

### Issue #36 — Stable Runtime activation bootstrap

Adds bounded exact-revision Stable Runtime activation while preserving stable profile/dataRoot/Governance namespace/tunnel identity.

## Operating model — Thin Parent / Strong Mission

Issue #43 / PR #44 is **CLOSED / ACCEPTED / MERGED**. Current policy:

`Thin Parent / Strong Mission / exception-based escalation`

Parent owns North Star / architecture / project policy / mission acceptance contract / material REPLAN / cross-resource authority conflicts / milestone independent acceptance / operational default-release decisions.

Bounded mission continuously progresses inside its contract:

`inspect → diagnose → implement → test → debug/retry → commit/push → PR → exact-head verification`

Conversation turn boundaries, ordinary bugs, or a single tool-call boundary do not trigger Parent escalation. Escalate only when scope/acceptance must change, authority/ownership conflicts, material architecture/destructive/security/cost/breaking issues arise, a capability gap cannot safely close within route, or a project-level default/release decision is required.

Pointer-not-payload: GitHub Issue/PR/CI/current code = implementation/project truth；durable Local Governance = live local control truth；user does not relay internal IDs/tokens/RESULT/routine logs。

## Operational default flip — SAME Issue #33

Issue #32 already issued explicit default-policy **ACCEPT** and authorized Issue #33. Issue #43 did not change #33 scope or acceptance; it changed only the operating policy under which the SAME mission progresses.

Issue #33 candidate semantics:

- `brain-command` effective default runtime family = `v0.2` when `defaultRuntime` is absent；
- explicit `defaultRuntime='alpha3'` / explicit compatibility opt-in remains supported；
- unknown runtime / capability-provider failure never silently maps into Alpha.3；
- canonical Skill starts with runtime capability discovery and Native-first routing；
- Stable Runtime Direct Local is used for bounded local work；Codex only when sustained coding is required；
- last tagged release remains `v0.1.0-alpha.3`；
- no M8/version/tag/release is implied。

Draft PR #45 is the current implementation candidate. This mission may implement, test, debug, push, and obtain exact-head CI, but it does **not** self-issue project-level `ACCEPT`, merge, default-release, or project `DONE`.

## Non-blocking observations retained

1. **Codex Desktop thread visibility:** external App Server thread sidebar visibility remains unreliable；upstream/product observation, not IAB fallback trigger。
2. **Passive execution observability:** long-running execution lacks a stable passive user status surface；future UX candidate。
3. **Developer MCP conversation volatility:** capability may disappear per conversation while SAME transport remains healthy；availability must be rediscovered rather than assumed。
4. **Node 24 executor test timing:** retain transient timing evidence unless reproducible correctness failure appears。
5. **Branch protection:** current `main` does not enforce required checks；delivery-hardening candidate, not #33 scope。

## 当前下一步

1. Complete SAME Issue #33 candidate on Draft PR #45；
2. Obtain exact-head Node 22 / 24 CI；debug/retry in SAME mission if needed；
3. Post one material `IMPLEMENTATION_READY_FOR_PARENT_REVIEW` checkpoint with exact candidate SHA / PR / changed files / CI / residual material risk；
4. Parent independently reacquires exact GitHub diff/files/tests/CI and decides `ACCEPT / REVISE`；
5. M8/version/tag/release remain unauthorized until separate explicit Parent decision。

## Authority

- **GitHub `main` / current code / PR / CI:** implementation truth / canonical authority。
- **`CAPABILITY_ROUTING.md`:** current routing / executor / operating policy。
- **`docs/rfc-v0.2-brain-continuity.md`:** Brain Continuity contract and historical design rationale。
- **`docs/architecture.md`:** current technical architecture facts。
- **`ROADMAP.md`:** accepted high-level sequence / current gate。
- **GitHub Issues / PR comments:** durable mission/checkpoint/review surfaces；they do not replace live Local Governance authority for mutating local control state。
