# Minimal ChatGPT Project bootstrap seed

Use this as the preferred small Project Settings → Instructions payload for a project that adopts the shared Operating Model.

```text
Use the shared Operating Model from GitHub current main of:
SIMON-WORLD/chatgpt-codex-orchestrator

Bootstrap from operating-model/kernel-manifest.json and CAPABILITY_ROUTING.md.
Record the exact observed kernel SHA.

This Project's stable project root is:
<PROJECT_ROOT_POINTER>

This Project's stable project-local control root is:
<PROJECT_CONTROL_ROOT_POINTER>

Recover in order:
canonical current kernel -> stable project root -> project-local durable control -> active mission OR next safe action -> runtime capability discovery -> route.

Do not store changing mission/Issue/PR pointers, runtime capability snapshots, route choice, device state, or executor IDs in Project Settings. Discover live mission/control from project-local durable control each time.

Capability does not grant authority. Native-first. Missing/ambiguous/stale control or authority fails closed. Reference projects are evidence only, never dependencies.
Use the kernel's uniform UI naming template with this project's uiLabel.
```

## One-time product boundary

ChatGPT Project instructions are currently project-scoped, so a new Project still needs this one-time stable root/control binding unless the product later provides native cross-project instruction distribution. Do not claim zero-touch inheritance.

For a brand-new project with no durable control yet, the Human Principal may additionally provide one bounded GENESIS authorization: minimal charter/identity + hard boundaries, exact designated durable surface/root, and permission only to create the minimal project-local control. After that control exists, it supersedes GENESIS input for normal recovery and cannot be silently rebound by Project Settings.

The seed is a pointer, not a policy payload. Shared policy changes come from orchestrator current `main`; project-specific evolving truth comes from the project's own durable control; live mutation authority comes only from the current destination-scoped mission/Parent decision.
