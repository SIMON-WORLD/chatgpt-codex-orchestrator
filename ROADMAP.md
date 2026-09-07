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
| Brain Continuity hardening | **CLOSED / ACCEPTED** | Issue #23 / PR #24 merged；formal Conversation A → real runtime restart → Conversation B dogfood PASS |
| Direct Local canonical-path hardening | **ACTIVE** | Issue #27；关闭 symlink/junction sensitive-path policy alias bypass |
| Default-policy review | **DEFERRED** | #27 关闭后重新决策；不自动 flip |
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

M7-C 解决长时 Codex execution 后的 Brain re-entry discovery gap：

- durable orchestration binding (`taskId / stepId / identity`)；
- bounded `codex_recover`；
- exact unique-match recovery；
- no generic `codex_list`；
- no most-recent guessing；
- no generic force unlock；
- no-match / ambiguity / wrong-workspace / stale / foreign-owner fail closed；
- Local MCP restart recovery tests；
- accepted merge `994185503f7cbbf1ed8cd3d1276d8c5654e893f2`。

因此 M7 real-project routing dogfood 已完成：

- `CHATGPT_NATIVE` ✅
- `CODEX_DELEGATE` ✅
- `HYBRID` ✅

## Brain Continuity — CLOSED / ACCEPTED

Post-M7 evidence 证明：logical work、Parent authority 与 acceptance/evidence 不能依赖单一 ChatGPT conversation 或单一 Local runtime process 的内存存活。最小 Brain Continuity contract 已在 [`docs/rfc-v0.2-brain-continuity.md`](docs/rfc-v0.2-brain-continuity.md) 接受并通过 Issue #23 / PR #24 实现。

最终 accepted implementation 已合并到 `main`：

- PR #24 — `feat: implement Brain Continuity core`；
- accepted candidate head `27b9cb53ffdf2e71cfd6b6fbf1721e180df6def5`；
- merge commit `d57bc275805f60bfbe47c9a1f4440e72f1c7d4d6`；
- durable Governance persistence + fail-closed corruption/schema behavior；
- bounded semantic recovery，禁止 most-recent guessing；
- Parent authority generation/fencing；
- takeover 不复制/重启 SAME delegated Codex execution；
- single canonical Governance writer；
- bounded Context Capsule；
- capability observations 保持 ephemeral；
- proof-cache loss 只触发 conservative re-verification。

Formal isolated real-runtime dogfood 已 PASS：

`Conversation A → replacement pre-restart sessions → real Local runtime stop/restart → fresh Conversation B → semantic recovery → SAME execution reconciliation → Parent takeover/fencing → independent evidence reacquisition → isolated ACCEPT/DONE`

最终硬指标全部满足：

- manual internal-ID relay = `0`；
- manual RESULT relay = `0`；
- duplicate execution = `0`；
- stale Parent mutation accepted = `0`；
- concurrent Governance writer accepted = `0`；
- lost required acceptance/evidence = `0`；
- production/control-state pollution = `0`。

Brain Continuity 现已不再阻塞 operational default review。

## Current gate — Direct Local canonical-path hardening (#27)

Independent audit 发现 Direct Local 的 sensitive/blocked-path policy 对 caller-visible alias path 检查，但 workspace-internal symlink/junction 可能指向另一个 canonical sensitive target，从而形成 policy alias bypass。该问题不属于 Brain Continuity correctness，但在 operational default flip 前必须关闭。

Issue #27 的 bounded contract：

1. sensitive/blocked rule 同时检查 requested path 与 canonical target / nearest existing canonical parent；
2. mutation apply 时重新 canonicalize/revalidate，preview → apply 期间 link retarget 必须 fail closed；
3. 保留安全的普通 internal symlink；不做无 evidence 的 blanket ban；
4. regression 至少覆盖 file alias、directory alias/new-file create、preview→apply retarget、Windows junction-equivalent（where feasible）；
5. 正常 deterministic CI；由于项目主要运行在 Windows，评估 Windows Node 24 coverage。

Execution route：`HYBRID`，使用 ONE milestone-sized `CODEX_DELEGATE` 完成 inspect → edit → test → debug → refactor → retest → commit/push；Parent 随后从 GitHub/CI 独立验收。

## Operational default policy review

**Current decision: DEFER operational default flip until Issue #27 closes.**

Brain Continuity blocker 已关闭，但这不自动 flip。#27 通过后，Parent Brain 必须基于当时 current `main`、tests、real-project dogfood、Direct Local safety 与 capability behavior 重新执行一次 default-policy decision。

## Non-blocking observations

以下 finding 保留，但当前不单独阻塞 #27：

- **Codex Desktop thread visibility:** external App Server thread 的 Desktop sidebar live visibility 不可靠；作为独立 upstream/product investigation 处理，不回退 IAB。
- **Passive execution observability:** long-running execution 缺少稳定用户 status/notification surface；后续作为 UX/observability candidate。
- **Custom App conversation capability volatility:** 部分 conversation 曾从可实际调用 Developer MCP 变为 `FORBIDDEN: This conversation does not support developer MCPs`，而 fresh conversation 在 SAME Local MCP/tunnel 上可恢复。该 evidence 强化 capability availability 必须按 session/message boundary 重新发现；Brain Continuity 负责安全 rollover，不声称修复 ChatGPT 平台本身的 capability gate。
- **Node 24 executor test timing:** ownership/permission continuation tests 偶发 timing failure，same-head rerun 可 PASS；保留为 test-stability evidence，不当前视作 Brain Continuity regression。

## M8 — RC / Release

M8 只在 #27 关闭并重新完成 operational default policy decision 后进入。至少需要：

- current code / docs / public Skill/default entry 一致；
- required CI / regression green；
- M7 real-project dogfood evidence 完整；
- Brain Continuity restart/re-entry dogfood PASS；
- operational default 语义真实切换且 legacy IAB 保持 feature-frozen fallback/compatibility boundary；
- state schema / migration / rollback / runtime compatibility 等 release hardening 完成；
- release/version/tag 由 Brain 独立验收后决定。

## M8 之后

不在本文件预设 v0.3 / v0.4 固定阶段。未来方向必须由新的真实需求与 dogfood evidence 驱动，并通过后续 PLAN / RFC 决定。用户现有 GitHub 项目组合（包括长期、多 repo 项目）可以在 v0.2 稳定后成为真实 dogfood portfolio；是否需要 multi-workstream / multi-Child orchestration，由这些真实应用 evidence 再决定。
