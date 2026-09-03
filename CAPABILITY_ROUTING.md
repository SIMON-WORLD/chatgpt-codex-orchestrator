# CAPABILITY_ROUTING

> 当前规范性 routing / executor policy。历史研究与设计见 `docs/rfc-v0.2-chatgpt-native-capability-inventory.md`、`docs/rfc-v0.2-capability-routing.md` 与 `docs/rfc-v0.2-implementation-architecture.md`。如历史 RFC 与本文件对当前 operating policy 的表述冲突，以本文件为准；实现事实仍以 GitHub 当前代码为准。

## 1. Authoritative Brain

v0.2 的唯一 **authoritative Brain** 是 ChatGPT。

ChatGPT 负责：

- Evidence acquisition / investigation；
- architecture / planning / decision；
- task decomposition；
- runtime capability discovery；
- capability routing；
- Governance：`PLAN / TASK / RESULT / REVISE / REPLAN / ASK_USER / PUBLISH / DONE`；
- independent evidence reacquisition；
- 最终 `ACCEPT / REVISE / DONE`。

Codex、未来 Claude / DeepSeek 或其他 Agent 可以作为 specialist、advisor 或 executor，返回分析、执行结果和 evidence candidate；它们不与 ChatGPT 共享 v0.2 的最终 acceptance authority。

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

由当前 ChatGPT runtime 直接提供或通过已连接 App 提供的 capability，包括但不限于：

- Built-in Native：Web/Search、Files、PDF/vision、Python/Data Analysis、Images、Artifacts、Tasks 等；
- Connected Apps：GitHub、Gmail、Calendar、Notion、Figma 以及当前账户未来接入的 Apps。

这些能力不应为了形式统一在本仓库、本地 MCP 或 Codex 中重复实现。

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

Capability availability 是 **runtime fact**，不是静态产品假设。

至少区分：

```text
tool exposed?
provider connected?
resource authorized?
operation permitted?
```

只有当前任务所需的实际 operation 能执行，才视为该 capability `AVAILABLE`。

真实例子：`create_branch` tool 可以出现在 ChatGPT tool surface 中，但在 GitHub App 未安装到目标 repository owner 时仍会返回 `403 Resource not accessible by integration`。安装并授权 provider 后，同一个 runtime capability 才真正可用。

因此：

- 不在 orchestrator repo 中维护一个会快速过时的 ChatGPT global tool registry；
- Brain 根据当前会话真实 tool surface / provider connection / resource authorization 形成任务级 ephemeral capability snapshot；
- 必要时可以使用最小、可逆的 capability probe；
- Local MCP 只声明并执行自己真实拥有的 local capability。

## 6. Four Routing Targets

### `CHATGPT_NATIVE`

使用 ChatGPT 当前 runtime 已直接拥有且足够完成任务的 Product Capability。

典型：

- Web / GitHub / connected-app investigation；
- PR / CI 检查与当前 runtime 已授权的远端 bounded action；
- Files / PDF / Python / Images / Artifacts；
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

Codex 是 sustained local coding executor。

适合：

- multi-file implementation；
- unknown-root-cause debugging；
- refactor；
- shell-heavy work；
- iterative test/build loops；
- 长期或多轮 local execution。

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

“需要写文件”不等于“需要 Codex”。例如 GitHub 上的小型治理文档 mutation，如果当前 ChatGPT GitHub provider 已授权，则应由 `CHATGPT_NATIVE` 直接完成。

反过来，multi-file code implementation 即使 ChatGPT 能编辑远端文本，也通常仍应由 Codex 承担完整本地 coding/test loop。

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

## 9. Governance Semantics

Governance 属于 Brain control semantics，不等于 Local MCP transport。

Native-only 任务不应为了形式统一强制经过 Secure Tunnel / Local MCP。

当任务进入 Local Capability Plane 时，Local Governance Service 负责 local execution lifecycle 的持久控制与证据记录；Brain 仍拥有最终 `ACCEPT / REVISE / DONE`。

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

Capability execution 失败时，Brain基于真实失败原因决定：

- capability 本身不可用 → runtime snapshot 更新，选择可用 provider/route；
- executor implementation failure → `REVISE`；
- local mutation state ambiguous → fail closed，先 authoritative reconciliation；
- user-owned destructive / irreversible / ownership-transfer decision → `ASK_USER`；
- 不因为某个 provider 失败就自动把所有任务 fallback 到 Codex。

禁止用“force unlock”或未经 reconciliation 的并发 writer 绕过 ownership failure。

## 12. M7 Dogfood Contract

### M7-A Native-only

-真实 ChatGPT Product Capability 任务；
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

项目当前以 ChatGPT 为主导。如果未来接入 Claude、DeepSeek 或其他 Agent，优先把它们视为 specialist / advisor / executor plane，并复用现有 capability/governance/evidence model。

只有真实需求证明多 authoritative Brain 带来明确收益时，才单独研究 arbitration / consensus / shared-state authority；不要在 v0.2 为假设性 multi-Brain 复杂度付出实现成本。
