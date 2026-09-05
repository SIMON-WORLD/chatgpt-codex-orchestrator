# Parent Review Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align canonical repository governance and ChatGPT Project Instructions around one active replaceable Parent authority plus optional independent reviewers, without adding a multi-agent runtime or expanding Brain Continuity Core scope.

**Architecture:** Keep the existing capability-first architecture and Brain Continuity runtime contract. Clarify role semantics in documentation, add a canonical Project Instructions template, and define a lightweight Independent Review Gate/change-control policy whose durable evidence lives in existing GitHub Issue/PR surfaces. Runtime reviewer scheduling/consensus is explicitly out of scope.

**Tech Stack:** Markdown documentation, GitHub branch/PR/review surfaces, existing ChatGPT Project Instructions UI.

**Spec:** `docs/superpowers/specs/2026-09-05-parent-review-governance-design.md`

## Global Constraints

- v0.2 has one active project-level Parent authority at a time.
- Parent role is not permanently bound to a ChatGPT conversation.
- Parent session rollover reuses existing Brain Continuity generation/fencing semantics.
- Implementation/research/review sessions do not receive project-level final authority by default.
- Independent review is optional and risk-based; it is evidence, not voting/consensus.
- Important review evidence and Parent adjudication should persist on existing GitHub Issue/PR surfaces.
- Do not add a route, database, distributed lock, reviewer registry, scheduler, DAG, agent council, multi-Parent voting, or multi-authoritative consensus.
- Do not expand Issue #23 Brain Continuity Core implementation scope.
- ChatGPT Project Instructions must define shared policy rather than automatically declaring every project conversation to be Parent.

---

### Task 1: Canonical ChatGPT Project Instructions template

**Files:**
- Create: `docs/chatgpt-project-instructions.md`

**Interfaces:**
- Consumes: approved governance design.
- Produces: exact copy/paste Project Instructions text used by the ChatGPT Project UI.

- [ ] **Step 1: Write the canonical instructions template**

Include the existing project operating model: Evidence first, current four routes, Native-first, GitHub authority, executor RESULT as evidence candidate, mutation policy, human boundary, one active Parent authority, mission-session role resolution, optional Independent Review Gate, and architecture change-control.

- [ ] **Step 2: Check role-resolution invariants**

Verify the template says that a conversation without explicit Parent assignment/takeover must not assume Parent authority, while a designated Parent session owns project-level architecture/final acceptance.

- [ ] **Step 3: Check YAGNI constraints**

Verify the template does not introduce Child-Brain hierarchy, multi-Parent consensus, mandatory reviewer quorum, or a new runtime mechanism.

- [ ] **Step 4: Commit**

Commit message: `docs: add canonical ChatGPT project instructions`

### Task 2: Align normative routing/governance policy

**Files:**
- Modify: `CAPABILITY_ROUTING.md`

**Interfaces:**
- Consumes: design spec and current Native-first routing policy.
- Produces: normative wording for active Parent authority, mission sessions, Independent Review Gate, and architecture change-control.

- [ ] **Step 1: Clarify the Authoritative Brain section**

Keep ChatGPT as the v0.2 authoritative Brain, but state that project-level authority has one active Parent holder and is not bound permanently to a conversation.

- [ ] **Step 2: Add mission-session boundary**

Document Implementation / Research / Review sessions as disposable working surfaces whose mission scope does not imply project-level authority.

- [ ] **Step 3: Add Independent Review Gate**

Document optional risk-based review and the invariant `single authority + plural evidence`; reviewers return critique/evidence, not votes or project-level DONE.

- [ ] **Step 4: Add architecture change-control discipline**

Material REPLAN requires new evidence, affected-contract identification, minimal-correction reasoning, appropriate independent review, and user approval for genuine major architecture/North-Star change.

- [ ] **Step 5: Re-read Native-first / routing sections**

Ensure the governance clarification does not add or alter any of the four route enums.

- [ ] **Step 6: Commit**

Commit message: `docs: clarify Parent authority and review gate`

### Task 3: Align architecture, status, and Brain Continuity contract

**Files:**
- Modify: `docs/architecture.md`
- Modify: `PROJECT_STATUS.md`
- Modify: `docs/rfc-v0.2-brain-continuity.md`

**Interfaces:**
- Consumes: normative `CAPABILITY_ROUTING.md` semantics.
- Produces: consistent architecture/status/continuity language with no contradictory Child/Parent identity model.

- [ ] **Step 1: Update architecture reference**

State that there is one active Parent authority, Parent sessions are replaceable holders, and optional reviewers/specialists do not gain project-level final authority.

- [ ] **Step 2: Update Project Status recovery context**

Record the role-topology dogfood finding and the accepted clarification without changing Issue #23 implementation gate or M8/release status.

- [ ] **Step 3: Narrow RFC Child/workstream wording**

Retain future workstream non-goal language, but avoid presenting `Child Brain` as a current durable authority entity. Clarify that mission/review sessions are disposable context surfaces and Parent fencing only protects active Parent mutation authority.

- [ ] **Step 4: Re-check Issue #23 scope**

Ensure all original Brain Continuity acceptance requirements remain intact and no reviewer runtime requirement is added.

- [ ] **Step 5: Commit**

Commit message: `docs: align Brain Continuity role semantics`

### Task 4: Open durable review surface and run independent review

**Files:**
- Review surface: new GitHub PR from `docs/parent-review-governance` to `main`.

**Interfaces:**
- Consumes: exact documentation branch head.
- Produces: durable correctness review, red-team/YAGNI review, Parent adjudication, and final merge decision.

- [ ] **Step 1: Open Draft PR**

PR title: `docs: clarify Parent authority and independent review governance`

PR body must summarize the role-topology incident, `single authority + plural evidence`, exact non-goals, Project Instructions synchronization, and relationship to Issue #23.

- [ ] **Step 2: Reacquire PR diff and exact head**

Confirm only intended documentation files changed and no runtime/source files are modified.

- [ ] **Step 3: Obtain independent correctness review**

Reviewer independently reads current main, accepted RFC, Issue #23, and the exact PR diff. Persist verdict as `REVIEW_CORRECTNESS` on the PR.

- [ ] **Step 4: Obtain independent red-team/YAGNI review**

Reviewer actively looks for unnecessary authority hierarchy, hidden multi-agent runtime expansion, role ambiguity, review-by-vote semantics, and conflict with Issue #23. Persist verdict as `REVIEW_RED_TEAM` on the PR.

- [ ] **Step 5: Parent adjudication**

Parent independently re-reads material evidence, responds with `PARENT_DECISION`, and revises the branch if necessary.

- [ ] **Step 6: CI / docs checks**

Verify the exact PR head's available GitHub Actions checks. Documentation-only change still requires the repository's normal exact-head CI evidence when triggered.

- [ ] **Step 7: Merge only after acceptance**

Merge only after independent review issues are resolved and Parent accepts the exact head.

### Task 5: Synchronize ChatGPT Project configuration

**Files:**
- External configuration: ChatGPT Project Settings → Instructions.
- Canonical source: `docs/chatgpt-project-instructions.md` on accepted `main`.

**Interfaces:**
- Consumes: merged, reviewed canonical template.
- Produces: project-level instructions that supply shared policy without assigning Parent identity to every conversation.

- [ ] **Step 1: Copy the accepted template into Project Instructions**

Use the exact canonical text from `main`, not an older conversation draft.

- [ ] **Step 2: Start a non-Parent test conversation**

Give it a bounded review/research/implementation mission and confirm it does not automatically claim project-level Parent authority.

- [ ] **Step 3: Confirm Parent conversation semantics**

The designated Parent session should still explicitly operate as Parent when its mission/takeover assigns that role.

- [ ] **Step 4: Resume Issue #23**

Continue the existing Brain Continuity Core milestone without creating a new milestone or expanding its implementation scope.

## Self-review

- Spec coverage: all approved governance decisions are mapped to Tasks 1-5.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation behavior remains.
- Scope: documentation/config governance only; no runtime implementation beyond the already-existing Issue #23 contract.
- Authority consistency: one active Parent authority; reviewers/mission sessions are non-project-authoritative by default.
- YAGNI: no new scheduler, consensus engine, reviewer database, route, or multi-Child architecture.
