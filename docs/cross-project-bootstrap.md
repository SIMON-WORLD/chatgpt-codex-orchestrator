# Cross-project Operating Model bootstrap

This document defines the preferred onboarding and recovery path for a ChatGPT Project that reuses the `chatgpt-codex-orchestrator` Operating Model without copying a large or changing policy payload into every Project.

`CAPABILITY_ROUTING.md` remains the normative shared operating/routing policy. The kernel manifest, stable project anchor, and project-local control are pointers/contracts with distinct ownership; none is a second shared policy authority.

## Four layers

Keep these layers separate:

1. **Operating Kernel** — current canonical `SIMON-WORLD/chatgpt-codex-orchestrator` policy and recovery sources.
2. **Stable Project Anchor** — project identity, UI label, one stable `projectRoot`, one stable `controlRoot`, and stable project overlays.
3. **Project-local Durable Control + Live Mission Authority** — downstream-owned evolving truth: control revision/provenance/lifecycle, exact active mission or `none + nextSafeAction`, plus project-specific resource/privacy/authority pointers. Live mutation authority remains destination-scoped and is not stored in the anchor.
4. **Ephemeral Runtime Capability Envelope** — what the current ChatGPT session can actually execute now.

A profile, repository mention, tool schema, provider connection, conversation title, memory, transcript, reference project, or capability observation never grants mutation authority.

## Deterministic autonomous recovery

A fresh or replacement downstream Parent recovers in this order:

`canonical orchestrator current main -> kernel manifest + CAPABILITY_ROUTING.md -> stable project anchor -> unique current project-local control head -> exact active mission OR nextSafeAction -> fresh runtime capability discovery -> route or fail closed`

The bootstrap records the exact observed kernel commit SHA. Default recovery observes GitHub current `main`; an explicit exact-SHA pin is allowed only when deliberately requested for reproducibility and must remain visibly a pin.

The stable anchor does not change when missions advance. It must not contain an active Issue/PR/mission, next action, mutable scope, runtime capability snapshot, route choice, device state, credentials/tokens, or task/job/thread/workspace IDs. Those facts belong to downstream durable control, live authority, or the current runtime.

Provider adapters may return bounded observations from the designated `controlRoot`. The pure autonomous resolver accepts exactly one matching control head. It never ranks by recency, issue number, revision number, UI order, transcript, memory, or cross-project state. Zero matching observations means GENESIS is possible only when the durable control truly does not exist; a foreign-root observation, duplicate matching heads, stale control, or writer conflict fails closed.

## Stable project anchor / preferred profile

The preferred persistent contract is profile schema v2. Its stable fields are:

- `projectKey` and `uiLabel`;
- `compatibleKernelSchemaMajor`;
- one provider-neutral `projectRoot` pointer;
- one provider-neutral `controlRoot` pointer;
- stable `durableSources` and `overlays` only when needed;
- optional evidence-only `referenceProjects`.

Schema v1 remains compatibility input for #78-era callers, but new autonomous Projects should use the v2 stable-root shape. The one-time Project Settings seed uses the same stable facts and contains no live mission pointer.

Project-specific scientific, privacy, publishing, content, device, or product rules stay in downstream control/overlays. The shared kernel does not import those semantics from Academic Door, China Demand, Notion Management, Clash Rules, or any other reference project.

## Project-local durable control

Downstream-owned control is provider-neutral and evolving. The minimal normalized contract contains:

- `projectKey`, `controlId`, and a control `revision`;
- `freshness=current` and a conflict-free single-writer observation;
- Parent/control provenance;
- lifecycle/control-state information and project-specific pointers;
- exactly one of `activeMissionRef` or `nextSafeAction`.

`activeMissionRef` is an exact project-local durable reference. GitHub Issues are one valid provider form, but Notion pages/databases or other durable provider-native references are equally valid. The orchestrator does not own a central project registry or downstream mission registry.

When control has an active mission and live mission authority is bound, the two references must match exactly. When control says `none + nextSafeAction`, stale live mission authority is rejected rather than reused.

## Bounded GENESIS

A truly new Project may have a stable anchor but no durable control yet. In that case the downstream Project Parent may enter GENESIS only with one narrow Human Principal authorization containing:

- minimal project identity/charter and hard boundaries;
- the exact designated durable control root;
- permission only for `CREATE_MINIMAL_PROJECT_CONTROL`.

GENESIS does not grant general repository/resource mutation authority. Once project-local control exists, it supersedes GENESIS input for ordinary recovery. Existing control cannot be silently rebound, replaced, or overwritten by a seed or repeated GENESIS authorization.

## Runtime capability doctor and routing

Capability availability is task/session-scoped. For every required operation distinguish `exposed`, `executable`, `resourceAuthorized`, and `constraintsSufficient`; only when all four are true is the operation `AVAILABLE`.

Native-first means use sufficient executable ChatGPT-native operations directly. Local MCP / Direct Local / Codex are selected only from current-session evidence. Local absence never silently falls back to Alpha.3. Runtime capability is rediscovered on replacement recovery; a prior session's capability snapshot is never inherited as current truth.

Capability never creates Parent authority, mission scope, mutable-repository scope, or GENESIS authority.

## Uniform provider-neutral UI naming

All Projects use one visual grammar:

- ongoing Parent: `① 总控 · Gnn · ACTIVE | <uiLabel>`
- superseded Parent: `① 总控 · Gnn · RETIRED | <uiLabel>`
- ordinary mission: `<missionDisplayRef> · <MISSION_TYPE> | <uiLabel>`
- bounded Parent: `<missionDisplayRef> · PARENT | <uiLabel>`

For GitHub-backed missions, `<missionDisplayRef>` can remain the familiar `#42`. Provider-native projects may use a stable local reference such as `M-07`. Names are discoverability only and never grant authority.

Current mission types are `IMPLEMENT`, `DOGFOOD`, `REVIEW`, `RUNTIME`, and `INVESTIGATE`.

## Tiny Project Settings seed

Use `docs/project-bootstrap-seed.md`. The preferred seed contains only the shared-kernel adoption semantics and the stable project/control roots. It intentionally contains no changing mission pointer. Project Settings therefore stay unchanged while control progresses from one mission to the next.

ChatGPT Project instructions are project-scoped today, so a brand-new Project may still need this one-time stable root/control binding and provider/resource connection. That is a product boundary, not a reason to make the Human relay changing Issue numbers, prompt templates, RESULT payloads, job IDs, or routine `continue` triggers.

## Dogfood authority boundary

Real dogfood runs under the downstream Project Parent and downstream-owned control/authority. The orchestrator Parent may define shared-kernel conformance criteria, read durable evidence, and ACCEPT or REVISE the shared kernel. It must not create downstream business roadmap items or mutate downstream resources merely because a project is a dogfood target.

Notion-native dogfood therefore stays Notion-native when native capability is sufficient. GitHub + Local + real-device projects keep their own device and mutation gates. Cross-project examples are evidence, not dependencies or authority.

## Operator conformance

Deterministic tests cover both the accepted #78 invariants and the #82 autonomy correction:

- Notion-native brand-new GENESIS with no GitHub-repository requirement;
- mature `none + nextSafeAction` recovery;
- GitHub + Local/device-style recovery with multiple open work items and exact active-mission selection, never recency guessing;
- unchanged stable anchor across mission progression;
- fresh replacement recovery from the same root with capability rediscovery;
- duplicate/stale/foreign-root control fail-closed behavior;
- capability/authority separation;
- no central registry or cross-project live-state dependency;
- current-main-first kernel, exact observed SHA, Native-first routing, pointer-not-payload, one authoritative writer, Repository Identity Fence where repository mutation is involved, no Alpha.3 fallback, and fail-closed ambiguity.

Normal-path UX targets are zero manual current-Issue relay, zero prompt-template relay, zero multiple-control-file recall, zero internal RESULT/task/job/thread/workspace-ID relay, zero routine `continue` trigger, and zero stale live pointer in Project Settings.
