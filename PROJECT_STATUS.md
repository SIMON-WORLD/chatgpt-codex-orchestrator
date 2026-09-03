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
- **Current accepted main anchor after M7 permission hardening:** PR #13 merge commit `b2a8ee7185f7d4b628c66e48d67557bcf271753f`（实时 `main` 仍以 GitHub 为准）

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

该 hardening 的 ACCEPT 只表示 lifecycle blocker 已通过代码与 CI gate；是否真正解决 M7-B 必须由后续 real-project dogfood 再验证，不能用 unit tests 替代。

### M7-B attempt #2 — runtime permission mismatch

真实仓库：`SIMON-WORLD/agent-workspace-playbook`

结果：**产品任务未完成 / failure-discovery dogfood PASS**。

attempt #2 中，Orchestrator 外层声明 `accessMode=workspace_write` / `sandbox=workspace-write` / `mutationOwner=codex`，但真实 Codex turn 的有效 runtime permission 仍为 read-only / never，workspace mutation、shell/test execution 与 commit/push 路径无法形成。Brain 在同一 Codex thread 自主 REVISE 后再次得到相同 capability mismatch，并保持了安全 mutation ownership lifecycle；未伪造成功、未用 Direct Local 冒充 Codex-required dogfood。

根因由 Brain 独立确认：isolated `CODEX_HOME` profile 静态钉死 read-only/never，而 Executor 的 per-job requested permission 与真实 App Server effective permission 没有形成一致、可验证的 contract。

### M7 real Codex runtime-permission hardening — ACCEPTED

attempt #2 暴露的 permission contract blocker 已通过 R1–R3 修复并由 ChatGPT Brain 独立验收。

最终接受路径：

- isolated Codex profile 只负责 provider/model/credential-safe isolation，不再静态锁死所有 job 为 read-only/never；
- `accessMode` 映射 per-job permission：`read_only` → read-only + never；`workspace_write` → workspace-write + on-request；
- `networkAccess` 是显式 job-level capability，默认 false，不随 workspace write 自动全局放开；
- 使用安全 bootstrap thread，并通过 `thread/settings/update` → `thread/settings/updated` 的真实 `ThreadSettings` 获取 authoritative effective permission evidence；
- requested permission 不再被冒充为 effective permission；缺少 effective evidence / timeout / mismatch 均 fail closed；
- writer ownership 只在 effective permission verification 通过后、真实 task turn 启动前取得；
- `continue()` 只复用与 requested contract 完全匹配的 durable verified snapshot，否则重新 verification；
- effective snapshot 持久化进 JobMap，fresh executor recovery 不因进程内 cache 丢失而把 requested 值重新当 effective；
- workspace-write effective contract 对 sandbox、approval、network 与 writable-root scope 做 exact/bounded verification；parent / drive-root / sibling / outside root 等 scope escalation fail closed；
- read-only 也验证 exact approval/network contract；
- settings waiter request failure / timeout 安全清理，不遗留 orphan promise；
- 新增真实 App Server mutation smoke：Codex 在 disposable temp workspace 内真实创建文件并通过 shell 创建第二文件，Brain-side smoke readback 后才输出 `REAL_CODEX_WORKSPACE_WRITE=PASS`；
- real read-only smoke 同样要求 `effectiveVerified=true` 与 effective read-only evidence。

**Accepted PR:** #13 — `fix: enforce real Codex runtime permission contract`

**Accepted merge commit:** `b2a8ee7185f7d4b628c66e48d67557bcf271753f`

**CI:** Node 22 / Node 24 **PASS**。

Brain 对 permission hardening 的 ACCEPT 只表示 runtime permission contract 的代码、regressions 与 CI gate 已通过；**M7-B 本身仍未 PASS**。是否真正解决 attempt #2 暴露的问题，必须由重新部署后的 real-project **M7-B attempt #3** 验证。

## 当前下一步

1. 将 production local runtime 同步到最新 accepted `main`（至少包含 PR #13 merge commit `b2a8ee7185f7d4b628c66e48d67557bcf271753f`）。
2. Refresh ChatGPT Custom MCP App / tool schema；`codex_start` 现包含 `networkAccess` permission-contract surface，并确认 `codex_reconcile` 仍实际暴露。
3. 原样重跑 `SIMON-WORLD/agent-workspace-playbook` nested `.git` 任务，作为 **M7-B attempt #3**；要求 real Codex、workspace-write effective verification、需要 push 时显式 network capability、manual relay = 0、Brain 独立验收。
4. 完成至少一次 **M7-C Hybrid** real-project dogfood。
5. 基于 M7-A / M7-B / M7-C evidence 单独决定 operational default flip。
6. 进入 M8 RC / release。

## Authority

- **GitHub `main` / current code / PR / CI:** implementation truth / canonical authority。
- **`CAPABILITY_ROUTING.md`:** 当前 routing / executor policy。
- **`docs/architecture.md`:** 当前技术架构事实。
- **`docs/rfc-*`:** 历史研究与设计决策记录。
- **ChatGPT Project Library:** Brain-readable slow-changing reference mirror，不得静默覆盖 GitHub 最新事实。
