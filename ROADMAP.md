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
| Direct Local canonical-path hardening | **CLOSED / ACCEPTED** | Issue #27；symlink/junction sensitive-path alias bypass closed |
| Operational default-policy review | **CLOSED / ACCEPTED** | Issue #32；authorized Issue #33 implementation |
| Bounded implementation-session continuity | **CLOSED / ACCEPTED** | Issue #34；scoped execution claim + real preserved-#33 dogfood PASS |
| Stable Runtime activation bootstrap | **CLOSED / ACCEPTED** | Issue #36；exact accepted revision activation path + real dogfood support |
| Thin Parent / Strong Mission policy correction | **ACTIVE** | Issue #43；policy/docs only；branch + PR + Parent independent review |
| v0.2 operational default flip | **PAUSED / SAME MISSION** | Issue #33；resume after #43 Parent acceptance; preserved partial delta remains starting point |
| M8 — RC / Release | **PENDING** | only after explicit Issue #33 Parent acceptance/default decision |

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

## Post-Brain-Continuity hardening — CLOSED / ACCEPTED

### Issue #27 — Direct Local canonical-path hardening

Issue #27 closed the canonical symlink/junction sensitive-path alias bypass and is no longer an operational-default blocker.

### Issue #34 — bounded implementation-session continuity

Issue #33 fresh-session dogfood exposed a control-plane gap: Parent fencing correctly protected project controls, but a disposable bounded non-Parent implementation session could not continue an already-authorized Direct Local step without the Parent token. Issue #34 added a narrow task/step/workspace-scoped execution continuation claim, kept Parent generation/control authority separate, fenced stale claims, and passed the required real dogfood on the preserved Issue #33 worktree.

### Issue #36 — Stable Runtime activation bootstrap

Issue #34 real dogfood required activating the accepted runtime revision without manual shell choreography. Issue #36 added the bounded exact-revision Stable Runtime activation boundary, preserving stable profile/dataRoot/Governance namespace/tunnel identity and enabling the real #34/#33 path.

## Operating-model correction — Issue #43

Recent #33/#34/#36 dogfood proved the v0.2 technical substrate while exposing a workflow problem: Parent conversations repeatedly entered routine implementation/debug hot paths, ordinary bugs caused unnecessary Parent round-trips, and the user risked becoming a conversation message bus.

Issue #43 therefore materializes the bounded project-policy correction:

`Thin Parent / Strong Mission / exception-based escalation`

### Parent owns

- North Star / architecture；
- project policy；
- mission outcome / authoritative acceptance contract；
- material `REPLAN`；
- cross-resource / authority conflict；
- milestone independent acceptance；
- operational default / release decisions。

Parent does not enter routine implementation hot path.

### Bounded mission owns within contract

Once outcome、scope、acceptance、escalation boundary 与 required capability are clear, bounded non-Parent mission continuously progresses：

`inspect → diagnose → implement → test → debug/retry → commit/push → PR → exact-head verification`

A conversation turn, one tool-call boundary, or an ordinary in-scope implementation bug is not an escalation boundary.

### Escalate only on material conditions

- scope / acceptance must change；
- authority / ownership conflict；
- material architecture change；
- destructive / irreversible / high-risk policy；
- capability gap cannot be safely closed inside the authorized route；
- material security / permission / long-term cost / breaking semantics；
- project-level default / release decision。

### Pointer-not-payload / acceptance discipline

- GitHub Issue / PR / CI / current code = implementation/project truth；
- durable Local Governance = live local control truth；
- mission session writes material checkpoint / candidate SHA / PR / CI / residual material risk to durable surfaces；
- user does not relay internal IDs、tokens、RESULT、routine error logs or shell/git/test output；
- Issue body + Parent durable decision define mandatory acceptance；mission prompt cannot silently add new gates；
- dogfood friction is classified P0 / P1 / P2 before it is promoted into new Governance scope。

Canonical session naming：Parent = `① chatgpt-codex-orchestrator | 总控`；others = `chatgpt-codex-orchestrator | #<issue> · <MISSION_TYPE>` where `MISSION_TYPE` is `IMPLEMENT / DOGFOOD / REVIEW / RUNTIME / INVESTIGATE`。

Issue #43 is **policy/docs only**. It does not add runtime/Governance features and must use branch + PR with Parent independent review.

## Operational default flip — SAME Issue #33

Issue #32 already issued explicit default-policy **ACCEPT** and opened Issue #33. The old roadmap state `DEFER until #27 closes` is therefore historical, not current.

Issue #33 remains the authorized bounded implementation milestone that makes the accepted v0.2 capability-first operating model the actual operational default while retaining Alpha.3/IAB as explicit feature-frozen compatibility/fallback.

Current sequence:

1. complete Issue #43 policy/docs candidate → exact-head PR → Parent independent review；
2. after #43 Parent ACCEPT/merge, resume the **SAME Issue #33 durable task / SAME logical mission** from the preserved partial delta under Strong Mission rules；
3. #33 mission autonomously continues inspect → diagnose → implement → tests/debug → commit/push → Draft PR → exact-head Node 22/24 verification；
4. mission posts one material `IMPLEMENTATION_READY_FOR_PARENT_REVIEW` checkpoint and stops；
5. Parent independently reacquires exact GitHub diff/files/tests/CI and decides `ACCEPT / REVISE`。

No second Codex execution is authorized for #33. No Alpha.3 workaround, Parent takeover, manual durable JSON, user token/ID relay, M8/version/tag/release, or project-level self-acceptance is part of this path.

## Non-blocking observations

以下 finding 保留，但当前不自动变成 blocking gate：

- **Codex Desktop thread visibility:** external App Server thread 的 Desktop sidebar live visibility 不可靠；作为独立 upstream/product investigation 处理，不回退 IAB。
- **Passive execution observability:** long-running execution 缺少稳定用户 status/notification surface；后续作为 UX/observability candidate。
- **Custom App conversation capability volatility:** 部分 conversation 曾从可实际调用 Developer MCP 变为 `FORBIDDEN: This conversation does not support developer MCPs`，而 fresh conversation 在 SAME Local MCP/tunnel 上可恢复。availability 必须按 session/message boundary 重新发现。
- **Node 24 executor test timing:** ownership/permission continuation tests 偶发 timing failure，same-head rerun 可 PASS；保留为 test-stability evidence，除非出现 reproducible correctness evidence。
- **Branch protection:** current `main` 尚未强制 required checks；属于后续 delivery hardening candidate，不属于 #43/#33 scope。
- **Parent direct-main mistake:** Issue #43 记录了两次 no-net-content direct-main commits；accepted correction 是 branch + PR discipline，不做 history rewrite，也不创建新 runtime feature。

## M8 — RC / Release

M8 只在 Issue #33 operational-default candidate 经 Parent independent acceptance 后进入。至少需要：

- current code / docs / public Skill/default entry 一致；
- required CI / regression green；
- M7 real-project dogfood evidence 完整；
- Brain Continuity restart/re-entry dogfood PASS；
- bounded mission continuity / Stable Runtime activation evidence 已闭环；
- operational default 语义真实切换且 legacy IAB 保持 feature-frozen fallback/compatibility boundary；
- state schema / migration / rollback / runtime compatibility 等 release hardening 完成；
- release/version/tag 由 Parent 独立验收后决定。

## M8 之后

不在本文件预设 v0.3 / v0.4 固定阶段。未来方向必须由新的真实需求与 dogfood evidence 驱动，并通过后续 PLAN / RFC 决定。是否需要 multi-workstream / multi-Agent orchestration，也只由后续真实 portfolio evidence 决定；v0.2 不预先扩张为 multi-Parent、Child-Brain hierarchy、scheduler、consensus、generic RBAC/lease 或 workflow engine。
