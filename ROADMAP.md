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
| M7 — Real-Project Capability Routing Dogfood | **ACTIVE** | Native-only / Codex-required / Hybrid 真实 dogfood + hardening |
| M8 — RC / Release | **PENDING** | v0.2 candidate 的最终独立验收、default policy 与 release decision |

## N3 — 已接受基线

N3 不大规模重写 runtime；它冻结并发布当前控制原则：

- ChatGPT 为 v0.2 唯一 authoritative Brain；
- Evidence first；
- Runtime Capability Discovery precedes routing；
- Route / Capability / Provider 分离；
- Native-first，但不是 Native-only；
- Secure Tunnel + Local MCP = Local Capability Adapter；
- Codex = sustained local coding executor，而非默认下游；
- Executor RESULT 不等于 Brain truth；
- 同一 mutable resource 保持 single authoritative writer。

规范性 policy 见 [`CAPABILITY_ROUTING.md`](CAPABILITY_ROUTING.md)。

N3 已通过 ChatGPT Native GitHub capability 完成文档 branch / mutation / PR / diff review / CI / merge，且无需 Codex、Local MCP 或人工 ID/RESULT 中转；该 landing 同时作为 M7-A Native-only dogfood #1，结果为 **PASS**。

## M7 — 当前验收路径

M7 需要通过真实任务验证三种 execution pattern：

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

第一次 nested `.git` attempt 暴露 mutation lifecycle P0，当前进入 hardening R2，尚未通过。

### M7-C — Hybrid

ChatGPT Product Capability 与 Local Capability Plane 同时参与同一逻辑任务：

`ChatGPT 调查/定案 → Local Executor 执行必要实现 → ChatGPT 重新获取 GitHub/Web/local evidence → ACCEPT / REVISE`

`HYBRID` 是 composition route，不是 mutation owner。

## Default policy decision

v0.2 operational default flip 不是自动发生的 milestone side effect。只有在 M7 的真实 dogfood evidence 足以说明 capability-first 路径稳定、可恢复且不需要用户做人肉 API 后，才由 Brain 单独做 default-policy decision。

## M8 — RC / Release

M8 只在 M7 验收完成后进入。至少需要：

- 当前代码 / docs / public Skill 状态一致；
- required CI / regression green；
- real-project dogfood evidence 完整；
- legacy/default 语义清晰；
- release/version/tag 由 Brain 独立验收后决定。

## M8 之后

不在本文件预设 v0.3 / v0.4 的固定阶段。可能的未来方向（如 generalized resource-scoped mutation leases、Claude/DeepSeek specialist/executor integration、multi-Brain research）必须由新的真实需求与 dogfood evidence 驱动，并通过后续 PLAN / RFC 决定。
