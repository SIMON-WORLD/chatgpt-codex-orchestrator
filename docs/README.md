# Documentation Map

This directory contains both **current architecture/contract documents** and **historical design evidence**. They intentionally serve different roles.

When documents disagree about the current project, do not infer recency from an RFC filename alone.

## Current authority

Use these documents for current project decisions:

1. [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md) — current phase, accepted milestones, active blocker, and next action.
2. [`../ROADMAP.md`](../ROADMAP.md) — accepted high-level path; future phases are not pre-invented without evidence.
3. [`../CAPABILITY_ROUTING.md`](../CAPABILITY_ROUTING.md) — normative current capability / route / executor policy, including the minimal Parent/non-Parent mission boundary.
4. [`architecture.md`](architecture.md) — current technical architecture and operational-default vs release/compatibility boundary.
5. [`rfc-v0.2-brain-continuity.md`](rfc-v0.2-brain-continuity.md) — **accepted / implemented / real-dogfood-complete** continuity contract; its pre-implementation body is retained as historical design rationale.
6. [`chatgpt-project-instructions.md`](chatgpt-project-instructions.md) — compact canonical copy/paste source for ChatGPT Project Settings → Instructions after the corresponding change is reviewed and merged.

Implementation truth remains GitHub current code, PRs, CI, and releases. Project Library or narrative handoff material must not silently override newer GitHub evidence.

## Historical / design-input RFCs

These files are retained because they preserve the evidence and reasoning that produced the current architecture. Their original status/date language is intentionally historical and should not be read as current implementation state.

### [`rfc-v0.2-chatgpt-native-capability-inventory.md`](rfc-v0.2-chatgpt-native-capability-inventory.md)

N0 research inventory. It contains dated `OFFICIAL_SUPPORT` / `OBSERVED_LOCAL` evidence from the redesign phase. Capability availability recorded there is a historical observation, **not a timeless runtime capability registry**.

Current runtime availability must be rediscovered from the current ChatGPT/tool/provider/resource/operation surface.

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
- [`../SKILL.md`](../SKILL.md) — repository entry plus last-tagged-release / Alpha.3 compatibility boundary.

The latest tagged release remains `v0.1.0-alpha.3`, but repository operational semantics are capability-first v0.2. Alpha.3 IAB execution remains available only through explicit compatibility/fallback selection and is never a silent response to capability failure.

## Current post-M7 state

At the time of this map:

```text
M0–M7                                      ACCEPTED
Brain Continuity implementation/dogfood   ACCEPTED / COMPLETE
Direct Local / bounded mission / Stable Runtime hardening   ACCEPTED / COMPLETE
Thin Parent / Strong Mission (#43 / PR #44)                 ACCEPTED / COMPLETE
Issue #33 operational-default implementation                ACTIVE / SAME MISSION
M8 RC / release                              NOT STARTED
```

Issue #33 is the implementation candidate for the already-authorized v0.2 default policy; project-level Parent acceptance/merge is still a later boundary, and no version/tag/release is implied.

For live status, always re-read [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md) rather than treating this summary as a status database.
