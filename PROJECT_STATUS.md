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
- **Current runtime behavior baseline:** 已包含 PR #11 mutation-lifecycle hardening 与 PR #13 runtime-permission hardening；实时 accepted `main` 以 GitHub 为准。

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

结果：**产品任务未完成，但 failure-discovery dogfood 有效**。

- autonomous route selection: **PASS**
- zero manual workspace/job/task/step/RESULT relay: **PASS**
- real Codex delegation: **PASS**
- autonomous `REVISE`: **PASS**
- truthful failure reporting: **PASS**
- Codex write contract: **FAIL**
- mutation reconciliation / cross-route handoff: **FAIL**

### M7 mutation-lifecycle hardening — ACCEPTED

第一次 M7-B dogfood 暴露的 lifecycle/recovery P0 已通过 R1–R6 修复。

关键 accepted evidence：

- `read_only` Codex 不取得 writer ownership；
- `workspace_write` 使用显式 mutation ownership；
- durable turn ↔ mutation-unit identity；
- stale turn notification 不释放其他 mutation unit；
- public `codex_reconcile(workspaceId, jobId)`；
- `thread/resume + thread/read` authoritative reconciliation；
- terminal 只释放 exact writer unit，in-progress 保留 writer，ambiguous/foreign-owner fail closed；
- process-death / cross-route / read-only coexistence regressions 已覆盖。

**Accepted PR:** #11 — `fix: harden v0.2 mutation lifecycle recovery`

**Accepted merge commit:** `66a248dffb3bd85536ea23275eaccc0d9b72090c`

**CI:** Node 22 / Node 24 **PASS**。

### M7-B attempt #2 — runtime permission mismatch

真实仓库：`SIMON-WORLD/agent-workspace-playbook`

结果：**产品任务未完成 / failure-discovery dogfood PASS**。

Lifecycle/recovery 未再次成为 blocker；真实 blocker 是 requested `workspace_write` 与 Codex App Server effective permission 不一致。Brain 独立确认 isolated `CODEX_HOME` profile 静态钉死 read-only/never，导致 workspace mutation、shell/tests 与 commit/push 无法形成。

### M7 real Codex runtime-permission hardening — ACCEPTED

attempt #2 暴露的 permission-contract blocker 已通过 R1–R3 修复并由 ChatGPT Brain 独立验收。

关键 accepted contract：

- isolated Codex profile 仅负责 provider/model/credential-safe isolation；
- `read_only` → read-only + never；`workspace_write` → workspace-write + on-request；
- `networkAccess` 为显式 job-level capability，默认 false；
- `thread/settings/update` → `thread/settings/updated` 获取 authoritative effective `ThreadSettings`；
- requested permission 不再冒充 effective permission；missing evidence / timeout / mismatch fail closed；
- writer ownership 只在 effective permission verification 通过后取得；
- continue/recovery 只复用与 requested contract 一致的 durable verified snapshot；
- sandbox / approval / network / writable roots 做 exact/bounded verification；
- real App Server read-only smoke 与 real workspace-write mutation smoke 均要求 `effectiveVerified=true`。

**Accepted PR:** #13 — `fix: enforce real Codex runtime permission contract`

**Accepted merge commit:** `b2a8ee7185f7d4b628c66e48d67557bcf271753f`

**CI:** Node 22 / Node 24 **PASS**。

### M7-B attempt #3 — production Codex-required dogfood

真实仓库：`SIMON-WORLD/agent-workspace-playbook`

结果：**PASS / ACCEPTED**。

真实目标：修复 `scripts/check_repository_hygiene.py`，检测 repository root `.git` 之外的 nested `.git` directory/gitfile，同时保证 root `.git` 不误报；增加 automated tests；同步双语 README；跑 tests；commit；push dogfood branch。

最终 authoritative evidence：

- route: `CODEX_DELEGATE`
- real Codex execution: **PASS**
- `workspace_write` requested and authoritative effective verification: **PASS**
- `networkAccess=true` for push path: **PASS**
- manual workspace/job/task/step/RESULT relay: **0**
- remote branch: `dogfood/v0.2-nested-git-hygiene`
- implementation commit: `daa5d96c3d87314a56a6f7685d4e7f735483a292`
- changed files: `scripts/check_repository_hygiene.py`, `tests/test_repository_hygiene.py`, `README.md`, `README.zh-CN.md`
- verification PR in target repository: `SIMON-WORLD/agent-workspace-playbook#20`
- PR-triggered GitHub Actions workflow run: `33783730803`
- repository hygiene / commit emails / task structure / index freshness / full test step: **PASS**
- target PR intentionally remains **open / unmerged** as dogfood evidence；无 release/version mutation
- Brain independent GitHub evidence reacquisition: **PASS**
- Governance final state: **ACCEPTED → DONE**

因此 lifecycle hardening + runtime-permission hardening 已被真实 production Codex-required task 共同验证；**M7-B 正式 PASS**。

### M7-B dogfood observations — non-blocking

本轮同时暴露三项真实 UX / observability findings。它们不反向阻塞已经通过的 M7-B correctness，但在 operational default flip 前应重新评估：

1. **Long-running Brain re-entry:** 约 16 分钟 Codex job 期间 ChatGPT turn/UI 曾 timeout，但同一 Codex job 后续真实 completed；durability 有效，但 Brain-side long-running progress/re-entry UX 仍不足。
2. **Codex Desktop thread visibility:** 当前 v0.2 通过独立 `codex app-server --listen stdio://` backend 执行，App Server thread 不一定出现在 Codex Desktop sidebar；用户可见 execution trace 需要后续产品设计/上游能力调查。
3. **Custom App conversation binding:** Refresh Custom App 后，部分既有 ChatGPT conversation 曾出现 tool discovery 与实际 invocation 不一致/失效；新会话可正常使用。暂记录为 product-integration observation，不据此启动 Orchestrator hardening。

以上 observations 仅作为后续 evidence / REPLAN candidates；**当前不自动启动新的 lifecycle/permission hardening。**

## 当前下一步

1. **M7-B 已完成，不再运行 attempt #4。**
2. 选择并执行至少一次 **M7-C Hybrid real-project dogfood**；任务必须让 ChatGPT Product Capability 与 Local Capability Plane 在同一逻辑任务中都承担必要角色，而不是事后拼接 evidence。
3. M7-C 后重新审视 M7-A / M7-B / M7-C evidence，以及上述 long-running / Desktop visibility / Custom App observations。
4. 由 Brain 单独决定是否进行 v0.2 operational default flip；default flip 不是 milestone 自动副作用。
5. 只有完成该 decision 后才进入 M8 RC / release。

## Authority

- **GitHub `main` / current code / PR / CI:** implementation truth / canonical authority。
- **`CAPABILITY_ROUTING.md`:** 当前 routing / executor policy。
- **`docs/architecture.md`:** 当前技术架构事实。
- **`docs/rfc-*`:** 历史研究与设计决策记录。
- **ChatGPT Project Library:** Brain-readable slow-changing reference mirror，不得静默覆盖 GitHub 最新事实。
