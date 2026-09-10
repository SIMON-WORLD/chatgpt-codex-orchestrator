# ROADMAP

> 本文件只记录已经接受的高层路径和当前稳定 operating state，不预先发明尚无真实 evidence 支撑的未来实现阶段。`v0.2.0` 已正式发布，M8 / Issue #46 已 CLOSED / DONE；GitHub tag / Release readback 保持 publication truth。后续新阶段只能由新的真实 evidence 与 authoritative Issue/Parent decision 定义，不从已完成 milestone 自动推导。

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
| Thin Parent / Strong Mission policy correction | **CLOSED / ACCEPTED** | Issue #43 / PR #44 merged |
| v0.2 operational default flip | **ACCEPTED / MATERIALIZED** | Issue #33 / PR #45；capability-first v0.2 is repository operational default；Alpha.3 explicit compatibility only |
| M8 — RC / Release | **CLOSED / RELEASED** | Issue #46 DONE；`v0.2.0` tag + matching GitHub Release formally published |
| Parent continuity / no Continue Tax correction | **CLOSED / ACCEPTED** | Issue #48 / PR #49 merged；human-facing Parent naming、bounded Parent delegation、No Human Relay、Act-or-Escalate materialized |
| Post-v0.2 stabilization / evidence-driven steady-state | **CURRENT OPERATING STATE** | no automatic v0.2.1/v0.3 scope；new implementation requires new P0/P1 evidence or separately accepted product/architecture outcome |

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

Issue #27 closed the canonical symlink/junction sensitive-path alias bypass and is no longer an operational-default blocker。

### Issue #34 — bounded implementation-session continuity

Issue #33 fresh-session dogfood exposed a control-plane gap：Parent fencing correctly protected project controls，but a disposable bounded non-Parent implementation session could not continue an already-authorized Direct Local step without the Parent token。Issue #34 added a narrow task/step/workspace-scoped execution continuation claim，kept Parent generation/control authority separate，fenced stale claims，and passed the required real dogfood on the preserved Issue #33 worktree。

### Issue #36 — Stable Runtime activation bootstrap

Issue #34 real dogfood required activating the accepted runtime revision without manual shell choreography。Issue #36 added the bounded exact-revision Stable Runtime activation boundary，preserving stable profile/dataRoot/Governance namespace/tunnel identity and enabling the real #34/#33 path。

## Operating-model corrections — Issue #43 and Issue #48

Issue #43 materialized the foundational bounded project-policy correction and is **CLOSED / ACCEPTED / MERGED** through PR #44：

`Thin Parent / Strong Mission / exception-based escalation`

Issue #48 / PR #49 later added the smallest post-v0.2 clarification for Parent/session continuity and progression，without changing Brain Continuity runtime、durable Governance schema/API/generation/fencing、Stable Runtime、routing architecture、release/version，or single-writer semantics。

### Parent owns

- North Star / architecture；
- project policy；
- mission outcome / authoritative acceptance contract；
- material `REPLAN`；
- cross-resource / authority conflict；
- milestone independent acceptance；
- operational default / release decisions。

Parent does not enter routine implementation hot path。

### Bounded mission owns within contract

Once outcome、scope、acceptance、escalation boundary 与 required capability are clear，bounded non-Parent mission continuously progresses：

`inspect → diagnose → implement → test → debug/retry → commit/push → PR → exact-head verification`

A conversation turn，one tool-call boundary，an ordinary in-scope implementation bug，or merely needing another user `continue` is not an escalation boundary。Known next safe action + unchanged acceptance + sufficient current capability means act。

### Escalate only on material conditions

- scope / acceptance must change；
- authority / ownership conflict；
- material architecture change；
- destructive / irreversible / high-risk policy；
- capability gap cannot be safely closed inside the authorized route；
- material security / permission / long-term cost / breaking semantics；
- project-level default / release decision。

### Parent continuity / human-facing naming

- ongoing project Parent：`① 总控 · Gnn · ACTIVE | Orchestrator`；current adoption starts at `G01` and does not back-count pre-adoption historical conversations；
- a genuinely superseded ongoing Parent may be human-facing `① 总控 · Gnn · RETIRED | Orchestrator`；
- ordinary bounded mission：`#<issue> · <MISSION_TYPE> | Orchestrator`，where `MISSION_TYPE ∈ {IMPLEMENT, DOGFOOD, REVIEW, RUNTIME, INVESTIGATE}`；ordinary bounded sessions do not use `Gnn`；
- explicitly authorized bounded Parent delegation / takeover：`#<issue> · PARENT | Orchestrator`；its Parent authority ends with the bounded scope and does not make it the ongoing Parent or use `Gnn`；
- titles、`Gnn`、`ACTIVE/RETIRED`、numbers、rename/archive state are human-facing continuity/discoverability only and never grant machine/project authority；Local Governance generation/fencing remains the control truth when its plane is involved；
- no project-level generation registry、conversation pointer service、heartbeat、watcher、lease、scheduler、session manager、Parent/Child topology or second authority source。

### Pointer-not-payload / acceptance discipline

- GitHub Issue / PR / CI / current code = implementation/project truth；
- durable Local Governance = live local control truth；
- mission session writes material checkpoint / candidate SHA / PR / CI / residual material risk to durable surfaces；
- direct durable handoff is preferred；if Human Relay is genuinely unavoidable，request only the minimal verdict / material delta / durable evidence pointer，not full RESULT/review/CI dump/transcript/internal IDs；
- Issue body + Parent durable decision define mandatory acceptance；mission prompt cannot silently add new gates；
- dogfood friction is classified P0 / P1 / P2 before it is promoted into new Governance scope。

Issue #43 was policy/docs only；Issue #48 / PR #49 was also policy/docs only。Neither introduced a new runtime/Governance feature。

## Operational default flip — SAME Issue #33

Issue #32 already issued explicit default-policy **ACCEPT** and opened Issue #33。The old roadmap state `DEFER until #27 closes` is therefore historical，not current。

Issue #33 / PR #45 materialized the accepted v0.2 capability-first operating model as the repository operational default while retaining Alpha.3/IAB as explicit feature-frozen compatibility/fallback。

Post-merge state：

1. capability-first v0.2 operational default is **ACCEPTED / MATERIALIZED** through Issue #33 / PR #45；
2. Alpha.3/IAB remains explicit feature-frozen compatibility/fallback only；
3. Issue #33 is no longer an active operational-default gate；
4. M8 later completed as an independent release boundary through Issue #46 and GitHub publication truth。

The completed #33 mission did not authorize a second Codex execution，Alpha.3 workaround，Parent takeover，manual durable JSON，user token/ID relay，or project-level self-acceptance。M8/version/tag/release remained a separate authority boundary until Issue #46 explicitly authorized and completed publication。

## Non-blocking observations

以下 finding 保留，但当前不自动变成 blocking gate 或新 milestone：

- **Codex Desktop thread visibility:** external App Server thread 的 Desktop sidebar live visibility 不可靠；作为独立 upstream/product investigation 处理，不回退 IAB。
- **Passive execution observability:** long-running execution 缺少稳定用户 status/notification surface；作为 UX/observability candidate，需真实 evidence 才升级。
- **Custom App conversation capability volatility:** 部分 conversation 曾从可实际调用 Developer MCP 变为 `FORBIDDEN: This conversation does not support developer MCPs`，而 fresh conversation 在 SAME Local MCP/tunnel 上可恢复。availability 必须按 session/message boundary 重新发现。
- **Node 24 executor test timing:** ownership/permission continuation tests 偶发 timing failure，same-head rerun 可 PASS；保留为 test-stability evidence，除非出现 reproducible correctness evidence。
- **Branch protection:** current `main` 尚未强制 required checks；属于独立 delivery-hardening candidate，不因 v0.2 release 完成而自动成为新 scope。
- **Parent direct-main mistake:** Issue #43 记录了两次 no-net-content direct-main commits；accepted correction 是 branch + PR discipline，不做 history rewrite，也不创建 new runtime feature。

## M8 — RC / Release — CLOSED / RELEASED

Issue #46 was the canonical M8 release-control surface for semantic version `0.2.0` / tag `v0.2.0`。Its two-stage readiness/publication contract is historical accepted release-control evidence，not current live authority。

Completed publication evidence：

- accepted release candidate was merged through PR #47；
- exact post-merge Node 22.x / 24.x CI was verified；
- exact tag `v0.2.0` points to release commit `f59930661379fec6ef8b327257f83ddcee015862`；
- matching GitHub Release `v0.2.0` is published as non-draft / non-prerelease；
- final bounded Parent reconciliation recorded `PARENT_FINAL — M8 DONE / v0.2.0 RELEASED` and closed Issue #46。

Historical release-readiness evidence remains in Issue #46 / PR #47，including Governance migration/recovery，Stable Runtime exact-revision/no-guess rollback，Node compatibility，explicit Alpha.3 compatibility/no-silent-fallback，exact-head CI and residual P0/P1/P2 classification。Do not rewrite those historical checkpoints as if they were current live gates。

See [`docs/releases/v0.2.0.md`](docs/releases/v0.2.0.md) for the release/operator contract。Formal publication truth remains GitHub tag / Release readback。

## Post-v0.2 stabilization / evidence-driven steady-state

M8 completion does **not** automatically open v0.2.1、v0.3、v0.4 or another implementation milestone。The project is now in stabilization / evidence-driven steady-state：

- continue real-project dogfood under the capability-first v0.2 operational default；
- treat P0 correctness / authority / safety evidence as blocking and eligible to create bounded corrective work；
- treat P1 operability evidence as blocking only when it materially prevents normal use；
- P2 UX / optional-capability observations remain non-blocking and do not automatically create Governance work；
- new implementation scope requires a new authoritative Issue/mission driven by real P0/P1 evidence or a separately accepted product/architecture outcome；
- historical milestone/RFC rationale remains evidence/history，not a latent backlog；
- future multi-workstream / multi-Agent ideas require real portfolio evidence；v0.2 does not pre-expand into multi-Parent、Child-Brain hierarchy、scheduler、consensus、generic RBAC/lease or workflow engine。

For recovery，a fresh Parent should follow the current bootstrap sequence in [`PROJECT_STATUS.md`](PROJECT_STATUS.md)：current `main` → `CAPABILITY_ROUTING.md` → `PROJECT_STATUS.md` → `ROADMAP.md` → current active Issue/mission if any → runtime capability discovery → act or escalate。