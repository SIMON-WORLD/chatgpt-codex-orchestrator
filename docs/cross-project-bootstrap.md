# Cross-project Operating Model bootstrap

This document defines the preferred onboarding/recovery path for a ChatGPT Project that wants to reuse the `chatgpt-codex-orchestrator` Operating Model without copying a large policy payload into every Project.

`CAPABILITY_ROUTING.md` remains the normative shared operating/routing policy. The bootstrap manifest is only a compact versioned pointer/contract; it is not a second policy authority.

## Four layers

Keep these layers separate:

1. **Operating Kernel** — current canonical `SIMON-WORLD/chatgpt-codex-orchestrator` policy and recovery sources.
2. **Project Profile / Overlay** — project identity, UI label, durable truth pointers, and project-specific policy pointers.
3. **Live Mission / Authority** — current destination-scoped Issue/Parent decision that defines scope, acceptance, and mutable repositories/resources.
4. **Ephemeral Runtime Capability Envelope** — what the current ChatGPT session can actually execute now.

A profile, repository mention, tool schema, provider connection, conversation title, memory, transcript, or reference project never grants mutation authority.

## Deterministic bootstrap order

A fresh or replacement Project/session should recover in this order:

`canonical orchestrator current main -> kernel manifest + CAPABILITY_ROUTING.md -> PROJECT_STATUS.md -> ROADMAP.md -> project profile/overlay -> current live mission/authority -> runtime capability discovery -> route or fail closed`

The bootstrap records the exact observed kernel commit SHA. Default recovery observes GitHub current `main`. An explicit exact-SHA pin is allowed only when the caller/mission deliberately requests reproducibility; it must remain visibly a pin and must not masquerade as current-main truth.

If the canonical kernel, project profile, or live authority is missing/ambiguous, stay read-only/unbound and request only the minimum missing durable pointer/action. Do not guess from the latest Project, most recent conversation, transcript, memory, tool permission, repository mention, or a reference project.

## Runtime capability doctor contract

Capability availability is a task/session-scoped observation. For each required operation, distinguish at least:

- `exposed` — the tool/action schema is visible;
- `executable` — the operation can actually be invoked in this conversation;
- `resourceAuthorized` — the target provider/resource is authorized;
- `constraintsSufficient` — the operation's limits are enough for the current task.

Only when all four are true is that operation `AVAILABLE`.

For example, `schema visible + invocation FORBIDDEN` is **UNAVAILABLE**. Capability observations never create Parent authority or mutable-repository scope.

Native-first means: if the current ChatGPT runtime already exposes sufficient executable operations, use them directly. Local MCP / Direct Local / Codex are route families discovered only from actual current-session evidence. Local absence never silently falls back to Alpha.3.

A Human Principal may need to provide an explicit local root/resource pointer when the local tool intentionally does not perform machine-wide discovery. That pointer is a resource binding/authorization fact, not Human Relay executor-state payload.

## Project profile

See `operating-model/project-profile.example.json` for the portable shape. Required fields are:

- `schemaVersion`;
- `projectKey`;
- `uiLabel`;
- `compatibleKernelSchemaMajor`;
- `durableSources`;
- `overlays` (may be empty).

Optional `referenceProjects` entries are dogfood/evidence-only pointers. A profile must not carry Parent authority, mission acceptance, mutable repositories, credentials/secrets, authority/execution tokens, or transient task/job/step/thread/workspace identifiers.

Project-specific scientific, privacy, publishing, content, device, or product authority stays in the project overlay/control. The shared kernel must not import those semantics from Academic Door, China Demand, or any other reference project.

## Uniform UI naming

All of the user's Projects should use the same display grammar so the sidebar is predictable even when the projects have very different capabilities and business rules:

- ongoing Parent: `① 总控 · Gnn · ACTIVE | <uiLabel>`
- superseded ongoing Parent: `① 总控 · Gnn · RETIRED | <uiLabel>`
- ordinary bounded mission: `#<issue> · <MISSION_TYPE> | <uiLabel>`
- bounded Parent delegation: `#<issue> · PARENT | <uiLabel>`

Current mission types are `IMPLEMENT`, `DOGFOOD`, `REVIEW`, `RUNTIME`, and `INVESTIGATE`.

The display template is shared; project-specific role/topology belongs in the project overlay and does not create a second naming grammar. Names remain discoverability only and never grant authority.

## Tiny ChatGPT Project seed

ChatGPT Project instructions are project-scoped, so a one-time seed/pointer is still required unless the product later provides native cross-project instruction distribution. Prefer a small seed like this instead of copying the entire operating policy:

```text
Use the shared Operating Model from GitHub current main of:
SIMON-WORLD/chatgpt-codex-orchestrator

Bootstrap from operating-model/kernel-manifest.json and CAPABILITY_ROUTING.md.
Record the exact observed kernel SHA.

This Project's profile/control pointer is:
<PROJECT_PROFILE_OR_CONTROL_POINTER>

Optional current mission/Issue pointer:
<ACTIVE_MISSION_POINTER_OR_NONE>

Recover in order:
canonical current kernel -> project profile/overlay -> live mission/authority -> runtime capability discovery -> route.

Capability does not grant authority. Native-first. Missing/ambiguous profile or authority stays read-only/unbound. Reference projects are evidence only, never dependencies.
Use the kernel's uniform UI naming template with this profile's uiLabel.
```

The older full Project Instructions template remains compatibility/migration guidance only. It is not a synchronized policy database.

## Examples of project-specific overlays

These examples illustrate capability diversity, not separate operating systems:

- a GitHub-native contribution project can normally route directly through the GitHub connector and add only its own public-upstream JIT approval rule;
- a research project can add scientific authority, privacy/admission, and Local/Codex rules without changing the shared Kernel;
- a device/network project can add real-device acceptance and credential-isolation rules;
- a Notion-management project can be Notion-native and keep its content-management rules in Notion itself, without creating a local Codex dependency merely for symmetry.

## Conformance expectations

Deterministic tests cover the Issue #78 scenarios: Native sufficiency, capability-gap-driven Codex selection, Repository Identity Fence, cross-repo read/write separation, current-main precedence, transcript-free replacement recovery, fail-closed missing authority/profile, schema-visible-but-unexecutable tools, no Alpha.3 fallback, uniform naming, reference-project isolation, and capability/authority separation.
