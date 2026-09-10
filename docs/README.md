# Documentation Map

This directory contains both **current architecture/contract documents** and **historical design evidence**. They intentionally serve different roles.

When documents disagree about the current project, do not infer recency from an RFC filename or a static ChatGPT Project mirror. Prefer current GitHub truth and the current normative policy documents.

## Current authority and recovery

For a fresh session / replacement Brain, use this stable recovery sequence:

```text
GitHub current main
→ CAPABILITY_ROUTING.md
→ PROJECT_STATUS.md
→ ROADMAP.md
→ active Issue / mission, if any
→ runtime capability discovery
→ act or escalate
```

Interpret the current sources as follows:

1. **GitHub current `main`, code, PRs, CI, tags, Releases, and active Issue/mission** — implementation/project/publication truth.
2. [`../CAPABILITY_ROUTING.md`](../CAPABILITY_ROUTING.md) — normative capability / route / executor / Parent-mission policy.
3. [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md) — current stable project-status baseline.
4. [`../ROADMAP.md`](../ROADMAP.md) — accepted high-level path and current operating state; future phases are not pre-invented without evidence.
5. [`architecture.md`](architecture.md) — current technical architecture and release/compatibility boundary.
6. [`rfc-v0.2-brain-continuity.md`](rfc-v0.2-brain-continuity.md) — **accepted / implemented / real-dogfood-complete** continuity contract; its pre-implementation body is retained as historical design rationale.
7. [`chatgpt-project-instructions.md`](chatgpt-project-instructions.md) — compact, slow-changing copy/paste bootstrap/constitution for ChatGPT Project Settings.

Durable Local Governance remains the live local control truth when the Local Capability Plane is involved. Narrative handoff material, Project Memory, Library content, and static Project UI mirrors must not silently override newer GitHub evidence.

### ChatGPT Project UI mirror boundary

GitHub current `main` is the durable upstream. ChatGPT Project Instructions / Project Sources are downstream convenience mirrors only:

- routine PR / Issue / CI / policy-detail changes require **zero** manual Project UI maintenance;
- Project Instructions should remain a slow-changing bootstrap/constitution, not a status database;
- static Project Sources should be limited to slow-changing recovery aids and need not remain byte-for-byte synchronized after every repository change;
- when the current session has live GitHub capability, prefer current `main` over stale Project mirrors automatically;
- after Issue #52 is accepted, one bounded human mirror refresh is acceptable if the currently installed Project Instructions/Sources are stale; future refreshes should occur only at material bootstrap/authority-model boundaries.

Do not add Project-source sync automation, a registry, watcher, scheduler, or new Governance/runtime feature without later real P1 evidence that the remaining manual mirror boundary materially blocks normal use.

## Historical / design-input RFCs

These files are retained because they preserve the evidence and reasoning that produced the current architecture. Their original status/date language is intentionally historical and should not be read as current implementation state.

### [`rfc-v0.2-chatgpt-native-capability-inventory.md`](rfc-v0.2-chatgpt-native-capability-inventory.md)

N0 research inventory. It contains dated `OFFICIAL_SUPPORT` / `OBSERVED_LOCAL` evidence from the redesign phase. Capability availability recorded there is a historical observation, **not a timeless runtime capability registry**.

Current runtime availability must be rediscovered from the current ChatGPT tool/action/provider/resource/operation surface. Product capability examples in current docs stay category-level; plan/workspace/surface/provider availability is not snapshotted here as a permanent guarantee.

### [`rfc-v0.2-capability-routing.md`](rfc-v0.2-capability-routing.md)

N1 routing design input. It was written before the routing implementation landed. The implemented/current normative policy is now [`../CAPABILITY_ROUTING.md`](../CAPABILITY_ROUTING.md).

If the historical RFC and `CAPABILITY_ROUTING.md` conflict about current operating policy, use `CAPABILITY_ROUTING.md`.

### [`rfc-v0.2-implementation-architecture.md`](rfc-v0.2-implementation-architecture.md)

N2 implementation/migration design input produced before the M0–M7 implementation sequence. Its audit tables and migration decisions remain valuable history, but statements such as “no MCP/App Server implementation exists yet” describe that earlier baseline, not current `main`.

Use [`architecture.md`](architecture.md) and current source for the present architecture.

### [`rfc-alpha2-delta-packets.md`](rfc-alpha2-delta-packets.md)

Historical Alpha.2 protocol/design RFC. Retained for release history and architectural provenance; it is not the current v0.2 control-plane contract.

## Historical engineering record

### [`development-history.md`](development-history.md)

Archival implementation notes for the IAB / worker-era milestones and earlier reliability work. It deliberately preserves historical module names and decisions.

The Alpha.3 IAB path is still retained as a feature-frozen, explicit compatibility/fallback path, but this file is not the current architecture reference.

## Operational instructions / compatibility boundary

- [`../skills/brain-command/SKILL.md`](../skills/brain-command/SKILL.md) — current capability-first v0.2 operational launcher policy.
- [`../SKILL.md`](../SKILL.md) — repository entry plus v0.2 release / Alpha.3 compatibility boundary.

The latest formal release is **`v0.2.0`**, as proven by GitHub tag / Release readback. M8 / Issue #46 is **CLOSED / DONE** and retained as historical release-control evidence, not a live gate or current release authority. Alpha.3 IAB execution remains available only through explicit feature-frozen compatibility/fallback selection and is never a silent response to capability failure.

## Live status boundary

This map intentionally does **not** maintain a milestone/status snapshot. For live project state, re-read [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md), [`../ROADMAP.md`](../ROADMAP.md), and the current active Issue/mission after first confirming GitHub current `main`.

As of the post-v0.2 baseline, `v0.2.0` is formally released and the repository is in evidence-driven steady-state; that statement does not create automatic v0.2.1/v0.3 scope.
