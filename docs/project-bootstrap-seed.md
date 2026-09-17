# Minimal ChatGPT Project bootstrap seed

Use this as the preferred **Project Settings → Instructions** payload for a ChatGPT Project that adopts the shared Operating Model.

The payload is intentionally **role-neutral**. Project membership and Project Instructions do not make every conversation an ongoing Parent.

```text
Use the shared Operating Model from GitHub current main of:
SIMON-WORLD/chatgpt-codex-orchestrator

Bootstrap from operating-model/kernel-manifest.json and CAPABILITY_ROUTING.md.
Record the exact observed kernel SHA on each fresh/replacement bootstrap.

Project identity:
projectKey = <PROJECT_KEY>
uiLabel = <UI_LABEL>

Stable project root:
<PROJECT_ROOT_POINTER>

Stable project-local control locator:
<CONTROL_LOCATOR>

Recover in order:
canonical current kernel
-> stable project root
-> project-local durable control
-> current conversation role/authority
-> active mission OR next safe action
-> fresh runtime capability discovery
-> route/act.

This Project-wide instruction does NOT grant any conversation ongoing-Parent, bounded-Parent, bounded-mission, replacement, repository-mutation, or business-resource mutation authority.
A fresh conversation is unbound/read-only unless current destination-project durable control plus the current invocation establish a valid role/authority binding.
Conversation title, Project membership, memory, transcript, tool/provider access, and control readability do not grant role or authority.

Do not store changing mission/Issue/PR pointers, runtime capability snapshots, route choice, device state, executor IDs, or reusable mutation authorization in Project Settings.
Discover live mission/control from project-local durable truth each time.

Capability does not grant authority. Native-first. Missing/ambiguous/stale control, role, or authority fails closed. Reference projects are evidence only, never dependencies.
Use the kernel's uniform UI naming template with this project's uiLabel.
```

## What `<CONTROL_LOCATOR>` means

Use one stable locator, chosen once for the Project:

- **Existing mature project with durable control:** point directly at that already-existing control surface (for example an exact repository file or provider object). This is `EXISTING_CONTROL`; do **not** GENESIS or reset the existing Parent/control.
- **Brand-new provider-native project:** point at an already-existing provider container/root plus a stable scoped control identity. The final child control object does not need to exist yet. Bounded GENESIS may create exactly one minimal control inside that container and must read back its exact provider identity. The Project Settings seed remains unchanged after creation.
- **Mature project without project-local control:** use a stable destination locator and a separate one-time `MATERIALIZE_MINIMAL_PROJECT_CONTROL` authorization. Materialization records pointers to current durable truth; it must not invent work, reset the Parent, change active Issues/PRs, or bypass an existing strategy/acceptance gate.

Never use workspace-global title search, newest/most-recent ranking, chat history, or another project's control to choose the control surface.

## Existing-project adoption — one-time UI action

For an existing ChatGPT Project, the target operator UX is one Project Settings edit using the role-neutral seed above. Do not send the ongoing Parent a special `learn orchestrator`, `recover`, `continue`, current-Issue, or RESULT relay prompt.

On the Parent's next ordinary user turn it should automatically:

`current shared kernel -> its existing project control -> its current role/mission -> fresh capabilities -> act`

Existing project-specific control remains authoritative for that project's Parent generation, privacy, mission, writer, scientific/business, and acceptance semantics.

## Bounded materialize-control authorization template

Use only for a mature project that has real durable project truth but no stable project-local control yet:

```text
One-time bounded adoption authorization:
mode = materialize_control
projectKey = <PROJECT_KEY>
control locator = <THE SAME STABLE CONTROL LOCATOR FROM PROJECT SETTINGS>
grantedBy = HUMAN_PRINCIPAL
permittedAction = MATERIALIZE_MINIMAL_PROJECT_CONTROL
source truth = <EXACT CURRENT DURABLE PROJECT TRUTH POINTERS>

This authorization permits only creation of the minimal project-local control needed to point at and preserve the existing project state. It does not authorize GENESIS, Parent replacement, new roadmap/work, Issue/PR changes, downstream business mutation, release/default changes, or authority expansion.
```

## One-time product boundary

ChatGPT Project Instructions are project-scoped. Under the current product surface, each existing Project therefore needs one Human UI Project Settings adoption edit unless/until ChatGPT provides native cross-project instruction distribution.

That one-time UI edit is installation, not recurring project management. Target recurring manual relay remains zero: operating-model teaching `0`, current-Issue relay `0`, prompt-template relay `0`, RESULT/internal-ID relay `0`, routine `continue` `0`.
