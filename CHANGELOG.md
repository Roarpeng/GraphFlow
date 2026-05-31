# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- StdIO MCP server entrypoint (`graphflow-mcp`) for Cursor, Claude Code, and other MCP-capable agents.
- JSON CLI mode for all primary commands via `--json`.
- Agent guidance files: `AGENTS.md`, `CLAUDE.md`, and `.cursor/rules/graphflow.mdc`.
- Integration config samples under `docs/integrations/`.
- CLI help/version entrypoints (`--help`, `--version`).

### Changed

- Root package metadata now matches Apache-2.0 and publishes `graphflow` / `graphflow-mcp` binaries.
- Default router and example config models now use `gpt-4.1` and `gpt-4.1-mini`.
- Config loader now resolves `${ENV_VAR}` placeholders from the process environment.
- Failed `runTask` executions now append negative feedback events for the learning flywheel.
- File indexer skips symbolic links while crawling a workspace.

### Verified

- `npm run ci`
- CLI/agent regression tests including MCP and config env expansion

## [0.3.0] - 2026-05-28

GraphFlow 在 `0.3.0` 完成了从“可跑的多智能体原型”到“可安装、可观测、可分发产品版”的收敛：
- CLI、VS Code 命令面板、`@graphflow` chat 三个入口全部打通
- 图谱存储切到本地持久化默认路径，支持观测与复用
- 学习飞轮、动态路由、夜跑训练、扩展打包与 CI 已形成闭环
- 正式使用测试已沉淀到 `docs/testing/2026-05-28-formal-usage-test-report.md`

### Added

- Core orchestration pipeline with simple/complex routing and DAG execution.
- Validator retry loop with human review fallback state.
- Criteria-based validation with matched/missing requirement reporting.
- Model tier routing and provider fallback path (OpenAI, Anthropic, 百炼, 豆包).
- Graph client factory with file, memory and Graphify MCP HTTP transports.
- Automatic graph sync after successful run.
- Near-lossless context packaging:
  - summary + anchor dual channel
  - L1/L2/L3 quotas
  - dynamic refill manager with de-dup anchors
- Workspace file indexer for File/Symbol graph nodes.
- CLI commands:
  - `run`
  - `plan`
  - `context preview`
  - `graph index`
  - `graph inspect`
  - `skill insights`
- Learning flywheel baseline:
  - feedback collector
  - sample builder
  - learning dataset exporter
  - canary gate
- VS Code extension scaffold integrated with GraphFlow runtime.
- VS Code extension command added: `GraphFlow: Plan & Brainstorm`.
- VS Code chat participant added: `@graphflow` with `/run`, `/plan`, `/history`.
- Dynamic routing health evaluation and configurable provider priority (`routingPolicy`).
- GitHub Actions CI workflow for lint/build/test/extension-build.
- CLI routing diagnostics command: `graphflow route diagnose`.
- CLI nightly learning command: `graphflow learn nightly`.
- Learning event persistence and nightly summary generation.
- File indexer now captures `Module` nodes and `imports/defines` graph edges.
- Skill flywheel module with skill extraction, skill scoring, and skill co-occurrence graph updates.
- Orchestrator integration for learned skill hints in planning and execution feedback.
- New chat slash commands: `@graphflow /diagnose` and `@graphflow /learn`.
- New chat slash commands: `@graphflow /graph` and `@graphflow /skills`.
- VS Code extension now bundles GraphFlow runtime, removing dependency on workspace `npm run start`.
- VS Code extension interactive observability panels:
  - Graph Snapshot with search, type filter, node focus, relation highlight
  - Skill Insights with search, outcome filter, and score/uses/time sorting
- Config template: `graphflow.config.example.json`.
- Formal usage test plan and final pass report under `docs/testing/`.

### Changed

- README updated to match implemented features and runnable commands.
- Release notes updated to reflect bundled runtime, observability panels, and formal validation artifacts.
- Config schema expanded with graph and near-lossless controls.
- Default graph transport updated to `file` for persistent local usage testing.
- Config schema expanded with `skillPolicy` controls.

### Verified

- `npm run lint`
- `npm run build`
- `npm test` (40 tests passing)
- CLI smoke checks for `graph index` and `context preview`
- CLI smoke check for `plan`
- CLI smoke checks for `route diagnose` and `learn nightly`
- CLI smoke checks for `graph inspect` and `skill insights`
- VS Code extension build
- VS Code extension package (`artifacts/graphflow-vscode-0.3.0.vsix`)
