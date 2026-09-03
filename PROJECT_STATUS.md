# PROJECT_STATUS

> 本文件记录 `chatgpt-codex-orchestrator` 的当前项目状态基线。实现事实以 GitHub 当前 `main`、代码、PR 与 CI 为最高权威；本文件用于 Brain 快速恢复阶段上下文。实时 SHA 应重新读取 GitHub。

## North Star

`chatgpt-codex-orchestrator` 的目标是构建一个**以 ChatGPT 为当前 authoritative Brain 的 Capability Orchestrator**：

**Evidence first → Decision → Runtime Capability Discovery → Capability Routing → Execute → Independent Evidence Reacquisition → ACCEPT / REVISE / DONE**

ChatGPT 负责调查、架构、决策、路由与最终验收。Codex 是面向持续本地 coding execution 的重要 Executor，但不是默认下游。未来可接入 Claude、DeepSeek 或其他 Agent 作为 specialist / advisor / executor；是否引入 multi-Brain authority 属于未来独立架构决策，不属于 v0.2。

## 当前发布状态

- **Released version:** `v0.1.0-alpha.3`
- **Released/default operational path:** Alpha.3 IAB Direct Brain Loop（feature-frozen）
- **v0.2:** candidate，尚未 release，尚未进行 operational default flip
- **Current accepted main anchor after M7 hardening:** PR #11 merge commit `66a248dffb3bd85536ea23275eaccc0d9b72090c`（实时 `main` 仍以 GitHub 为准）

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

当前规范性 routing policy 见 [`CAPABILITY_ROUTING.md`](CAPABILITY_ROUTING.md)。

## M7 — Real-Project Capability Routing Dogfood

**状态：ACTIVE / DOGFOOD**

M7 验证三种真实 execution pattern：

- **M7-A Native-only** — ChatGPT Product Capability 足够时，Codex calls = 0。
- **M7-B Codex-required** — 多文件 coding / debug / tests 需要持续本地 execution 时，真实调用 Codex。
- **M7-C Hybrid** — ChatGPT 调查/定案 → Local Executor 执行 → ChatGPT 重新获取 GitHub/Web/local evidence 独立验收。

只有真实 dogfood evidence 足够后，才决定 operational default flip。

### M7-A attempt #1 — N3 control-plane docs

结果：**PASS**。

- route: `CHATGPT_NATIVE`
- GitHub evidence / branch / file mutation / PR / diff review / CI / merge: **PASS**
- Codex calls: **0**
- Local MCP calls: **0**
- manual workspace/job/task/step/RESULT relay: **0**

该任务同时验证了 Runtime Capability Discovery：tool exposed 不代表 provider/resource authorization 已满足；ChatGPT Codex Connector 授权补齐后，GitHub Native write probe 通过。

### M7-B attempt #1 — nested `.git` hygiene

真实仓库：`SIMON-WORLD/agent-workspace-playbook`

结果：**产品任务未完成，但 autonomous Brain loop 的关键能力已验证，并暴露真实 mutation lifecycle P0。**

- autonomous route selection: **PASS**
- zero manual workspace/job/task/step/RESULT relay: **PASS**
- real Codex delegation: **PASS**
- autonomous `REVISE`: **PASS**
- truthful failure reporting: **PASS**
- Codex write contract: **FAIL**
- mutation reconciliation / cross-route handoff: **FAIL**

### M7 mutation-lifecycle hardening — ACCEPTED

第一次 M7-B dogfood 暴露的 P0 已经过 R1–R6 修复，并由 ChatGPT Brain 逐轮独立 GitHub review 后验收。

最终接受路径：

- `read_only` Codex 不取得 writer ownership；
- `workspace_write` accessMode 显式映射到 App Server sandbox；
- stale turn notification 与 mutation-unit identity 关联，且 identity 可持久化并跨 executor restart 恢复；
- `codex_get` 对 recovery-required 状态返回结构化 guidance；
- 新增公开 MCP capability `codex_reconcile(workspaceId, jobId)`；
- `reconcile()` / `resume()` 共用 authoritative `thread/resume + thread/read` identity-safe recovery；
- terminal 只释放 exact writer unit；in-progress 保留 exact writer；ambiguous / foreign owner fail closed；
- observability 区分 job mutation unit 与 active owner unit；
- cross-route / process-death / read-only coexistence / stale-turn regressions 已加入。

**Accepted PR:** #11 — `fix: harden v0.2 mutation lifecycle recovery`

**Accepted merge commit:** `66a248dffb3bd85536ea23275eaccc0d9b72090c`

**CI:** Node 22 / Node 24 **PASS**。

该 hardening 的 ACCEPT 只表示 lifecycle blocker 已通过代码与 CI gate；是否真正解决 M7-B 必须由下一次 real-project dogfood 再验证，不能用 unit tests 替代。

## 当前下一步

1. 将 production local runtime 同步到最新 accepted `main`。
2. 因新增 `codex_reconcile`，刷新 ChatGPT Custom MCP App / tool schema，并确认新 capability 实际暴露。
3. 重跑 `SIMON-WORLD/agent-workspace-playbook` 的 nested `.git` 任务，作为 **M7-B attempt #2**；要求 real Codex、manual relay = 0、Brain 独立验收。
4. 完成至少一次 **M7-C Hybrid** real-project dogfood。
5. 基于 M7-A / M7-B / M7-C evidence 单独决定 operational default flip。
6. 进入 M8 RC / release。

## Authority

- **GitHub `main` / current code / PR / CI:** implementation truth / canonical authority。
- **`CAPABILITY_ROUTING.md`:** 当前 routing / executor policy。
- **`docs/architecture.md`:** 当前技术架构事实。
- **`docs/rfc-*`:** 历史研究与设计决策记录。
- **ChatGPT Project Library:** Brain-readable slow-changing reference mirror，不得静默覆盖 GitHub 最新事实。
