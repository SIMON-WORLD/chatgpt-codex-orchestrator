# Cross-project Operating Kernel adoption

This document covers the real-product step that comes **after** the shared Operating Kernel exists: making a ChatGPT Project actually adopt it.

## Four different states

Do not conflate these states:

1. **Kernel available** — `SIMON-WORLD/chatgpt-codex-orchestrator` current `main` contains the shared kernel.
2. **Project seeded** — one Project has a role-neutral Project Settings pointer to the shared kernel and its own stable project/control locator.
3. **Project adopted** — the Project has successfully resolved current kernel + its own durable control without replacing project-specific authority semantics.
4. **Parent operating under kernel** — the current conversation has separately established its destination-project role/authority and has freshly discovered runtime capabilities before acting.

A merge in the orchestrator never silently moves another Project from state 1 to state 2/3/4.

## Role-neutral Project Settings

Project Instructions are inherited by every conversation in a Project, so they must never say or imply that every conversation is the ongoing Parent.

Project membership, instructions, conversation title, memory, transcript, provider access, and the ability to read durable control are **not** role or mutation authority.

A fresh conversation is `unbound/read-only` by default. Destination-project durable control plus the current invocation may bind one of:

- ongoing Parent;
- bounded mission;
- bounded Parent;
- replacement Parent candidate/committed replacement;
- unbound/read-only.

A replacement candidate remains read-only until the destination project's own takeover/fencing commit point succeeds. No central Parent/session registry is introduced.

## Adoption modes

### `EXISTING_CONTROL`

Use for a mature project that already has valid durable project-local control.

Examples: a repository `CONTROL.md`, or an existing private control plane with an active generation fence.

Adoption must:

- keep the existing Parent generation/binding;
- keep existing mission/next-safe-action truth;
- keep project privacy/writer/acceptance semantics;
- not run GENESIS;
- not rewrite project-specific control into an orchestrator schema merely for uniformity.

The Human Principal performs one Project Settings adoption edit. On the ongoing Parent's next ordinary user turn, it reads current kernel first and then its existing control. No special `learn orchestrator`, `recover`, current-Issue relay, or `continue` prompt is part of the target UX.

### `NEW_GENESIS`

Use only for a genuinely brand-new project with no durable project control.

The stable locator is provider-real and has two parts:

`exact existing provider container/root + stable scoped control identity`

The final control object/page does not need to exist before the seed is installed. Bounded GENESIS may create **at most one** minimal control in the exact designated container, then reacquire/read back its exact provider identity. The Project Settings seed does not change afterward.

Workspace-global title search, recency/newest ranking, and another project's business page are not valid control discovery.

### `MATERIALIZE_CONTROL`

Use for a mature project whose durable truth exists (for example GitHub Issue/PR/strategy gates) but which lacks one stable project-local control surface.

One narrow Human authorization may create the minimal control from exact current durable truth pointers. Materialization must preserve existing work rather than inventing a new project state.

It may not:

- GENESIS/reset the project;
- change the ongoing Parent merely because adoption occurs;
- change active Issues/PRs;
- bypass an owner/strategy/real-device gate;
- create new roadmap scope;
- grant repository/business-resource mutation authority.

## Provider-neutral control locator

Two locator forms are sufficient:

- `existing`: exact existing control object pointer;
- `scoped_identity`: exact existing provider container pointer + stable control identity.

Provider adapters return bounded observations for that locator. Recovery accepts exactly one matching current control. Zero matches means no control yet; multiple matches fail closed. No recency ranking is allowed.

After first-control creation, the exact provider-created pointer is readback evidence stored downstream; it does not require a second Project Settings edit.

## Archetype mapping

- **China-Demand-like:** existing `CONTROL.md` → `EXISTING_CONTROL`; preserve its Research Control Architecture, Paper Parent, privacy and next-safe-action semantics.
- **Upstream-contribution-control-like:** existing `AGENTS.md` / `CASES.md` → `EXISTING_CONTROL`; preserve active Brain generation fencing and exact-action public-write JIT approval.
- **Clash-like:** current GitHub Issues/stacked PRs but no stable control → `MATERIALIZE_CONTROL`; the minimal control points at current Issue/PR truth and real-device gates without changing them.
- **DSH-like:** strategy-gated GitHub project without stable control → `MATERIALIZE_CONTROL`; the minimal control must preserve the owner decision gate and must not invent Recipe 002.
- **Notion-like brand-new project:** exact Notion container + scoped control identity → `NEW_GENESIS`, then exact provider readback.

These names are conformance archetypes, not dependencies. The orchestrator does not become their supervisor and does not own their business/project roadmaps.

## Recurring UX target

After the one-time Project Settings adoption, recurring Human relay targets are:

- operating-model teaching: `0`;
- current Issue/mission relay: `0`;
- prompt-template relay: `0`;
- RESULT / workspaceId / jobId / threadId relay: `0`;
- routine `continue`: `0`;
- stale live mission pointers in Project Settings: `0`.

The Human Principal still provides genuinely human-only goals, judgment, approvals, protected-data decisions, physical-device actions, and material scope/architecture decisions.

## Product boundary

Today ChatGPT Project Instructions are Project-scoped. Therefore an existing Project requires one Human UI Project Settings adoption edit unless the product later provides native cross-project distribution.

That one edit is installation. Repeated teaching/prompting is a failed adoption UX, not an accepted operating model.
