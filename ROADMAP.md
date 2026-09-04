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
| Default-policy review | **ACTIVE / DEFERRED** | M7 evidence review 完成；Governance restart durability 为当前 blocker |
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

理由：M7-C dogfood 产生了新的直接 blocker evidence——Local MCP/runtime restart 后 Governance state 可能回到 fresh state；当前 `GovernanceService` 的 task/step/acceptance/evidence/Brain-acceptance lifecycle 仍主要是 in-memory，而当前 operating policy 要求 Local Capability Plane 的 Governance Service 承担持久控制与证据记录。

这不是 M7-C failure。M7-C 的 durable Codex execution recovery 已通过；问题是更上一层的 Brain governance authority 在 runtime restart 后尚未形成同等级的 durable re-entry contract。

### Required next gate: Governance restart durability

下一次 PLAN 应 Evidence-first 调查现有 Governance / dataRoot / durable state patterns，并选择最小正确实现。验收目标至少包括：

- Local MCP/runtime restart 后，能够恢复同一 logical task/step 的治理状态；
- required acceptance / evidence / executorStatus / machineGate / brainAcceptance 不因 restart 静默丢失或被重置成可信 fresh state；
- 已 terminal `DONE` 的 task 不因 restart 被错误重新执行；
- active/ambiguous/recovery-required state fail closed；
- 不要求用户人工保存或中转 taskId/stepId/jobId/RESULT；
- 不绕过已有 Codex execution recovery、mutation-owner、permission contract；
- automated restart tests + 至少一次 real runtime restart/re-entry dogfood；
- Brain 独立重新获取 GitHub/CI/runtime evidence 后才关闭 blocker。

具体 storage schema / API shape 不在 Roadmap 预设，由新的 Evidence-first PLAN 决定。

## Non-blocking observations

以下 finding 保留，但当前不单独阻塞 default flip：

- **Codex Desktop thread visibility:** external App Server thread 的 Desktop sidebar live visibility 不可靠；作为独立 upstream/product investigation 处理，不回退 IAB。
- **Passive execution observability:** long-running execution 缺少稳定用户 status/notification surface；后续作为 UX/observability candidate。
- **Custom App conversation binding:** refresh 后部分旧 conversation 的 tool discovery/invocation 可能不一致；fresh conversation 可恢复；暂作为 product-integration observation。
- **Windows local test process termination:** raw concurrent `node --test` 可出现 lingering process behavior；GitHub CI Node 22/24 已通过，因此当前非 release correctness blocker。

## M8 — RC / Release

M8 只在 Governance durability blocker 关闭并重新完成 operational default policy decision 后进入。至少需要：

- current code / docs / public Skill/default entry 一致；
- required CI / regression green；
- M7 real-project dogfood evidence 完整；
- operational default 语义真实切换且 legacy IAB 保持 feature-frozen fallback/compatibility boundary；
- release/version/tag 由 Brain 独立验收后决定。

## M8 之后

不在本文件预设 v0.3 / v0.4 固定阶段。未来方向必须由新的真实需求与 dogfood evidence 驱动，并通过后续 PLAN / RFC 决定。
