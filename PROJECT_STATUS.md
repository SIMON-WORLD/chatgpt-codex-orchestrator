# PROJECT_STATUS

> 本文件记录 `chatgpt-codex-orchestrator` 的当前项目状态基线。实现事实以 GitHub 当前 `main` 与代码为最高权威；本文件用于 Brain 快速恢复项目阶段上下文。

## North Star

`chatgpt-codex-orchestrator` 的目标是构建一个**以 ChatGPT 为当前唯一 authoritative Brain 的 Capability Orchestrator**：

**Evidence first → Decision → Runtime Capability Discovery → Capability Routing → Execute → Independent Evidence Reacquisition → ACCEPT / REVISE / DONE**

ChatGPT 负责调查、架构、决策、路由和最终验收。Codex 是面向持续本地 coding execution 的重要 Executor，但不是默认下游。未来可以接入 Claude、DeepSeek 或其他 Agent 作为 specialist / advisor / executor；是否引入 multi-Brain authority 属于未来独立架构决策，不属于 v0.2。

## 当前发布状态

- **Released version:** `v0.1.0-alpha.3`
- **Released/default operational path:** Alpha.3 IAB Direct Brain Loop（feature-frozen）
- **v0.2:** candidate，尚未 release，尚未进行 operational default flip
- **Current `main`:** `dbd4e81bbcf0412c0308f817a53b1e8814bc8593`

## 已接受里程碑

| Milestone | 状态 | 结果 |
|---|---|---|
| M0 | **ACCEPTED** | v0.2 architecture / RFC baseline |
| M1 | **ACCEPTED** | Codex App Server Executor |
| M2 | **ACCEPTED** | Local MCP read/search/git surface |
| M3 | **ACCEPTED** | Direct Local edit/verify + local mutation ownership |
| M4 | **ACCEPTED** | Deterministic Router + Governance |
| M5 | **ACCEPTED** | Secure Tunnel + production runtime + real ChatGPT/Codex E2E |
| M6 | **ACCEPTED** | Legacy IAB isolation under `src/legacy/` |

## N3 — Capability-First Re-baseline

**状态：ACTIVE**

N3 将此前的 Capability Routing 设计提升为项目当前 operating model：

- ChatGPT 是 v0.2 唯一 authoritative Brain；
- Route、Capability、Provider 分离；
- ChatGPT Product Capability 包括 Built-in Native 与 Connected Apps；
- Secure Tunnel + Local MCP 是 Local Capability Adapter，而不是所有任务必经的 transport；
- capability availability 是 runtime fact：tool exposed 不等于 provider/resource/operation 实际可用；
- Native-first，但不是 Native-only；
- Executor RESULT 是 evidence candidate，不等于 Brain truth；
- Independent Verify 指 Brain 独立于 Executor claim 重新获取 authoritative evidence，不要求更换 provider；
- 同一 mutable resource 同时只允许一个 authoritative writer；通用 resource-scoped lease 暂作为 policy，不在 N3 大规模重构实现。

当前规范性 routing policy 见 [`CAPABILITY_ROUTING.md`](CAPABILITY_ROUTING.md)。

## M7 — Real-Project Capability Routing Dogfood

**状态：ACTIVE / HARDENING**

M7 不再只验证“ChatGPT 能否自动调用 Codex”，而是验证真实任务下的 capability routing：

- **M7-A Native-only** — ChatGPT Product Capability 足够时，Codex calls = 0。
- **M7-B Codex-required** — 多文件 coding / debug / tests 等需要持续本地 execution 时，真实调用 Codex。
- **M7-C Hybrid** — ChatGPT 调查/定案 → 必要的本地 Executor 执行 → ChatGPT 重新获取 GitHub/Web/local evidence 独立验收。

只有上述 dogfood 形成充分证据后，才决定 operational default flip。

### M7-B attempt #1 — nested `.git` hygiene

真实仓库：`SIMON-WORLD/agent-workspace-playbook`

结果：**产品任务未完成，但 autonomous Brain loop 的多项关键能力已验证。**

- autonomous route selection: **PASS**
- zero manual workspace/job/task/step/RESULT relay: **PASS**
- real Codex delegation: **PASS**
- autonomous `REVISE`: **PASS**
- truthful failure reporting: **PASS**
- Codex write contract: **FAIL**
- mutation reconciliation / cross-route handoff: **FAIL**

Dogfood 暴露的 P0 生命周期缺口已触发 hardening，而不是被隐藏或绕过。

## 当前未合并 hardening

- **Branch:** `fix/v0.2-m7-mutation-lifecycle`
- **HEAD:** `61158495063145b80843300ad8836473eb29cb17`
- **Status:** `REVISE` / not accepted / not merged

该分支已经加入 required `accessMode`、官方 sandbox mapping、terminal ownership release 等修复，但 Brain review 仍发现以下 blocker，后续需要 R2：

- `read_only` Codex 不应取得 writer mutation ownership；
- stale old-turn notification 不得释放当前 active turn writer；
- process-death recovery 需要 ChatGPT 可调用的公开 reconciliation capability；
- observability 必须真实反映 job mutation unit 与当前 global owner 状态。

## 当前下一步

1. 完成 N3 Capability-First control-plane 文档并独立验收。
2. 基于 N3 policy 完成 M7 mutation-lifecycle hardening R2。
3. 以最新 `main` 重启 production runtime，并按 public MCP schema 变化刷新 Custom App（若需要）。
4. 运行 M7-A / M7-B / M7-C 真实 dogfood。
5. 基于 dogfood evidence 决定 operational default flip。
6. 进入 M8 RC / release。

## Authority

- **GitHub `main` / current code / PR / CI:** implementation truth / canonical authority。
- **`CAPABILITY_ROUTING.md`:** 当前 routing / executor policy。
- **`docs/architecture.md`:** 当前技术架构事实。
- **`docs/rfc-*`:** 历史研究与设计决策记录。
- **ChatGPT Project Library:** Brain-readable reference mirror，不得静默覆盖 GitHub 最新事实。
