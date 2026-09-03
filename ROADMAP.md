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
| M7 — Real-Project Capability Routing Dogfood | **ACTIVE** | Native-only / Codex-required 已 PASS；Hybrid 待验证 |
| M8 — RC / Release | **PENDING** | v0.2 candidate 最终独立验收、default policy 与 release decision |

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

## M7 — 当前验收路径

### M7-A — Native-only

ChatGPT 当前 runtime 已有 capability 足够完成任务时，应直接执行；不为了统一形式调用 Codex 或 Local MCP。

核心指标：

- `route = CHATGPT_NATIVE`
- `Codex calls = 0`
- `manual relay = 0`
- Brain 重新获取真实 resource evidence 后验收

**Attempt #1:** N3 control-plane docs — **PASS**。

### M7-B — Codex-required

多文件 coding、unknown-root-cause debugging、refactor、shell-heavy / iterative tests 等持续本地 execution，应委托 Codex。

核心指标：

- `route = CODEX_DELEGATE`（或 HYBRID 的 Codex local leg）
- real Codex execution
- `manual relay = 0`
- Brain 可自主 `REVISE`
- mutation lifecycle / recovery / handoff 安全闭合
- Brain 独立 review 真实 diff / tests / CI evidence

**Attempt #1:** nested `.git` hygiene — **FAIL as product task / PASS as failure-discovery dogfood**；真实暴露 Codex write contract 与 mutation reconciliation P0。

**Lifecycle hardening:** R1–R6 — **ACCEPTED** via PR #11。Contract 现包含 explicit accessMode、read-only non-writer semantics、durable turn↔unit identity、public `codex_reconcile`、identity-safe process-death recovery、foreign-owner fail-closed 与 cross-route regressions。

**Attempt #2:** nested `.git` hygiene — **FAIL as product task / PASS as failure-discovery dogfood**；lifecycle/recovery 未再次成为 blocker，但真实暴露 Orchestrator requested `workspace_write` 与 Codex effective runtime permission 不一致。

**Runtime-permission hardening:** R1–R3 — **ACCEPTED** via PR #13。Contract 现包含 credential-safe isolated profile、per-job sandbox/approval/network policy、authoritative `thread/settings/updated` effective evidence、pre-turn fail-closed verification、durable verified snapshot、exact approval/network matching、bounded writable-root verification，以及 real read-only / workspace-write App Server smoke。

**Attempt #3:** nested `.git` hygiene — **PASS / ACCEPTED**。

Accepted production evidence：

- real Codex `workspace_write` execution；
- explicit `networkAccess=true` for push path；
- authoritative effective permission verification；
- manual relay = 0；
- target branch `dogfood/v0.2-nested-git-hygiene`；
- implementation commit `daa5d96c3d87314a56a6f7685d4e7f735483a292`；
- verification PR `SIMON-WORLD/agent-workspace-playbook#20`；
- PR-triggered GitHub Actions run `33783730803` PASS，包含 repository hygiene、commit emails、task structure、index freshness 与 full tests；
- Brain 独立 GitHub evidence reacquisition 后 ACCEPT / DONE；
- target PR 保持 open / unmerged；无 release/version mutation。

因此 **M7-B 已 CLOSED as accepted dogfood path**；不再运行 attempt #4。

### M7-B observations — non-blocking

以下 finding 来自真实 attempt #3，但不反向阻塞 M7-B correctness：

- **Long-running Brain re-entry:** ChatGPT turn/UI 可早于约 16 分钟 Codex job 完成而 timeout；同一 job 后续真实 completed，说明 durability 有效但 progress/re-entry UX 不足。
- **Codex Desktop thread visibility:** 独立 App Server backend 的 thread 不一定显示在 Codex Desktop sidebar；需要后续 upstream/product capability 调查与可观测性设计。
- **Custom App conversation binding:** Refresh 后部分既有 ChatGPT conversation 出现 tool discovery / invocation 不一致，新会话可正常使用；暂作为 product-integration observation。

这些 observation 进入后续 evidence review / REPLAN candidate，不自动产生新的 permission/lifecycle hardening。

### M7-C — Hybrid

**NEXT.**

ChatGPT Product Capability 与 Local Capability Plane 必须同时参与同一逻辑任务：

`ChatGPT 调查/定案 → Local Executor 执行必要实现 → ChatGPT 重新获取 GitHub/Web/local evidence → ACCEPT / REVISE`

`HYBRID` 是 composition route，不是 mutation owner。

M7-C 至少需要一次真实项目任务，而且：

- Native leg 必须承担真实必要工作（例如外部/GitHub evidence 调查、架构或产品决策），不能只是装饰性 review；
- Local leg 必须承担 Native capability 不适合完成的本地 execution；
- final acceptance 仍由 Brain 独立重新获取 evidence；
- 不能只是把 M7-A / M7-B 结果写进一篇文档来冒充 Hybrid。

具体 M7-C task 由新的真实 evidence 决定，不在 Roadmap 里预先锁死实现方案。

## Default policy decision

v0.2 operational default flip 不是自动发生的 milestone side effect。只有 M7-A / M7-B / M7-C 的真实 dogfood evidence 足以说明 capability-first 路径稳定、可恢复且不需要用户做人肉 API 后，才由 Brain 单独做 default-policy decision。

在该 decision 前，应同时重新评估 M7-B 暴露的 long-running Brain re-entry、Codex Desktop execution visibility 与 Custom App conversation binding observations，判断哪些属于上游产品限制、哪些需要 Orchestrator 自身 REPLAN。

## M8 — RC / Release

M8 只在 M7 验收完成并完成 default-policy decision 后进入。至少需要：

- 当前代码 / docs / public Skill 状态一致；
- required CI / regression green；
- real-project dogfood evidence 完整；
- legacy/default 语义清晰；
- release/version/tag 由 Brain 独立验收后决定。

## M8 之后

不在本文件预设 v0.3 / v0.4 的固定阶段。可能的未来方向（如 generalized resource-scoped mutation leases、Claude/DeepSeek specialist/executor integration、multi-Brain research）必须由新的真实需求与 dogfood evidence 驱动，并通过后续 PLAN / RFC 决定。
