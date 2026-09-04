# Documentation Map

This directory contains both **current architecture/contract documents** and **historical design evidence**. They intentionally serve different roles.

When documents disagree about the current project, do not infer recency from an RFC filename alone.

## Current authority

Use these documents for current project decisions:

1. [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md) — current phase, accepted milestones, active blocker, and next action.
2. [`../ROADMAP.md`](../ROADMAP.md) — accepted high-level path; future phases are not pre-invented without evidence.
3. [`../CAPABILITY_ROUTING.md`](../CAPABILITY_ROUTING.md) — normative current capability / route / executor policy.
4. [`architecture.md`](architecture.md) — current technical architecture and released-vs-candidate boundary.
5. [`rfc-v0.2-brain-continuity.md`](rfc-v0.2-brain-continuity.md) — **accepted post-M7 contract**, with implementation / real restart-re-entry dogfood still pending.

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

The released Alpha.3 IAB path is still retained as a feature-frozen fallback, but this file is not the current architecture reference.

## Released operational instructions

- [`../SKILL.md`](../SKILL.md)
- [`../skills/brain-command/SKILL.md`](../skills/brain-command/SKILL.md)

These describe the currently released Alpha.3 operational fallback. They must not be used to infer that the legacy IAB architecture remains the canonical v0.2 architecture. Until an explicit default-policy flip occurs, however, their released Alpha.3 execution instructions remain valid for that fallback.

## Current post-M7 state

At the time of this map:

```text
M0–M7                         ACCEPTED
Brain Continuity contract     ACCEPTED
Brain Continuity implementation / real dogfood     PENDING
Operational default flip      DEFERRED
M8 RC / release               NOT STARTED
```

For live status, always re-read [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md) rather than treating this summary as a status database.
