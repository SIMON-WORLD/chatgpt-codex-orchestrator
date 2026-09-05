# Parent Authority and Independent Review Governance Design

> Status: **USER-APPROVED DESIGN — independent review pending**
>
> Date: 2026-09-05
>
> Scope: governance/documentation clarification only. This design does **not** add a multi-agent runtime, scheduler, consensus engine, or new execution route.

## 1. Problem

Real project dogfood exposed a role-topology ambiguity that is independent of the Brain Continuity implementation itself:

- ChatGPT Project Instructions currently describe the project assistant as the `Parent Brain / 总控 / 总设计师`.
- Every new conversation in the same ChatGPT Project can inherit that project-level wording.
- A mission conversation such as the Issue #23 implementation controller can therefore correctly act within a scoped implementation mission while still answering a direct identity question as if it were the project-level Parent.
- Long-running project work also shows that a Parent conversation can become too long, lose a capability binding, or need to be replaced.
- The project needs independent challenge for difficult or high-impact architecture decisions without creating multiple competing project authorities.

The correction must be minimal and must preserve the accepted v0.2 rule that complexity is earned by evidence.

## 2. Decision

Adopt the operating principle:

> **Single authority, plural evidence.**

v0.2 has exactly one **active project-level Parent authority** at a time. That authority may be hosted by a replaceable ChatGPT session. Independent review/research/implementation sessions may provide analysis, critique, evidence, and bounded execution, but they do not gain project-level final acceptance authority.

This is a clarification of the accepted architecture, not a new multi-Brain model.

## 3. Parent authority is not a conversation identity

A ChatGPT conversation is a disposable session/context surface.

The project-level Parent is a logical authority role:

```text
Project Parent Authority
        |
        +-- currently hosted by Parent Session A
        |
        +-- later hosted by Parent Session B after bounded takeover
```

Only one Parent session may hold active mutation authority at a time.

A Parent session replacement must reuse the existing Brain Continuity contract:

```text
Parent Session A
-> durable Governance / GitHub checkpoint
-> bounded semantic re-entry
-> Parent Session B takeover
-> generation/fencing advances
-> stale Parent A mutations are rejected
```

The human must not relay authority tokens or internal orchestration IDs.

## 4. Mission sessions are not durable authority entities

For v0.2, avoid introducing permanent `Child Brain`, `Scoped Brain`, or hierarchical Brain identities as runtime architecture.

Use plain operational language for disposable working sessions:

- **Implementation Session** — investigates and controls one implementation mission; may delegate sustained local work to Codex.
- **Research Session** — investigates a bounded research question and returns evidence/findings.
- **Review Session** — independently evaluates a decision candidate, implementation, or evidence set.

These sessions can reason and use tools. Their scope is defined by the mission they receive. They do not automatically receive project-level `ACCEPT / REVISE / DONE`, release, default-flip, or roadmap authority.

A replacement mission session may continue the same durable mission by reacquiring its GitHub/Governance state. The conversation itself is not the durable work identity.

## 5. Project Instructions are shared policy, not role assignment

ChatGPT Project Instructions should define the project's shared constitution:

- Evidence first;
- Native-first capability routing;
- the four routing targets;
- GitHub/current external evidence precedence;
- executor RESULT is evidence candidate, not truth;
- one authoritative writer per mutable resource;
- no human internal-ID / RESULT message bus;
- one active Parent authority;
- optional independent review;
- major architecture change-control discipline.

Project Instructions must **not** automatically declare every project conversation to be the Parent.

Conversation role is resolved from the current mission / explicit Parent takeover. If a conversation has not explicitly acquired the Parent role, it must not assume project-level Parent authority.

The exact copy/paste Project Instructions template is maintained in `docs/chatgpt-project-instructions.md`.

## 6. Independent Review Gate

Independent review is optional and risk-based, not mandatory for every task.

The Parent may invoke reviewers when one or more of these conditions hold:

- high architecture impact;
- meaningful uncertainty;
- genuine disagreement;
- difficult root-cause or design trade-off;
- irreversible or expensive decision;
- operational-default flip;
- release gate;
- security / authority model change;
- project kickoff where independent alternatives materially improve decision quality.

Suggested review depth:

```text
low-risk / reversible / familiar
-> Parent decides directly

higher uncertainty or architecture impact
-> one independent reviewer

major REPLAN / contested / high-impact / irreversible
-> correctness reviewer + red-team/YAGNI reviewer
```

This is guidance, not a mandatory quorum rule.

### Reviewer contract

Default reviewer authority is read/analyze/report only:

```text
READ authoritative evidence
-> ANALYZE independently
-> RETURN structured critique
```

A reviewer does not become a second Parent and does not decide project-level `DONE`.

Reviewers should not merely judge the Parent's prose. They should reacquire canonical GitHub/Web/runtime evidence when the required capabilities are available.

## 7. Parent adjudication after review

Review is evidence, not a vote.

The Parent must:

1. read the reviewer claims;
2. independently reacquire material authoritative evidence where practical;
3. distinguish factual disagreement from preference/trade-off disagreement;
4. choose `ACCEPT`, `REVISE`, or `REPLAN`;
5. persist significant review and the final Parent decision to the relevant GitHub Issue/PR.

Multiple reviewers do not create majority-rule consensus. The invariant is **single authority + plural evidence**.

## 8. Architecture change-control discipline

An accepted architecture must not be replaced because a Parent session invents a more elegant abstraction.

Before a material architecture `REPLAN`, the Parent should establish:

1. **new evidence** — what authoritative or dogfood evidence changed;
2. **affected contract** — which accepted rule is insufficient or contradicted;
3. **minimal correction** — why a smaller bounded change is not enough;
4. **review need** — whether independent review is justified by impact/uncertainty;
5. **human approval** — required for genuine North Star / major architecture changes.

This is a change-control discipline, not a new workflow engine.

## 9. Durable evidence surfaces

Use existing durable surfaces instead of creating a reviewer database.

### GitHub

GitHub remains project/implementation truth and the durable surface for important review evidence:

- architecture decision issue;
- implementation PR;
- `REVIEW_CORRECTNESS` comment/review;
- `REVIEW_RED_TEAM` comment/review;
- Parent `DECISION` / acceptance comment;
- commit / diff / CI evidence.

Suggested markers are conventions, not a new schema:

- `PARENT_CANDIDATE`
- `REVIEW_CORRECTNESS`
- `REVIEW_RED_TEAM`
- `EXECUTOR_RESULT`
- `PARENT_DECISION`
- `PARENT_ACCEPTANCE`

### Local durable Governance

Local Governance remains live control truth for task/step/control/acceptance/executor/recovery/fencing state.

GitHub is not a replacement for runtime Governance persistence, and Governance must not silently override contradictory current GitHub/external evidence.

## 10. Parent takeover and fencing remain required

The accepted Brain Continuity generation/fencing mechanism remains necessary because Parent Session A may still exist after Parent Session B takes over.

Its scope stays narrow:

- protect project-level Parent-authored Governance mutation authority;
- reject stale Parent generations/tokens;
- do not require the human to carry tokens;
- do not automatically cancel/restart an already-valid delegated Codex execution.

Do **not** extend fencing into a hierarchy of reviewer/implementation/research session authority tokens without new evidence.

## 11. Relationship to Issue #23 Brain Continuity Core

Issue #23 scope remains substantively unchanged.

Still required:

- durable canonical Governance;
- bounded semantic re-entry;
- Context Capsule;
- Parent generation/fencing;
- capability rediscovery;
- one canonical Governance writer;
- same-Codex reconciliation / no duplicate execution;
- zero human internal-ID / RESULT relay;
- isolated real re-entry dogfood.

This governance clarification does **not** add:

- multi-Parent voting;
- multi-authoritative consensus;
- permanent Child Brain registry;
- hierarchical Brain authority;
- reviewer scheduler;
- agent council/group-chat runtime;
- reviewer consensus engine;
- generic DAG/workflow database.

## 12. External architecture evidence

The design is consistent with current mature orchestration patterns:

- OpenAI Agents SDK distinguishes a manager/agents-as-tools pattern where one manager retains conversation/final-response control while specialists contribute bounded work, as well as explicit handoff when control transfer is actually intended.
- Microsoft Agent Framework exposes manager/aggregator, concurrent fan-out/fan-in, group-chat, handoff, human review, and checkpoint/resume patterns. Multiple participants do not imply multiple final authorities.
- LangGraph-style checkpointing reinforces that durable execution/work state should survive process/session boundaries rather than depending on one conversation buffer.
- OpenHands-style agent review demonstrates that review findings can naturally be persisted on the GitHub PR surface instead of existing only in agent conversation history.

The project adopts these principles selectively. It does not import another framework or duplicate capabilities ChatGPT/OpenAI already provide.

## 13. Acceptance criteria for this governance clarification

This design is acceptable when:

1. canonical repository docs state one **active Parent authority**, not one permanent Parent conversation;
2. Project Instructions no longer grant Parent identity to every project conversation;
3. mission sessions are explicitly non-project-authoritative by default;
4. optional Independent Review Gate is documented as risk-based, not mandatory voting/quorum;
5. important reviewer findings and Parent decisions have a GitHub durable-surface convention;
6. Parent major architecture changes are evidence-gated and user-approved where appropriate;
7. Brain Continuity Issue #23 scope is not expanded into multi-agent hierarchy/runtime work;
8. no new route, database, distributed lock, scheduler, consensus engine, or reviewer registry is introduced;
9. at least one independent correctness review and one red-team/YAGNI review evaluate the resulting documentation PR before merge.

## 14. Rollout

1. Publish this design and related canonical-doc changes on a dedicated docs PR.
2. Run independent correctness + red-team/YAGNI review against that exact PR/head.
3. Parent independently adjudicates the review and revises the PR if necessary.
4. After acceptance, merge the docs PR.
5. Copy the accepted `docs/chatgpt-project-instructions.md` text into ChatGPT Project Settings → Instructions.
6. Re-enter/continue Issue #23 under the clarified role model without changing its implementation scope.
