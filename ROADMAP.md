# ROADMAP

> 本文件只记录已经接受的高层路径，不预先发明尚无真实 evidence 支撑的未来实现阶段。新阶段由 ChatGPT Brain 在后续 PLAN / REPLAN 中定义。

## 已接受路径

| 阶段 | 状态 | 说明 |
|---|---|---|
| M0 — v0.2 Architecture Baseline | **CLOSED** | v0.2 RFC / capability / implementation baseline |
| M1 — Codex App Server Executor | **CLOSED** | structured Codex local executor backend |
| M2 — Local MCP | **CLOSED** | workspace read/search/git capability |
| M3 — Direct Local | **CLOSED** | bounded edit / verify / mutation ownership |
| M4 — Router + Governance | **CLOSED** | deterministic route selection + lifecycle governance |
| M5 — Secure Tunnel + Real ChatGPT E2E | **CLOSED** | ChatGPT → local runtime → Direct/Codex real chain |
| M6 — Legacy IAB Isolation | **CLOSED** | IAB / Alpha.4 implementation isolated under `src/legacy/` |
| N3 — Capability-First Re-baseline | **CLOSED** | capability-first current operating model |
| M7 — Real-Project Capability Routing Dogfood | **CLOSED / ACCEPTED** | Native-only / Codex-required / Hybrid all PASS |
| Brain Continuity hardening | **CLOSED / ACCEPTED** | Issue #23 / PR #24 + formal restart/re-entry dogfood PASS |
| Direct Local canonical-path hardening | **CLOSED / ACCEPTED** | Issue #27 |
| Operational default-policy review | **CLOSED / ACCEPTED** | Issue #32；authorized Issue #33 implementation |
| Bounded implementation-session continuity | **CLOSED / ACCEPTED** | Issue #34；scoped execution claim + real preserved-#33 dogfood PASS |
| Stable Runtime activation bootstrap | **CLOSED / ACCEPTED** | Issue #36；exact revision activation |
| Thin Parent / Strong Mission policy correction | **CLOSED / ACCEPTED** | Issue #43 / PR #44 merged |
| v0.2 operational default flip | **ACTIVE / SAME MISSION** | Issue #33 / Draft PR #45；candidate → exact-head CI → Parent independent review |
| M8 — RC / Release | **PENDING** | only after explicit Issue #33 Parent acceptance/default decision |

## N3 — 已接受基线

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

**PASS.** 真实 Codex workspace-write execution、tests、commit、push 与 Brain independent GitHub/CI verification 闭环。

### M7-C — Hybrid

**PASS.** `ChatGPT Native investigation / architecture decision → CODEX_DELEGATE implementation → ChatGPT Native diff / PR / CI independent acceptance`。

M7-C durable recovery contract prohibits generic `codex_list`, most-recent guessing, and generic force unlock.

## Brain Continuity — CLOSED / ACCEPTED

Issue #23 / PR #24 implemented durable Governance persistence, bounded semantic recovery, Parent authority generation/fencing, SAME-execution reconciliation, single canonical Governance writer, bounded Context Capsule, ephemeral capability observations, and conservative proof re-verification.

Formal isolated real-runtime restart/re-entry dogfood passed with zero manual ID/RESULT relay, zero duplicate execution, zero stale Parent mutation accepted, zero concurrent Governance writer accepted, zero lost required evidence, and zero production-state pollution.

## Post-Brain-Continuity hardening — CLOSED / ACCEPTED

- **Issue #27:** canonical symlink/junction sensitive-path hardening closed.
- **Issue #34:** bounded current-step non-Parent execution continuation claim separated from Parent authority; real preserved-#33 dogfood PASS.
- **Issue #36:** Stable Runtime exact-revision activation boundary accepted.

## Operating model — Thin Parent / Strong Mission

Issue #43 / PR #44 is **CLOSED / ACCEPTED / MERGED**.

Parent owns architecture, project policy, mission contract, material REPLAN, cross-resource/authority conflicts, independent acceptance, default and release decisions. Bounded missions own continuous routine progression inside their contract:

`inspect → diagnose → implement → test → debug/retry → commit/push → PR → exact-head verification`

Routine bugs or conversation/tool boundaries are not escalation events. User is not the message bus; GitHub pointers and durable Local Governance carry durable state.

## Operational default flip — SAME Issue #33

Issue #32 already issued explicit default-policy **ACCEPT**. Issue #33 is the authorized implementation milestone.

Current candidate contract:

1. `brain-command` default runtime family resolves to `v0.2`；
2. current runtime capability discovery precedes routing；
3. Native-first when sufficient；
4. Stable Runtime Direct Local only when bounded local capability is needed；
5. Codex only for sustained coding when required；
6. Alpha.3/IAB remains feature-frozen explicit compatibility opt-in；
7. unknown/capability failure never silently falls back to Alpha.3；
8. last tagged release remains `v0.1.0-alpha.3`；
9. no M8/version/tag/release is included。

Current sequence:

1. SAME #33 mission completes Draft PR #45 candidate；
2. exact-head Node 22 / 24 CI；debug/retry in SAME mission if needed；
3. mission posts `IMPLEMENTATION_READY_FOR_PARENT_REVIEW` with exact candidate/evidence and stops；
4. Parent independently reacquires GitHub diff/files/tests/CI and decides `ACCEPT / REVISE`；
5. only after explicit Parent acceptance may a later decision consider merge/default-release/M8 boundaries。

No second Codex execution, Alpha.3 workaround, manual durable JSON, user token/ID relay, or project-level self-acceptance is part of this path.

## Non-blocking observations

- Codex Desktop external thread sidebar visibility remains unreliable；upstream/product issue, not IAB fallback.
- Passive long-running execution observability remains a UX candidate.
- Developer MCP capability can be conversation-volatile；rediscover rather than assume.
- Node 24 timing flake evidence remains non-blocking absent reproducible correctness failure.
- `main` branch protection remains a later delivery-hardening candidate.

## M8 — RC / Release

M8 only begins after explicit Issue #33 Parent acceptance. At minimum it will need current code/docs/Skill consistency, required CI/regression evidence, M7 + Brain Continuity + bounded mission/Stable Runtime evidence, operational-default semantics proven, and separate release/version/tag authority.

## M8 之后

不在本文件预设 v0.3 / v0.4 固定阶段。未来方向必须由新的真实需求与 dogfood evidence 驱动；v0.2 不预先扩张为 multi-Parent、Child-Brain hierarchy、scheduler、consensus、generic RBAC/lease 或 workflow engine。
