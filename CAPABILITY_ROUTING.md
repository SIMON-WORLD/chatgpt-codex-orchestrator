# CAPABILITY_ROUTING

> 当前规范性 routing / executor / Brain governance policy。历史研究与设计见 `docs/rfc-v0.2-chatgpt-native-capability-inventory.md`、`docs/rfc-v0.2-capability-routing.md` 与 `docs/rfc-v0.2-implementation-architecture.md`。如历史 RFC 与本文件对当前 operating policy 的表述冲突，以本文件为准；实现事实仍以 GitHub 当前代码为准。

## 1. Authoritative Brain

v0.2 的唯一 **authoritative Brain** 是 ChatGPT；项目级 authority 同一时刻只有一个 **active Parent holder**。

ChatGPT Parent 负责：

- Evidence acquisition / investigation；
- architecture / planning / decision；
- task decomposition；
- runtime capability discovery；
- capability routing；
- Governance：`PLAN / TASK / RESULT / REVISE / REPLAN / ASK_USER / PUBLISH / DONE`；
- independent evidence reacquisition；
- 最终 `ACCEPT / REVISE / DONE`。

Codex、未来 Claude / DeepSeek 或其他 Agent，以及 implementation / research / review ChatGPT sessions，可以作为 specialist、advisor、reviewer 或 executor，返回分析、执行结果和 evidence candidate；它们不与 active Parent 共享 v0.2 的项目级 final acceptance authority。

### Parent authority is not a permanent conversation identity

Parent role 是逻辑 authority role，不永久绑定某一条 ChatGPT conversation。ChatGPT conversation 是 disposable session/context surface。

```text
Project Parent Authority
        |
        +-- currently hosted by Parent Session A
        |
        +-- later hosted by Parent Session B after bounded takeover
```

Parent session replacement 必须复用 Brain Continuity 的 bounded re-entry / generation / fencing contract。新 Parent takeover 后，旧 Parent 的迟到 mutation 必须 fail closed；human 不中转 authority token 或内部 orchestration IDs。

### Mission sessions

v0.2 不把普通工作会话建模成永久 `Child Brain` hierarchy。可使用简单 operational role：

- **Implementation Session** — 负责一个 bounded implementation mission，可将 sustained local coding 委托 Codex；
- **Research Session** — 负责 bounded research mission；
- **Review Session** — 独立评审 decision / implementation / evidence。

这些 session 可以 reasoning、调查和调用工具，但其 mission scope 不自动授予 project-level architecture / roadmap / default-flip / release / final `DONE` authority。

如果一个 conversation 没有通过当前 mission 或明确 Parent takeover 被指定为 Parent，它不得自动假设自己是 project-level Parent。

未来是否引入 multi-Brain / shared-authority model 是独立架构问题，不在 v0.2 预先实现。

## 2. Operating Loop

当前核心范式：

```text
Evidence first
→ Decision
→ Runtime Capability Discovery
→ Capability Routing
→ Execute
→ Independent Evidence Reacquisition
→ ACCEPT / REVISE / DONE
```

Executor RESULT 不是 Brain truth。能由 Brain 直接取得的 authoritative evidence 应优先直接取得。

## 3. Capability Universe

```text
                         ChatGPT Brain
                              │
                ┌─────────────┴─────────────┐
                │                           │
      ChatGPT Product Capability       Local Capability Plane
                │                           │
      ┌─────────┴─────────┐           Secure Tunnel
      │                   │                 ↓
 Built-in Native      Connected Apps      Local MCP
      │                   │               ├─ Direct Local
 Web / Search          GitHub              └─ Codex App Server
 Files                 Gmail
 Python                Calendar
 Artifacts             Notion
 Images                Figma
 Tasks                 future apps
 future native         ...
 capabilities
```

未来可以增加 `Future Agent Plane`（例如 Claude / DeepSeek specialist/executor），但 v0.2 不依赖它。

### ChatGPT Product Capability

由当前 ChatGPT runtime 直接提供或通过已连接 App 提供的 capability。这里的 Native capability universe **不是固定产品功能清单**；它随 ChatGPT 产品、计划、surface、rollout、connected provider 与当前会话实际 tool surface 变化。

当前已知类别包括但不限于：

- Built-in Native：Web/Search、Files/PDF/vision、Python/Data Analysis、Images、Artifacts，以及当前 runtime 暴露的 writing/code blocks、preview/execute、Library、Tasks 等产品能力；
- Connected Apps：GitHub、Gmail、Calendar、Notion、Figma 以及当前账户未来接入的 Apps；
- 未来新增但可由当前 ChatGPT runtime 直接、安全、充分执行的产品 capability。

这些能力不应为了形式统一在本仓库、本地 MCP 或 Codex 中重复实现。Router 不应因为历史 inventory 未列出某项能力，就默认把任务下沉到 Local/Codex；必须先以当前 runtime observation 为准。

### Local Capability Plane

`Custom MCP App + Secure Tunnel + Local MCP` 用于补齐 ChatGPT 原生产品尚不能直接触达的 Local Machine / Local Workspace capability。

它不是所有任务的必经 transport。

当前 local execution family：

- `CHATGPT_DIRECT_LOCAL`：workspace-scoped read/search/status/diff、small bounded edit、allowlisted verify；
- `CODEX_DELEGATE`：multi-file coding、unknown-root-cause debugging、refactor、shell-heavy work、iterative tests/builds、sustained local execution。

## 4. Route / Capability / Provider

三个概念必须分离：

- **Route**：由哪一类 executor family 完成；
- **Capability**：任务真正需要什么能力；
- **Provider**：当前 runtime 里由哪个实际工具 / App / backend 实现该 capability。

例如：

```json
{
  "route": "CHATGPT_NATIVE",
  "capabilities": [
    "github.pr.read",
    "github.actions.read",
    "github.pr.merge"
  ],
  "provider": "GitHub Connector"
}
```

或：

```json
{
  "route": "CODEX_DELEGATE",
  "capabilities": [
    "local.code.mutate",
    "local.shell",
    "local.test",
    "git.commit",
    "git.push"
  ],
  "provider": "Codex App Server"
}
```

不要为 Web、GitHub、Gmail、Notion、Figma 等每个 provider 新增顶层 route enum。

## 5. Runtime Capability Discovery

Capability availability 是 **runtime fact**，不是静态产品假设。路由前先比较 **required operations** 与当前 runtime 的 **observed executable operations**，而不是按“coding / research / file editing”等任务标签做静态分流。

至少区分：

```text
product capability observed?
tool / action exposed in this conversation?
provider connected?
resource authorized?
operation permitted?
execution constraints sufficient for this task?
```

可以把当前任务级快照概念化为一个 ephemeral **Native Capability Envelope**：

```text
NativeCapabilityEnvelope {
  observedAt,
  surface,
  availableOperations,
  connectedProviders,
  authorizedResources,
  executionConstraints
}
```

只有当前任务所需的实际 operation 能执行，并且 execution constraints 足以完成任务，才视为该 capability `AVAILABLE`。

真实例子：`create_branch` tool 可以出现在 ChatGPT tool surface 中，但在 GitHub App 未安装到目标 repository owner 时仍会返回 `403 Resource not accessible by integration`。安装并授权 provider 后，同一个 runtime capability 才真正可用。

因此：

- 不在 orchestrator repo 中维护一个会快速过时的 ChatGPT global tool registry；
- Brain 根据当前会话真实 tool surface / provider connection / resource authorization 形成任务级 ephemeral capability snapshot；
- 必要时可以使用最小、可逆的 capability probe；
- Local MCP 只声明并执行自己真实拥有的 local capability。

## 6. Four Routing Targets

### `CHATGPT_NATIVE`

使用 ChatGPT 当前 runtime 已直接拥有且足够完成任务的 Product Capability。

`CHATGPT_NATIVE` 的边界由 **当前可执行 operation** 决定，不由固定产品功能清单或任务标签决定。即使任务涉及代码，只要当前 Web/native runtime 已具备所需的生成、编辑、预览、执行或远端 mutation capability，并且不需要真实 local workspace / shell / project dependency / repository test loop，就应优先保留在 Native。

典型：

- Web / GitHub / connected-app investigation；
- PR / CI 检查与当前 runtime 已授权的远端 bounded action；
- Files / PDF / Python / Images / Artifacts；
- 当前 runtime 暴露且足够完成任务的 writing/code blocks、preview/execute 等 native creation / compute surface；
- 不需要 local workspace 的普通 reasoning / creation。

原则：**Native-first，但不是 Native-only。**

### `CHATGPT_DIRECT_LOCAL`

用于 Local Capability Plane 中可由 Brain 直接、安全、有界执行的操作：

- local read / search；
- `git_status` / `git_diff`；
- read-only verify；
- small、bounded、exact intended change already known 的 local edit。

如果任务进入 multi-file / unknown-root-cause / iterative / long-running，则升级到 Codex。

### `CODEX_DELEGATE`

Codex 是 **sustained local / repository execution executor**，而不是“凡是涉及代码就默认使用”的 executor。

适合：

- multi-file implementation；
- unknown-root-cause debugging；
- repository-grounded refactor；
- shell-heavy work；
- project dependency / lint / test / build；
- iterative inspect → edit → test → debug → retest loop；
- git commit / push 等与真实 local workspace 绑定的执行；
- 长期或多轮 local execution。

如果一个 coding task 只需要当前 ChatGPT native 已拥有的 code generation / edit / preview / Python execution，而不需要真实 local repository execution loop，则不应仅因“这是 coding”就升级到 Codex。

Codex 不拥有 Brain 的项目级 planning / architecture / final acceptance authority。

### `HYBRID`

`HYBRID` 是 **composition route**，不是独立 executor，也不是 mutation owner。

它表示一个逻辑任务同时需要多个 capability plane，例如：

```text
ChatGPT Native: GitHub / Web 调查
→ Brain Decision
→ Codex: 本地实现 + tests + push
→ ChatGPT Native: fetch真实 commit/diff/CI
→ Brain ACCEPT / REVISE
→ 必要时 ChatGPT Native 完成 merge
```

Local mutation owner 始终由实际 local leg 决定。

## 7. Native-First Policy

正式原则：

> **Brain-native evidence first; native execution when sufficient; Direct Local for bounded local operations; Codex for sustained local execution.**

更具体地说：**Native-first means native-operation-first, not native-task-category-first.**

Router 不应使用以下静态捷径：

```text
coding -> Codex
research -> Native
file editing -> Local
```

而应执行：

```text
required operations
vs
current runtime observed executable operations
-> identify capability gap
-> choose the smallest sufficient route
```

“需要写文件”不等于“需要 Codex”。例如 GitHub 上的小型治理文档 mutation，如果当前 ChatGPT GitHub provider 已授权，则应由 `CHATGPT_NATIVE` 直接完成。

同样，“需要写代码”也不等于“需要 Codex”。例如当前 ChatGPT runtime 已能完成的小型代码生成、编辑、预览或 Python 执行，应优先 Native。

反过来，multi-file repository implementation 即使 ChatGPT 能编辑远端文本，也通常仍应由 Codex 承担完整 local workspace / shell / dependency / coding / test loop。

## 8. Evidence and Verification

### Evidence priority

通常优先级：

```text
Brain direct authoritative evidence
>
independently reacquired resource evidence
>
Executor RESULT / self-report
```

### Independent Verify

`Independent` 指 **独立于 Executor claim 重新获取 authoritative evidence**，不要求换 provider。

例如：

- `GitHub.create_branch` 返回 success 后，再 `search/fetch branch` 验证真实 ref；
- Direct Local `edit` 后，再 `read / git_diff / verify`；
- Codex 报告 tests / commit 后，由 ChatGPT fetch GitHub commit/diff/Actions；
- deploy 后可进一步直接检查 production Web。

执行 action 的返回值可以作为 evidence，但不应自动等于最终 acceptance。

### Independent Review Gate

正式原则：**single authority, plural evidence**。

Independent review 是 Parent 可按风险和不确定性调用的 governance capability，不是每个任务的强制 quorum，也不是 multi-Parent voting。

典型触发条件包括：

- high architecture impact；
- meaningful uncertainty / genuine disagreement；
- difficult design/root-cause trade-off；
- irreversible / expensive decision；
- project kickoff；
- operational default flip / release gate；
- security / authority model change。

可根据风险选择：Parent 直接决定、一个 independent reviewer，或 correctness + red-team/YAGNI 两类 reviewer。

Reviewer 默认 contract：

```text
READ authoritative evidence
→ ANALYZE independently
→ RETURN structured critique
```

Reviewer finding 是 evidence，不是投票。重大 review 应尽量独立重取 GitHub/Web/runtime evidence；重要 reviewer finding 与 Parent adjudication 应持久化到对应 GitHub Issue/PR。

## 9. Governance Semantics

Governance 属于 Brain control semantics，不等于 Local MCP transport。

Native-only 任务不应为了形式统一强制经过 Secure Tunnel / Local MCP。

当任务进入 Local Capability Plane 时，Local Governance Service 负责 local execution lifecycle 的持久控制与证据记录；Brain 仍拥有最终 `ACCEPT / REVISE / DONE`。

### Architecture change control

Accepted architecture 不应因为某个 Parent session 想到更漂亮的抽象就被随意替换。

重大 `REPLAN` 前，Parent 应明确：

1. 新出现了什么 authoritative / dogfood evidence；
2. 哪一条 accepted contract 已不足或被证据反驳；
3. 为什么更小的 bounded correction 不够；
4. 是否应触发 Independent Review Gate；
5. 如果涉及 North Star、重大 architecture 或 irreversible policy change，取得用户 approval。

Complexity must earn existence through real dogfood evidence。

## 10. Mutation Policy

当前安全原则：

> **同一个 mutable resource 同时只允许一个 authoritative writer。**

长期模型可以表达为：

```text
MutationLease {
  resource,
  mutationDomain,
  owner,
  unit,
  state
}
```

例如 local workspace 与 GitHub PR 是不同 mutable resource，不需要因为其中一个正在 mutation 就全局阻塞另一个无关资源。

v0.2 当前实现的 `MutationOwner` 主要保护 local workspace single-writer。N3 只冻结 generalized resource-scoped policy，不在缺少 dogfood evidence 时重写成 distributed lock system。

Read-only capability 不应取得 writer mutation ownership。

## 11. Failure / Reroute Policy

Capability execution 失败时，Brain 基于真实失败原因决定：

- capability 本身不可用 → runtime snapshot 更新，选择可用 provider/route；
- executor implementation failure → `REVISE`；
- local mutation state ambiguous → fail closed，先 authoritative reconciliation；
- user-owned destructive / irreversible / ownership-transfer decision → `ASK_USER`；
- 不因为某个 provider 失败就自动把所有任务 fallback 到 Codex。

禁止用“force unlock”或未经 reconciliation 的并发 writer 绕过 ownership failure。

## 12. M7 Dogfood Contract

### M7-A Native-only

- 真实 ChatGPT Product Capability 任务；
- `route = CHATGPT_NATIVE`；
- Codex calls = 0；
- 不需要 local 时 Local MCP calls = 0；
- manual ID / RESULT relay = 0；
- Brain 重新获取真实 resource evidence 后验收。

### M7-B Codex-required

- real multi-file / coding / test task；
- real Codex execution；
- manual relay = 0；
- Brain 自主 `REVISE`；
- mutation lifecycle / recovery / handoff 安全；
- Brain 独立检查真实 diff / tests / CI evidence。

### M7-C Hybrid

- ChatGPT Product Capability 调查/定案；
- 仅将必要 local execution leg 交给 Direct Local / Codex；
- ChatGPT 重新获取 GitHub/Web/local evidence；
- 最终 `ACCEPT / REVISE / DONE` 由 Brain 决定。

M7 通过后才单独决定 v0.2 operational default flip。

## 13. Future Agents

项目当前以 ChatGPT 为主导。如果未来接入 Claude、DeepSeek 或其他 Agent，优先把它们视为 specialist / advisor / reviewer / executor plane，并复用现有 capability/governance/evidence model。

当前默认拓扑是：**one active Parent authority + optional independent reviewers/specialists/executors**。Reviewer 可以挑战 Parent，但不通过多数票取得 final authority。

只有真实需求证明 multi-authoritative Brain 带来明确收益时，才单独研究 arbitration / consensus / shared-state authority；不要在 v0.2 为假设性 multi-Brain 复杂度付出实现成本。
