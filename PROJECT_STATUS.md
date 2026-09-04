# PROJECT_STATUS

> 本文件记录 `chatgpt-codex-orchestrator` 的当前项目状态基线。实现事实以 GitHub 当前 `main`、代码、PR 与 CI 为最高权威；本文件用于 Brain 快速恢复阶段上下文。实时 SHA 应重新读取 GitHub。

## North Star

`chatgpt-codex-orchestrator` 的目标是构建一个**以 ChatGPT 为当前 authoritative Brain 的 Capability Orchestrator**：

**Evidence first → Decision → Runtime Capability Discovery → Capability Routing → Execute → Independent Evidence Reacquisition → ACCEPT / REVISE / DONE**

ChatGPT 负责调查、架构、决策、路由与最终验收。Codex 是 sustained local coding executor，不是默认下游。Executor RESULT 是 evidence candidate，不等于 Brain truth。

## 当前发布 / operational 状态

- **Released version:** `v0.1.0-alpha.3`
- **Released/default operational path:** Alpha.3 legacy IAB Direct Brain Loop（feature-frozen）
- **v0.2:** candidate；核心 capability-first runtime 已完成 M0–M7 dogfood，但尚未 operational default flip / release
- **M8:** 尚未进入
- **Version bump / release:** 尚未执行

当前规范性 routing policy 见 [`CAPABILITY_ROUTING.md`](CAPABILITY_ROUTING.md)。

## 已接受基线

| Milestone | 状态 | 结果 |
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

当前 `GovernanceService` 在 runtime construction 时创建 fresh in-memory state。实际 M7-C sidecar/runtime restart 后曾观察到 governance state 为空，需要 Brain 根据 authoritative conversation/history 重新建立 logical task/step。与此同时，当前规范 policy 明确要求进入 Local Capability Plane 后，Local Governance Service 负责 local execution lifecycle 的持久控制与证据记录。

因此在把 v0.2 设为 operational default 前，需要关闭这个 policy/implementation gap。该结论不反向修改 M7-C PASS；它是 M7 dogfood 产生的新的 post-M7 hardening evidence。

### Default-flip blocker

**Governance durability / restart recovery — BLOCKING**

目标不是重新设计 Governance，而是证明：Local MCP/runtime restart 后，Brain 可以恢复同一 logical task/step 的治理状态和 acceptance/evidence authority，而不依赖用户人工中转内部 ID，也不因 fresh-state reset 产生重复执行或错误 acceptance。

具体实现方案需在下一次 Evidence-first PLAN 中根据现有 runtime/dataRoot/state patterns 决定；不要预先为抽象而抽象。

## Non-blocking observations retained

以下 observation 当前不阻塞 M7 acceptance，也不单独阻塞 default flip；继续作为 architecture / UX evidence：

1. **Codex Desktop thread visibility:** external/independent App Server thread 的 Desktop sidebar live visibility 不可靠；已分流为独立 upstream investigation，不回退 IAB。
2. **Passive execution observability:** long-running execution 可处于 `inProgress / waitingOnApproval / completed / recoveryRequired`，但普通用户缺少稳定 status/notification surface；属于后续 UX/observability candidate。
3. **Custom App conversation binding:** refresh 后旧 conversation 曾出现 discovery/invocation mismatch；fresh conversation 可恢复；暂作为 product-integration observation。
4. **Windows local test process termination:** raw concurrent `node --test` 曾出现 lingering child-handle/termination 行为；GitHub CI Node 22/24 已稳定 PASS，当前不作为 correctness blocker。

## 当前下一步

1. **M7 已完成，不再新增 M7-A/B/C dogfood attempt。**
2. 进入 **post-M7 default-flip hardening**：Evidence-first 调查并解决 Governance restart durability blocker。
3. 用真实 runtime restart / re-entry dogfood 独立验证治理状态恢复，不允许 manual ID/RESULT relay。
4. blocker 关闭后，由 Brain **重新执行 operational default flip decision**；flip 不自动发生。
5. 只有 default-policy decision 通过后才进入 M8 RC / release。

## Authority

- **GitHub `main` / current code / PR / CI:** implementation truth / canonical authority。
- **`CAPABILITY_ROUTING.md`:** 当前 routing / executor policy。
- **`docs/architecture.md`:** 当前技术架构事实。
- **`docs/rfc-*`:** 历史研究与设计决策记录。
- **ChatGPT Project Library:** Brain-readable slow-changing reference mirror，不得静默覆盖 GitHub 最新事实。
