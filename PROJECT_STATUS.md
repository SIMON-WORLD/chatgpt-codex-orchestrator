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

### M7-B attempt #2 — real Codex runtime permission contract (in progress, NOT accepted)

真实 dogfood attempt #2 暴露一个 **production contract 不一致**：外层声明 `accessMode=workspace_write` / `sandbox=workspace-write` / `mutationOwner=codex`，但真实 Codex turn 内部仍为 `sandbox_mode=read-only`、`approval_policy=never`，workspace mutation 与 shell/test 执行均被 policy block。

根因（Brain 独立确认 + 本机 schema 核实）：

- `src/transport/codex-profile.js` 的隔离 CODEX_HOME profile 硬编码 `approval_policy = "never"`、`sandbox_mode = "read-only"`；
- `AppServerExecutor.start()` 在 thread/start 传了 `sandbox`，但 turn/start 未传 `sandboxPolicy` / `approvalPolicy`，导致 turn 继承 profile 的 read-only/never 默认值；
- `thread/start` 响应中的 `sandbox` 是 **legacy 字段**（schema 标注："Legacy sandbox policy retained for compatibility. Experimental clients should prefer `activePermissionProfile` for profile provenance."）——在本机真实 App Server 上，即便请求 `sandbox=workspace-write` 也返回 `readOnly`，因此不能作为有效权限的判据。

本轮（runtime-permission-contract）完成：

- 隔离 profile 不再把任务静态锁死为 `sandbox_mode=read-only` / `approval_policy=never`（只负责 provider/model/credential-safe isolation）；
- `accessMode` 映射为真实 effective permission：`read_only` → read-only + never；`workspace_write` → workspace-write + on-request；
- 每条 Codex job 通过 **turn/start `sandboxPolicy`** 显式下发（权威机制），并给定 `writableRoots` 收窄到目标 workspace；`start` 与 `continue` 保持同一 permission contract；
- 新增最小 job-level `networkAccess` 标志（默认 false），仅用于 git push 等需要网络的情形，不无条件放开；
- `codex_get` / `codex_start` 返回 `permissionContract`（requested/effective/effectiveVerified）；对 requested workspace_write 但有效权限为 read-only 的情况 fail closed，不再让 Brain 等 8 分钟才发现；
- 新增 REAL workspace-write mutation smoke：真实 Codex 在临时 workspace 创建 probe 文件 + 通过 shell 写第二个文件，`REAL_CODEX_WORKSPACE_WRITE=PASS`；+ python 能力探测（本机结果为 policy_blocked）。

**重要：本轮尚未宣称 M7-B 通过。** 该 hardening 只保证 permission contract 与真实 App Server 一致；是否真正解决 M7-B 必须由下一次 real-project dogfood attempt 再验证。

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
