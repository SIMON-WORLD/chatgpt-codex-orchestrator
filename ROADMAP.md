# ROADMAP

> 本文件只记录已经接受的高层路径，不预先发明尚无真实 evidence 支撑的未来实现阶段。新阶段由 ChatGPT Brain 在后续 PLAN / REPLAN 中定义。

## 已接受路径

| 阶段 | 状态 | 说明 |
|---|---|---|
| M0 — v0.2 Architecture Baseline | **CLOSED** | v0.2 RFC / capability / implementation baseline |
| M1 — Codex App Server Executor | **CLOSED** | 结构化 Codex local executor backend |
| M2 — Local MCP | **CLOSED** | workspace read/search/git capability |
| M3 — Direct Local | **CLOSED** | bounded edit / verify / mutation ownership |
| M4 — Router + Governance | **CLOSED** | deterministic route selection + lifecycle governance |
| M5 — Secure Tunnel + Real ChatGPT E2E | **CLOSED** | ChatGPT Web/Desktop → local runtime → Direct/Codex 实链路 |
| M6 — Legacy IAB Isolation | **CLOSED** | IAB / Alpha.4 implementation 隔离到 `src/legacy/` |
| N3 — Capability-First Re-baseline | **CLOSED** | capability-first 已成为当前 operating model |
| M7 — Real-Project Capability Routing Dogfood | **CLOSED / ACCEPTED** | Native-only / Codex-required / Hybrid 全部 PASS |
| Brain Continuity hardening | **ACTIVE / CONTRACT ACCEPTED** | post-M7 REPLAN 已接受；durable Governance + Parent re-entry implementation / dogfood 待完成 |
| Default-policy review | **DEFERRED** | Brain Continuity gate 关闭后重新决策，不自动 flip |
| M8 — RC / Release | **PENDING** | default-policy gate 关闭后再进入 |

## N3 — 已接受基线

N3 冻结当前控制原则：

- ChatGPT 为 v0.2 authoritative Brain；
- Evidence first；
- Runtime Capability Discovery precedes routing；
- Route / Capability / Provider 分离；
- Native-first，但不是 Native-only；
- Secure Tunnel + Local MCP = Local Capability Adapter；
- Codex = sustained local coding executor，而非默认下游；
- Executor RESULT 不等于 Brain truth；
- 同一 mutable resource 保持 single authoritative writer。

规范性 policy 见 [`CAPABILITY_ROUTING.md`](CAPABILITY_ROUTING.md)。

## M7 — ACCEPTED

### M7-A — Native-only

**PASS.** 真实 GitHub Native task 完成 evidence / mutation / PR / CI / merge；Codex calls = 0；Local MCP calls = 0；manual relay = 0。

### M7-B — Codex-required

**PASS.** 通过 `agent-workspace-playbook` nested `.git` hygiene 真实任务完成 Codex-required dogfood。前两次 attempt 分别暴露并推动 mutation-lifecycle hardening 与 runtime-permission hardening；attempt #3 使用真实 Codex workspace-write execution、tests、commit、push 与 Brain independent GitHub/CI verification 成功闭环。

### M7-C — Hybrid

**PASS.** 同一逻辑任务真实同时需要：

`ChatGPT Native investigation / architecture decision → CODEX_DELEGATE implementation → ChatGPT Native diff / PR / CI independent acceptance`

M7-C 解决 M7-B 长时 execution 后的 Brain re-entry discovery gap：

- durable orchestration binding (`taskId / stepId / identity`)；
- bounded `codex_recover`；
- exact unique-match recovery；
- no generic `codex_list`；
- no most-recent guessing；
- no generic force unlock；
- no-match / ambiguity / wrong-workspace / stale / foreign-owner fail closed；
- Local MCP restart recovery tests；
- PR #16 + PR-triggered CI #125 PASS；
- accepted merge `994185503f7cbbf1ed8cd3d1276d8c5654e893f2`。

因此 M7 real-project routing dogfood 已完成：

- `CHATGPT_NATIVE` ✅
- `CODEX_DELEGATE` ✅
- `HYBRID` ✅

## Operational default policy review

M7 完成不自动触发 v0.2 default flip。Brain 已重新评估 M7 dogfood evidence。

### Current decision

**DEFER operational default flip.**

最初 blocker evidence 是：Local MCP/runtime restart 后 Governance state 可能回到 fresh state；当前 `GovernanceService` 的 task/step/acceptance/evidence/Brain-acceptance lifecycle 仍主要是 in-memory，而 M7-C 已使底层 Codex execution 本身具备 durable recovery。

后续真实项目讨论进一步确认：长期系统不能依赖某一条 ChatGPT Parent conversation 永久存在。Parent conversation 可能因上下文过长、会话中断或 product/runtime capability surface 变化而被替换。仅持久化一个 Governance JSON 不足以完整解决这个 continuity problem。

因此 post-M7 已完成一次 Evidence-first REPLAN，并接受 [`docs/rfc-v0.2-brain-continuity.md`](docs/rfc-v0.2-brain-continuity.md) 作为当前最小 contract。

这不是 M7-C failure，也不改变 M7 PASS。它是 M7 dogfood + 后续长期使用 evidence 产生的新的 operational-default gate。

## Current gate — Brain Continuity hardening

**状态：ACTIVE / CONTRACT ACCEPTED / IMPLEMENTATION PENDING**

当前目标：证明 logical work 与 Brain authority 不依赖单一 ChatGPT conversation 或单一 Local runtime process 的内存状态。

最低 contract 包括：

- Canonical Governance state 使用现有 `dataRoot` 形成 versioned durable persistence；
- atomic write + known-good backup；primary + backup 均损坏时 fail closed，禁止 silent fresh reset；
- terminal `DONE`、acceptance、evidence、executorStatus、machineGate、brainAcceptance、publication/blocked state 在 restart 后保持正确；
- 新 Parent conversation 使用稳定、可重建的 project/task semantic identity 做 bounded recovery；
- `0 -> not_found`、`1 -> recover`、`>1 -> ambiguous/fail closed`，禁止 most-recent guessing；
- Parent rollover 使用 durable authority generation / fencing；旧 Parent 的迟到 mutation 必须 `stale_authority`；
- Parent takeover 不自动取消或重复已经授权、仍有效的 Codex execution；
- Brain re-entry 由 durable state 生成 bounded Context Capsule，而不是依赖完整 transcript / narrative handoff；
- capability availability 仍是 ephemeral runtime observation；re-entry 与重要 boundary 需要 rediscovery；
- 同一 Governance namespace 同时只允许一个 canonical Local runtime writer；无需 distributed lock manager，但冲突必须 prevent / fail closed；
- proof-reuse cache 丢失只能导致保守 re-verification，不能创造 pass；
- continuity fault-injection dogfood 必须使用 isolated `dataRoot` / logical identity / mutable target，不能污染当前 authoritative control state；
- manual internal-ID relay = 0；manual RESULT relay = 0；duplicate execution = 0；stale Parent mutation accepted = 0。

当前 **不** 实现：

- generic multi-Child scheduler；
- recursive Child Brain hierarchy；
- multi-authoritative-Brain consensus；
- distributed workflow/database layer；
- generalized DAG engine；
- Codex Desktop sidebar integration；
- rich observability dashboard。

未来多 workstream / multi-Child 能力只在真实长期项目 evidence 证明需要后再单独 PLAN；当前 persistence/API 只需避免把 ChatGPT conversation 本身写成 durable work identity。

## Non-blocking observations

以下 finding 保留，但当前不单独阻塞 Brain Continuity contract acceptance：

- **Codex Desktop thread visibility:** external App Server thread 的 Desktop sidebar live visibility 不可靠；作为独立 upstream/product investigation 处理，不回退 IAB。
- **Passive execution observability:** long-running execution 缺少稳定用户 status/notification surface；后续作为 UX/observability candidate。
- **Custom App conversation binding:** refresh 后部分旧 conversation 的 tool discovery/invocation 可能不一致；fresh conversation 可恢复；这一 observation 强化 capability snapshot 必须 ephemeral，但当前不单独定义新 route。
- **Windows local test process termination:** raw concurrent `node --test` 可出现 lingering process behavior；GitHub CI Node 22/24 已通过，因此当前非 release correctness blocker。

## Brain Continuity implementation / dogfood gate

下一步必须按 accepted RFC 执行，而不是继续架构发散：

1. ChatGPT Parent Brain 独立读取 current main 的 Governance/dataRoot/JobMap/runtime patterns，形成 implementation TASK contract；
2. 将完整 milestone-sized implementation 交给 `CODEX_DELEGATE`，Codex 自行完成 inspect → edit → tests → debug → commit/push loop；
3. Parent Brain 重新读取真实 GitHub commit/diff/PR/CI，不把 Codex RESULT 直接视为 truth；
4. 完成 automated restart/corruption/fencing/recovery tests；
5. 使用 isolated dataRoot + isolated target branch/repo 完成至少一次真实 Conversation A → runtime restart → Conversation B re-entry dogfood；
6. Parent 独立确认无 manual ID relay、无 duplicate execution、无 stale authority acceptance、无 dogfood state pollution；
7. 只有 gate 关闭后，Brain 才重新执行 operational default flip decision。

## M8 — RC / Release

M8 只在 Brain Continuity blocker 关闭并重新完成 operational default policy decision 后进入。至少需要：

- current code / docs / public Skill/default entry 一致；
- required CI / regression green；
- M7 real-project dogfood evidence 完整；
- Brain Continuity restart/re-entry dogfood PASS；
- operational default 语义真实切换且 legacy IAB 保持 feature-frozen fallback/compatibility boundary；
- state schema / migration / rollback / runtime compatibility 等 release hardening 完成；
- release/version/tag 由 Brain 独立验收后决定。

## M8 之后

不在本文件预设 v0.3 / v0.4 固定阶段。未来方向必须由新的真实需求与 dogfood evidence 驱动，并通过后续 PLAN / RFC 决定。用户现有 GitHub 项目组合（包括长期、多 repo 项目）可以在 v0.2 稳定后成为真实 dogfood portfolio；是否需要 multi-workstream / multi-Child orchestration，由这些真实应用 evidence 再决定。
