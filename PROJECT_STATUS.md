# PROJECT_STATUS

> 本文件记录 `chatgpt-codex-orchestrator` 的当前项目状态基线。实现事实以 GitHub 当前 `main`、代码、PR 与 CI 为最高权威；本文件用于 Brain 快速恢复阶段上下文。实时 SHA 应重新读取 GitHub。

## North Star

`chatgpt-codex-orchestrator` 的目标是构建一个**以 ChatGPT 为当前 authoritative Brain 的 Capability Orchestrator**：

**Evidence first → Decision → Runtime Capability Discovery → Capability Routing → Execute → Independent Evidence Reacquisition → ACCEPT / REVISE / DONE**

ChatGPT 负责调查、架构、决策、路由与最终验收。Codex 是 sustained local coding executor，不是默认下游。Executor RESULT 是 evidence candidate，不等于 Brain truth。

长期连续性原则：**Brain session 可以替换，但 logical work / authority / evidence 不能依赖单一 conversation 或单一 runtime process 的内存存活。** Conversation 是 interaction/context surface，不是 project/control truth。

## 当前发布 / operational 状态

- **Released version:** `v0.1.0-alpha.3`
- **Released/default operational path:** Alpha.3 legacy IAB Direct Brain Loop（feature-frozen）
- **v0.2:** candidate；核心 capability-first runtime 已完成 M0–M7 dogfood，但尚未 operational default flip / release
- **Post-M7:** Brain Continuity hardening contract 已接受，implementation / real re-entry dogfood 尚未完成
- **M8:** 尚未进入
- **Version bump / release:** 尚未执行

当前规范性 routing policy 见 [`CAPABILITY_ROUTING.md`](CAPABILITY_ROUTING.md)。当前 Brain Continuity contract 见 [`docs/rfc-v0.2-brain-continuity.md`](docs/rfc-v0.2-brain-continuity.md)。

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
| Brain Continuity contract | **ACCEPTED / CORE IMPLEMENTED (PR #24, isolated)** | durable Governance + Parent re-entry + authority fencing + single canonical Governance writer + Context Capsule; isolated real re-entry dogfood + default-flip still pending |

## M7 — Real-Project Capability Routing Dogfood

**状态：COMPLETE / ACCEPTED**

### M7-A — Native-only

**PASS.** N3 control-plane docs 使用 `route = CHATGPT_NATIVE` 完成 GitHub evidence / mutation / PR / CI / merge；Codex calls = 0，Local MCP calls = 0，manual relay = 0。

### M7-B — Codex-required

**PASS.** `SIMON-WORLD/agent-workspace-playbook` 的 nested `.git` hygiene real-project dogfood 经三次 attempt 完成：

- attempt #1 暴露 mutation lifecycle / recovery contract 缺口；后续 PR #11 hardening ACCEPTED；
- attempt #2 暴露 requested vs effective Codex permission mismatch；后续 PR #13 hardening ACCEPTED；
- attempt #3 真实 Codex `workspace_write` + tests + commit + push 成功；Brain 独立 GitHub/CI 验收；manual relay = 0。

最终 target implementation commit：`daa5d96c3d87314a56a6f7685d4e7f735483a292`；verification PR：`SIMON-WORLD/agent-workspace-playbook#20`；GitHub Actions run `33783730803` PASS。Target PR 按 dogfood contract 保持 open/unmerged。

### M7-C — Hybrid

**PASS / ACCEPTED.** 真实问题来自 M7-B 长时 Codex execution：ChatGPT turn/UI 先 timeout，而 Codex job 后续继续完成；Brain re-entry 后不应要求用户保存/中转 `workspaceId/jobId/threadId/turnId`。

Native investigation 决定最小 contract 为：**durable execution binding + bounded recovery lookup**，而不是 generic `codex_list`。

实现结果：

- Codex job durable mapping 增加 `taskId / stepId / identity` orchestration binding；
- `JobMap.findByBinding()` 提供 bounded identity lookup；
- MCP 增加 `codex_recover`；
- exact unique match 才恢复；`not_found / ambiguous / wrong_workspace / stale` fail closed；
- 不使用 most-recent guessing；不增加 generic force unlock；
- recovery 复用现有 authoritative `resume/reconcile` 与 mutation-owner / permission contract；
- tests 覆盖 exact / ambiguous / wrong-workspace / stale / foreign-owner / Local MCP restart recovery；
- dogfood 中首次 CI #123 暴露旧 ownership test 在 Node 24 的 terminal auto-release race；same task REVISE 后仅修 test determinism，production lifecycle 未修改。

Accepted implementation history：

- `42ed19f5347f9743c66bcf65e2aec7e1d02bfe54` — durable binding + bounded recovery lookup
- `e955f521b526dd311af547c178dd9abb3c54843a` — deterministic mutation-owner race test
- PR #16 — `feat: add durable Codex execution recovery binding (M7-C)`
- push CI #124 — Node 22 / 24 PASS
- PR-triggered CI #125 — PASS
- accepted merge to `main`: `994185503f7cbbf1ed8cd3d1276d8c5654e893f2`

因此：

- **M7-A Native-only = PASS**
- **M7-B Codex-required = PASS**
- **M7-C Hybrid = PASS**
- **M7 overall = COMPLETE / ACCEPTED**

## Post-M7 operational default review

**Decision: DEFER operational default flip.**

M7 A/B/C correctness evidence 足够，但 M7-C dogfood 同时暴露一个新的 default-flip blocker：**Local Governance state 当前不具备 durable restart persistence。**

当前 `GovernanceService` 在 runtime construction 时创建 fresh in-memory state，而底层 Codex execution 已通过 M7-C 获得 durable binding/recovery。这形成不对称：executor 可以恢复，但 Brain governance authority / acceptance lifecycle 仍可能在 runtime restart 后回到 fresh state。

后续长期项目讨论又提供了新的直接使用 evidence：不能假设一条 Parent ChatGPT conversation 永远不会因上下文压力、中断或 product/runtime capability surface 变化而被替换。原先只写成“Governance durability”的 blocker 因此经过 Evidence-first REPLAN，被收敛为更完整但仍最小的 **Brain Continuity** contract。

该 REPLAN 不反向修改 M7 PASS，也不进入 M8；它只是重新定义 operational-default 前必须关闭的 continuity gate。

## Current default-flip blocker

**Brain Continuity / Governance durability — BLOCKING**

已接受 contract：[`docs/rfc-v0.2-brain-continuity.md`](docs/rfc-v0.2-brain-continuity.md)。

### Contract 已冻结的核心语义

1. **Brain sessions are disposable; work state is durable.** Conversation 不是 durable task identity。
2. **Conversation context is not authority.** narrative handoff / summary 不能覆盖 structured Governance / authoritative GitHub/runtime evidence。
3. Canonical Governance state 必须使用 existing `dataRoot` 形成 versioned durable persistence；优先复用 atomic JSON + `.bak` pattern，不引入无 evidence 支撑的 database/workflow service。
4. Corruption / unknown schema 必须 fail closed，禁止 silent `_freshState()` reset。
5. 新 Parent conversation 使用稳定、可重建的 project/task semantic identity 做 bounded recovery：`0 -> not_found`、`1 -> recover`、`>1 -> ambiguous/fail closed`；禁止 most-recent guessing。
6. Parent rollover 必须有 durable authority generation / fencing；新 Parent 接管后，旧 Parent 的迟到 mutation 必须 `stale_authority`。
7. Parent authority 与 executor delegation 分离：takeover 不自动取消、重启或复制已经授权且仍有效的 Codex execution。
8. Brain re-entry 由 durable state 生成 bounded **Context Capsule**；不要求用户人工转发 giant transcript handoff。
9. Capability availability 是 ephemeral observation；re-entry、long-running execution 后、provider failure、resource change、write/destructive/publish boundaries 需要 refresh/rediscovery。
10. 同一 Governance namespace 同时只能有一个 canonical Local runtime writer；不要求 distributed lock manager，但双 runtime writer 必须被 prevent / fail closed。
11. `proofLedger` 等 verification-reuse cache 如果不能安全重建，只能触发 conservative re-verification，不能生成新的 pass/acceptance。
12. continuity fault-injection dogfood 必须 isolated：独立 `dataRoot`、logical identity、target branch/repo，不得污染 supervising project 的 authoritative control state。
13. `Delegate outcomes, not keystrokes`：implementation 以 milestone-sized Codex TASK 为默认，不把本地 inspect/edit/test loop 拆成大量 Parent round-trips。

### 明确 non-goals

当前 **不** 建设：

- multi-Child scheduler；
- recursive Child Brain tree；
- generalized work DAG；
- multi-authoritative-Brain consensus；
- distributed lock/database/workflow service；
- Codex Desktop sidebar integration；
- rich execution dashboard。

未来如果真实长期项目出现多个独立 workstream，应把 durable work identity 设计成 workstream，而不是某条 Child conversation；是否真正实现 multi-workstream / multi-Child orchestration，必须等待后续真实 dogfood evidence。

## Brain Continuity acceptance gate

### 当前实现状态（Issue #23 / Draft PR #24）

Brain Continuity **core** 已作为 isolated milestone 在 `feat/brain-continuity-core` 实现并 push（Draft PR #24，未 merge）：

- durable canonical Governance state 位于 `runtime/governance/<namespace>/`（versioned schema + atomic write + known-good `.bak`；fail-closed load：primary corrupt + backup good 恢复，双 corrupt 抛命名错误，future schema 抛 `schema_unsupported`，v0 有显式 tested migration）；
- restart 恢复 task/step/acceptance/evidence/executorStatus/machineGate/brainAcceptance；`DONE` 保持 terminal；RESULT-bearing step 不 silent re-execute；`ASK_USER` / recovery-required 状态不被 reset 成 fresh executable state；
- bounded semantic re-entry `0 -> not_found`、`1 -> unique`、`>1 -> ambiguous/fail closed`，never most-recent；
- durable Parent authority generation/fencing：takeover 递增 generation 并发新 opaque token，stale Parent mutation 抛 `stale_authority`；
- takeover 只走既有 `executor.recover` 路径 reconcile，不 cancel/restart/duplicate delegated Codex execution；
- 同一 Governance namespace/dataRoot 单 canonical writer：live owner 永不因 heartbeat 过期被 reclaim，第二个 writer 被 `writer_conflict` fail closed；每次 durable mutation 前先 assert ownership，失去 slot 的旧 writer 不能写任何 state（lightweight guard，非 distributed lock manager）；
- bounded Context Capsule 由 durable structured state 生成（不 dump transcript）；capability observation 保持 ephemeral，re-entry 必须 rediscovery；proof-reuse cache 丢失只触发 conservative re-verification，不生成 pass/acceptance；
- 新增 deterministic tests：`test/governance/{store,writer-guard,durable,capsule-observation}.test.js`、`test/mcp/governance-durable.test.js`（全部随 `npm test` 运行）。

该 core 不构成 default flip：operational default 仍未 flip，M8 未开始，真实 Conversation A → runtime restart → Conversation B re-entry dogfood 仍未执行，blocker 保持 open。

在把该 blocker 关闭前，至少需要：

### Automated / deterministic

- restart 后恢复同一 task/step/acceptance/evidence/executorStatus/machineGate/brainAcceptance；
- terminal `DONE` 继续 terminal；RESULT-bearing step 不 duplicate execute；
- `ASK_USER` / recovery-required local condition 不被 reset 成 fresh executable state；
- primary corrupt + backup good 可恢复；primary + backup corrupt fail closed；
- future/unknown schema fail closed 或明确 migration；
- bounded recovery `not_found / unique / ambiguous`；
- stale Parent fencing；
- Parent takeover 不 duplicate/cancel active Codex delegation；
- second canonical runtime writer 被拒绝/fail closed；
- stale capability snapshot 不作为 re-entry 后当前 availability proof；
- proof cache loss 只导致 re-verification，不导致 pass。

### Real runtime / conversation re-entry

使用 isolated dataRoot + isolated mutable target，真实证明：

`Conversation A → PLAN/TASK → real Codex running → Parent/session interruption → Local runtime restart → Conversation B → 用户仅表达“继续这个项目” → bounded recovery → new Parent authority → same Codex execution reconcile → capability rediscovery → independent evidence reacquisition → ACCEPT/DONE`

硬指标：

- manual internal-ID relay = `0`；
- manual RESULT relay = `0`；
- duplicate execution = `0`；
- stale Parent mutation accepted = `0`；
- concurrent Governance writer accepted = `0`；
- lost required acceptance/evidence = `0`；
- dogfood production/control-state pollution = `0`。

## Non-blocking observations retained

以下 observation 当前不阻塞 M7 acceptance，也不单独阻塞 Brain Continuity contract acceptance；继续作为 architecture / UX evidence：

1. **Codex Desktop thread visibility:** external/independent App Server thread 的 Desktop sidebar live visibility 不可靠；已分流为独立 upstream investigation，不回退 IAB。
2. **Passive execution observability:** long-running execution 可处于 `inProgress / waitingOnApproval / completed / recoveryRequired`，但普通用户缺少稳定 status/notification surface；属于后续 UX/observability candidate。
3. **Custom App conversation binding:** refresh 后旧 conversation 曾出现 discovery/invocation mismatch；fresh conversation 可恢复；这一 observation 强化 capability snapshot 必须 task/session-ephemeral。
4. **Windows local test process termination:** raw concurrent `node --test` 曾出现 lingering child-handle/termination 行为；GitHub CI Node 22/24 已稳定 PASS，当前不作为 correctness blocker。

## 当前下一步

1. **M7 已完成，不再新增 M7-A/B/C dogfood attempt。**
2. **Brain Continuity core 已实现于 Issue #23 / Draft PR #24（isolated，未 merge）。** Parent Brain 独立 review PR diff / exact-head CI 后 ACCEPT/REVISE；不默认 flip。
3. implementation 通过 automated tests 后，由 Parent Brain 另行授权执行 isolated real Conversation A → B runtime restart/re-entry dogfood（独立 dataRoot / semantic identity / target repo）。
4. blocker 关闭后，由 Brain **重新执行 operational default flip decision**；flip 不自动发生。
5. 只有 default-policy decision 通过后才进入 M8 RC / release。

## Authority

- **GitHub `main` / current code / PR / CI:** implementation truth / canonical authority。
- **`CAPABILITY_ROUTING.md`:** 当前 routing / executor policy。
- **`docs/rfc-v0.2-brain-continuity.md`:** 当前 post-M7 Brain Continuity contract。
- **`docs/architecture.md`:** 当前技术架构事实。
- **`docs/rfc-*`:** 历史研究与设计决策记录；accepted contract 仍可由新 evidence 触发后续 `REPLAN`。
- **ChatGPT Project Library:** Brain-readable slow-changing reference mirror，不得静默覆盖 GitHub 最新事实。
