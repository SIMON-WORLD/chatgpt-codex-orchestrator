# chatgpt-codex-orchestrator

一个以 **ChatGPT 为 Brain** 的 Capability Orchestrator。它让 ChatGPT 根据任务目标和当前 runtime 实际可用能力，自主获取证据、做出决策、选择最合适的执行路径，并在执行后重新验证结果。

**核心原则：** ChatGPT decides. Capabilities execute. ChatGPT verifies.

**状态：** Alpha · 最新正式版本 `v0.1.0-alpha.3` · [English](README.en.md)

## 为什么做这个项目

ChatGPT 已经可以完成大量研究、文件、数据分析和 connected-app 工作；Codex 则擅长持续的本地 coding execution。真正的问题不是“如何让 ChatGPT 调用 Codex”，而是：

- 当前任务究竟需要什么 capability；
- ChatGPT 是否已经可以直接完成；
- 什么时候需要本地 workspace；
- 什么时候应该委托 Codex；
- 如何避免用户在不同 Agent 之间手工复制 TASK、RESULT、workspaceId、jobId 等中间状态；
- 如何在执行后重新取得可靠 evidence，而不是直接相信 Executor 的自我报告。

`chatgpt-codex-orchestrator` 试图把这些问题收敛成一条统一的控制链：

```text
Evidence first
→ Decision
→ Runtime Capability Discovery
→ Capability Routing
→ Execute
→ Independent Verification
→ ACCEPT / REVISE / DONE
```

## 核心能力

- **ChatGPT as Brain** — 调查、规划、决策、路由、验收和最终 `DONE` 由 ChatGPT 主导。
- **Runtime Capability Routing** — 不假设某个工具一定可用，而是根据当前 runtime、provider、resource authorization 和 operation permission 选择执行路径。
- **Native-first** — Web、Files、Python/Data Analysis、Images、Artifacts、GitHub 及其他 connected apps 能由 ChatGPT 直接完成时，不重复委托 Codex。
- **Local Capability Plane** — 通过 Custom MCP App + Secure Tunnel + Local MCP 补齐 Local Machine / Local Workspace 能力。
- **Direct Local** — 适合 workspace read/search/status/diff、bounded edit 和 focused verify。
- **Codex delegation** — 适合 multi-file implementation、debug、refactor、shell-heavy work 和 iterative tests/builds。
- **Evidence-first verification** — Executor `RESULT` 只是 evidence candidate；Brain 会尽可能重新读取 GitHub、CI、Web 或 local resource state 后再验收。
- **Zero human relay goal** — 用户不需要做人肉消息总线。

## 架构

```mermaid
flowchart TD
    U[User Goal] --> B[ChatGPT Brain]
    B --> D[Evidence / Decision / Capability Discovery]
    D --> R[Capability Routing]

    R --> P[ChatGPT Product Capabilities]
    P --> N[Built-in Native]
    P --> A[Connected Apps]

    R --> L[Local Capability Plane]
    L --> MCP[Secure Tunnel + Local MCP]
    MCP --> DL[Direct Local]
    MCP --> C[Codex App Server]

    N --> V[Independent Verification]
    A --> V
    DL --> V
    C --> V
    V --> B
```

这里的 **Executor 不等于 Codex**。Codex 是重要的本地 coding executor，但不是所有任务的默认下游。

未来也可以按真实需求接入 Claude、DeepSeek 或其他 Agent 作为 specialist / advisor / executor；当前项目仍以 ChatGPT 为 authoritative Brain。

## 当前状态

- 最新正式版本：`v0.1.0-alpha.3`
- 当前开发方向：Capability-first v0.2
- v0.2 仍处于真实项目 dogfood / hardening，尚未作为默认运行路径发布

开发状态与当前阶段见 [`PROJECT_STATUS.md`](PROJECT_STATUS.md)，高层路线见 [`ROADMAP.md`](ROADMAP.md)。

## Quick Start

### Requirements

- Node.js `>= 22`
- Git
- Codex CLI（涉及本地 Codex execution 时）

### Install and test

```bash
git clone https://github.com/SIMON-WORLD/chatgpt-codex-orchestrator.git
cd chatgpt-codex-orchestrator
npm install
npm test
```

### Current released workflow

当前正式 release 的运行时接线和使用方式见 [`SKILL.md`](SKILL.md)。

### v0.2 local runtime

```bash
npm run start:v0.2
```

> v0.2 仍是 candidate，不代表已经完成 default flip 或正式 release。

## Routing policy

当前规范性 capability / executor policy 见 [`CAPABILITY_ROUTING.md`](CAPABILITY_ROUTING.md)。

四类顶层 route：

- `CHATGPT_NATIVE`
- `CHATGPT_DIRECT_LOCAL`
- `CODEX_DELEGATE`
- `HYBRID`

Route、Capability 和 Provider 是三个不同概念；不会因为接入 GitHub、Gmail、Notion、Figma 或未来其他 App，就不断增加新的顶层 route enum。

## 文档

- [`PROJECT_STATUS.md`](PROJECT_STATUS.md) — 当前项目状态
- [`ROADMAP.md`](ROADMAP.md) — 已接受的高层路线
- [`CAPABILITY_ROUTING.md`](CAPABILITY_ROUTING.md) — 当前 routing / executor policy
- [`docs/architecture.md`](docs/architecture.md) — 技术架构参考
- [`docs/rfc-v0.2-chatgpt-native-capability-inventory.md`](docs/rfc-v0.2-chatgpt-native-capability-inventory.md) — ChatGPT-native capability research
- [`CHANGELOG.md`](CHANGELOG.md) — 发布历史
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — 贡献指南
- [`SKILL.md`](SKILL.md) — 当前 released runtime 的 agent-facing 使用说明

## License

[MIT License](LICENSE)
