# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [0.6.0] - 2026-06-09

### Added

- Agent MCP auto-installer: sniffs Cursor, VS Code, Trae, Claude Code, and Windsurf; writes GraphFlow MCP to user and workspace config (creates missing files).
- VS Code extension auto-installs bundled MCP on first install/upgrade (`onStartupFinished`).
- New extension commands: `GraphFlow: Install MCP to Agents`, `GraphFlow: Model Setup Guide`.
- Post-install model configuration guide in Output panel and `.graphflow/README.md`.

## [0.4.2] - 2026-06-01

### Fixed

- VS Code extension host `Cannot find module 'typescript'`: `typescriptIndexer` now loads `typescript` via `createRequire` lazily and falls back to the regex extractor when unavailable.
- `sync-runtime.mjs` now bundles `typescript` and `gpt-tokenizer` into `vendor/graphflow/node_modules/` so the extension runtime can resolve them; `.vscodeignore` explicitly whitelists `vendor/**`.

## [0.4.1] - 2026-06-01

### Fixed

- VS Code extension host `Cannot find module 'better-sqlite3'`: `sqlite-client` switched to dynamic `createRequire`; `client-factory` catches the load failure and degrades the `sqlite` transport to `GraphifyFileClient` with a single warning instead of crashing.
- Moved `better-sqlite3` from `dependencies` to `optionalDependencies` so installs without native build tooling still succeed.

## [0.4.0] - 2026-05-31

### Added

- StdIO MCP server entrypoint (`graphflow-mcp`) for Cursor, Claude Code, and other MCP-capable agents.
- JSON CLI mode for all primary commands via `--json`.
- Agent guidance files: `AGENTS.md`, `CLAUDE.md`, and `.cursor/rules/graphflow.mdc`.
- Integration config samples under `docs/integrations/`.
- CLI help/version entrypoints (`--help`, `--version`).
- AST-based workspace indexer (TypeScript Compiler API) emitting real Symbol nodes (function/class/interface/type/enum/variable/method) and cross-file `references` edges, with regex fallback on parse errors.
- LLM-driven agent variants: `planTasksLlm`, `brainstormTaskLlm`, `validateTaskResultLlm`, each with deterministic JSON fallback.
- Orchestrator options `enableLlmAgents`, `enableDriftReplan`, `maxReplanRounds` — failed DAG triggers a planner re-plan loop with `previousPlan` + `failureFeedback` before HUMAN_REVIEW.
- Skill fusion: composite Skill nodes synthesized when `coOccurCount >= 2 && successCount >= 2`; `prerequisite` edges A→C and B→C; `suggestSkillHints` prioritizes composite skills when both parents match.
- Prompt context injection: `executeRolePrompt` accepts `PromptContext`; orchestrator option `enableGraphContextInPrompt` threads `summaryChannel` + `skillHints` into planner / brainstormer / worker / validator prompts; `TaskRunResult.promptContextLines` records actual injected lines.
- Node content compression: Symbol content is a signature line (`function planTasks (exported) @src/agents/planner.ts:14`), File content adds `# exports: ...` suffix, raw JSON moved to optional `GraphNode.metadata` (~1.76× byte reduction per Symbol).
- Real tokenizer (`gpt-tokenizer` / o200k_base, lazy-loaded with graceful fallback) replaces `length/4` token estimate.
- Inverted-index keyword lookup + adjacency lists on memory and file graph clients; new `getNodesByIds` and `getNeighbors` (optional on MCP client).
- `expandSubgraph` BFS along `references / imports / depends_on / prerequisite` edges; `buildLayeredContextPackage` pulls 1-hop neighbors of top hits into the same token budget (opt-out via `LayeredPackageOptions.enableEdgeExpansion=false`).
- SQLite + FTS5 graph backend (`transport: "sqlite"`) via `better-sqlite3`: WAL mode, idempotent CREATE schema, FTS5 sync triggers, edges PK + from/to/relation indexes; implements `getNodesByIds` and `getNeighbors`.
- Vector recall with reciprocal-rank fusion: `src/learning/embeddings.ts` provides deterministic `hashEmbedding` + `createOpenAiEmbeddingProvider` + `reciprocalRankFusion`; `buildLayeredContextPackage` accepts `enableVectorRecall` / `embeddingProvider` / `vectorTopK` / `vectorMinSimilarity` for semantic+keyword fusion.
- Episodic Memory + Reflection: `src/learning/episodic-memory.ts` persists Episode nodes per task run; `src/learning/reflector.ts` clusters similar episodes and synthesizes Lesson nodes with `improves` edges; orchestrator `enableEpisodicMemory` injects past keyDecisions into PromptContext.extraInstructions; nightly-trainer optionally runs reflection when given a graph client.
- Cross-language workspace indexer: TypeScript / JavaScript (AST via TS Compiler API) + Python / Rust / Go / C / C++ (regex-based) via dispatch in `src/graph/language-indexers/`; uniform Symbol / Module / defines / imports / references output across all languages.
- Tests: m16 agent integrations, m17 release readiness, m18 AST indexer, m19 LLM agents + drift, m20 skill fusion, m21 prompt context injection, m22 node compression, m23 graph retrieval, m24 SQLite backend, m25 vector recall, m26 episodic memory, m27 multi-language indexer.

### Changed

- Root package metadata now matches Apache-2.0 and publishes `graphflow` / `graphflow-mcp` binaries.
- Default router and example config models now use `gpt-4.1` and `gpt-4.1-mini`.
- Config loader now resolves `${ENV_VAR}` placeholders from the process environment.
- Failed `runTask` executions now append negative feedback events for the learning flywheel.
- File indexer skips symbolic links while crawling a workspace.
- `GraphClient` interface extended with optional `getNodesByIds` / `getNeighbors`; MCP client degrades to `[]` on unsupported endpoints.
- `graphPolicy.transport` accepts `"sqlite"` in addition to `"memory" | "file" | "mcp-http"`.

### Verified

- `npm run ci`
- `npx vitest run` — 25 test files / 95 tests passing

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
