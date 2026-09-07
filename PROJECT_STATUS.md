# PROJECT_STATUS

> 本文件记录 `chatgpt-codex-orchestrator` 的当前项目状态基线。实现事实以 GitHub 当前 `main`、代码、PR 与 CI 为最高权威；本文件用于 Brain 快速恢复阶段上下文。实时 SHA 应重新读取 GitHub。

## North Star

`chatgpt-codex-orchestrator` 的目标是构建一个**以 ChatGPT 为当前 authoritative Brain 的 Capability Orchestrator**：

**Evidence first → Decision → Runtime Capability Discovery → Capability Routing → Execute → Independent Evidence Reacquisition → ACCEPT / REVISE / DONE**

ChatGPT 负责调查、架构、决策、路由与最终验收。Codex 是 sustained local coding executor，不是默认下游。Executor RESULT 是 evidence candidate，不等于 Brain truth。

长期连续性原则：**Brain session 可以替换，但 logical work / authority / evidence 不能依赖单一 conversation 或单一 runtime process 的内存存活。** Conversation 是 interaction/context surface，不是 project/control truth。

## 当前发布 / operational 状态

- **Released version:** `v0.1.0-alpha.3`
- **Released/default operational path:** Alpha.3 legacy IAB Direct Brain Loop（feature-frozen）
- **v0.2:** candidate；M0–M7 与 Brain Continuity core/dogfood 已完成，但尚未 operational default flip / release
- **Brain Continuity:** implementation + exact-head CI + formal Conversation A → real runtime restart → Conversation B dogfood **ACCEPTED / COMPLETE**
- **Current pre-default blocker:** Issue #27 Direct Local canonical symlink/junction sensitive-path policy hardening
- **M8:** 尚未进入
- **Version bump / release:** 尚未执行

当前规范性 routing policy 见 [`CAPABILITY_ROUTING.md`](CAPABILITY_ROUTING.md)。Brain Continuity contract 见 [`docs/rfc-v0.2-brain-continuity.md`](docs/rfc-v0.2-brain-continuity.md)。

## 已接受基线

| Milestone / Gate | 状态 | 结果 |
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
| Brain Continuity | **ACCEPTED / COMPLETE** | Issue #23 / PR #24 merged；durable Governance + semantic re-entry + Parent fencing + SAME-execution recovery + formal restart/re-entry dogfood PASS |
| Direct Local canonical-path hardening | **ACTIVE** | Issue #27；must close before operational default review |

## M7 — Real-Project Capability Routing Dogfood

**状态：COMPLETE / ACCEPTED**

- **M7-A Native-only = PASS**：GitHub Native evidence / mutation / PR / CI / merge，Codex calls = 0，Local MCP calls = 0，manual relay = 0。
- **M7-B Codex-required = PASS**：`agent-workspace-playbook` nested `.git` hygiene 通过真实 Codex workspace-write execution、tests、commit、push 与 Brain independent GitHub/CI verification 闭环。
- **M7-C Hybrid = PASS**：Native investigation / architecture decision → `CODEX_DELEGATE` implementation → Native diff / PR / CI independent acceptance；accepted merge `994185503f7cbbf1ed8cd3d1276d8c5654e893f2`。

M7-C 已提供 durable execution binding + bounded `codex_recover`，禁止 generic `codex_list`、most-recent guessing 与 generic force unlock。

## Brain Continuity — ACCEPTED / COMPLETE

Post-M7 evidence 证明 executor durability 还不够：ChatGPT Parent conversation 可能因 context、interruption 或 product capability surface 变化而被替换，Local runtime 也可能 restart。因此项目接受并实现最小 Brain Continuity contract。

### Accepted core

Issue #23 / PR #24 已实现并合并：

- versioned durable canonical Governance state under existing `dataRoot`；
- atomic write + known-good backup；corruption / future schema fail closed；
- restart preservation of task / step / acceptance / evidence / executorStatus / machineGate / brainAcceptance / blocked / terminal semantics；
- bounded semantic re-entry：`0 -> not_found`、`1 -> recover`、`>1 -> ambiguous/fail closed`；never most-recent；
- durable Parent authority generation / fencing；stale Parent mutation → `stale_authority`；
- takeover 不 cancel/restart/duplicate already-authorized Codex execution；
- one canonical Governance writer per namespace/dataRoot；conflict fail closed；
- bounded Context Capsule derived from durable state, not transcript dump；
- capability observations remain ephemeral and must be rediscovered；
- proof-cache loss only forces conservative re-verification and cannot create PASS。

Accepted implementation lineage：

- PR #24 — `feat: implement Brain Continuity core`
- accepted candidate head `27b9cb53ffdf2e71cfd6b6fbf1721e180df6def5`
- merge commit `d57bc275805f60bfbe47c9a1f4440e72f1c7d4d6`

### Formal real-runtime dogfood

Formal isolated dogfood completed the required boundary:

`Conversation A → preserved SAME logical task/execution → real Local runtime stop/restart → fresh Conversation B → semantic Governance recovery → SAME Codex recovery/reconciliation → Parent takeover/fencing → independent evidence reacquisition → isolated ACCEPT/DONE`

Final required metrics：

- manual internal-ID relay = `0`；
- manual RESULT relay = `0`；
- duplicate execution = `0`；
- stale Parent mutation accepted = `0`；
- concurrent Governance writer accepted = `0`；
- lost required acceptance/evidence = `0`；
- production/control-state pollution = `0`。

The dogfood additionally observed real ChatGPT product capability volatility: some conversations that had previously invoked Developer MCP later returned `FORBIDDEN: This conversation does not support developer MCPs`, while a fresh conversation on the SAME Local MCP/tunnel could invoke successfully. This is treated as capability-plane evidence, not as Governance corruption. Brain Continuity provides safe session rollover; it does not claim to repair the upstream ChatGPT capability gate itself。

## Current pre-default blocker — Issue #27

**Direct Local canonical symlink/junction sensitive-path policy hardening — ACTIVE / BLOCKING operational default review**

Independent audit found that workspace containment already canonicalizes links, but sensitive/blocked-path policy can still be evaluated against the caller-visible alias path rather than the canonical in-workspace target. A safe-looking symlink/junction may therefore alias a sensitive path such as `.git/...` or a secrets path while remaining inside the workspace boundary。

Required bounded fix：

1. Evaluate sensitive/blocked rules against both requested path and canonical target / nearest existing canonical parent。
2. Revalidate canonical mutation target at apply time; preview → apply link retargeting must fail closed。
3. Preserve ordinary safe internal symlinks where compatible; no blanket symlink ban without evidence。
4. Add regressions for file alias, directory alias/new-file create, preview→apply retarget, and Windows junction-equivalent behavior where feasible。
5. Run normal deterministic gates; evaluate Windows Node 24 coverage because the primary operating environment is Windows。

Execution policy：`HYBRID` + ONE milestone-sized `CODEX_DELEGATE`；Codex owns local inspect/edit/test/debug/refactor/retest/commit/push tactics，Parent independently verifies GitHub diff / PR / CI before ACCEPT/REVISE。

## Operational default policy review

**Decision: DEFER until Issue #27 closes.**

Brain Continuity is no longer the blocker and does not automatically trigger the v0.2 default flip. After #27 closes, Parent Brain must re-read current code/docs/tests/dogfood evidence and explicitly choose ACCEPT / REVISE for the operational default policy。

## Non-blocking observations retained

1. **Codex Desktop thread visibility:** external/independent App Server thread 的 Desktop sidebar live visibility 不可靠；作为 upstream/product investigation，不回退 IAB。
2. **Passive execution observability:** long-running execution 缺少稳定用户 status/notification surface；后续作为 UX/observability candidate。
3. **Developer MCP conversation volatility:** per-conversation invocation may disappear even when the SAME local transport is healthy；availability must be rediscovered rather than assumed。
4. **Node 24 executor test timing:** ownership/permission continuation tests have shown transient timing failures that pass on same-head rerun；retain as test-stability evidence unless reproducible correctness evidence emerges。
5. **Branch protection:** current `main` is not protected by required checks；delivery-hardening candidate, not current #27 implementation scope。

## 当前下一步

1. **Issue #27:** bounded Direct Local canonical-path hardening implementation + regressions。
2. **Parent independent acceptance:** exact diff / changed files / CI / Windows-relevant evidence；REVISE if any safety regression。
3. **Operational default-policy review:** only after #27 closes；do not auto-flip。
4. **M8 RC / Release:** only after explicit default-policy ACCEPT；version/tag/release remain unauthorized before that gate。

## Authority

- **GitHub `main` / current code / PR / CI:** implementation truth / canonical authority。
- **`CAPABILITY_ROUTING.md`:** current routing / executor policy。
- **`docs/rfc-v0.2-brain-continuity.md`:** accepted Brain Continuity contract。
- **`docs/architecture.md`:** current technical architecture facts。
- **`ROADMAP.md`:** accepted high-level sequence / current gate。
- **GitHub Issues / PR comments:** durable mission/checkpoint/review surfaces；they do not replace live Local Governance authority for mutating local control state。
- **ChatGPT Project Library:** Brain-readable slow-changing reference mirror；must not silently override current GitHub truth。
