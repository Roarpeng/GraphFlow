# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [1.3.1] - 2026-06-29

### Added

- **`graphflow_skill_guide` MCP 工具**：通过 MCP 协议直接提供 Skill 指南内容，不依赖外部文件安装，解决 C 盘权限不足导致 Skill 无法使用的问题。

### Changed

- **工作区级 Skill 回退安装**：当用户级目录（如 `~/.trae/User/skills/`）写入失败时，自动回退安装到项目目录 `.graphflow/skills/graphflow/SKILL.md`。
- **MCP 工具描述增强**：核心工具描述添加"Context First"原则：
  - `graphflow_preview_context`：强调"ALWAYS CALL THIS FIRST"
  - `graphflow_plan`：强调"USE AFTER graphflow_preview_context"
  - `graphflow_expand_anchor`：强调"USE THIS AFTER graphflow_preview_context"
  - `graphflow_index`：强调"CALL AFTER significant file changes"

### Fixed

- **C 盘权限不足导致 Skill 无法使用**：通过 `graphflow_skill_guide` 工具和工作区级回退安装双重保障，确保即使没有 C 盘编辑权限也能正常使用 GraphFlow。

## [1.3.0] - 2026-06-28

### Added

- **Agent Skill 安装**：`installAllSkills` 写入 Cursor / Claude Code / Codex 的 `skills/graphflow/SKILL.md`（非保留目录 `skills-cursor`）。
- **`graphflow doctor`**：自检各 agent 的 MCP 注册、指令文件与 Agent Skill 状态。
- **委托模式 5-Why**：`agentWorkItems` 新增 6 个可选 `five-whys` 项；merge 解析 `whyChain` 并填充 `rootCauses`。
- **Token benchmark**：`benchmarks/run-token-benchmark.ts` 与 `npm run benchmark`。
- **竞品分析**：`docs/comparison.md`。
- **测试**：`tests/m17b-agent-instructions.test.ts`（Claude MCP 路径 + 指令块安装）。

### Changed

- **启发式 `planTasks`**：支持中文连词拆分；单句任务生成分析→实现→测试三阶段 DAG。
- **`refinedTaskStatement`**：无 5-Why 根因时回退蓝帽综合，避免误显示「待探索」。
- **MCP 安装路径**：Claude Code → `~/.claude.json`；Gemini → `~/.gemini/settings.json`。
- **Windsurf / Codex / Gemini** 全局指令块（append-with-markers 安全写入）。
- **README** 快速上手与竞品对比表更新。

### Fixed

- Cursor 用户此前只能看到 Rule、看不到 Skill 的问题（现同时安装 Rule + Skill）。

## [1.0.9] - 2026-06-26

### Added

- **Agent-delegated LLM（无 API 模式）**：未配置 provider API 时，`graphflow_plan_insight` / complex `graphflow_run` 返回 `agentWorkItems`，由连接的 coding agent 用自己的模型回答 Six Hats prompts。
- **MCP 闭环工具**：`graphflow_submit_insight`（回传每条 work item 分析）、`graphflow_merge_insight`（合并为完整 insight + DAG plan）。
- **Skill 质量**：`extractSkillAtoms` 过滤 stopwords / 路径噪声，保留短语与 head token。
- **Adaptive budget**：complex 任务默认启用自适应 token 预算；配置默认 `enableAdaptiveBudget: true`。
- **Calls 边增强**：caller 缺失时按行号回退解析；Snapshot 优先展示 `calls` / `defines` 边。
- **L2/L3 锚点**：Module 父节点与架构类查询的 Skill/Decision 注入。
- **Monorepo**：`discoverWorkspacePackages` + Snapshot `workspacePackage` 元数据。
- **语言索引**：Kotlin（`.kt`/`.kts`）、Swift（`.swift`）tree-sitter 索引器。
- **MCP 模块化**：拆分 `tool-definitions.ts` / `tool-handlers.ts` / `version.ts`。
- **VS Code**：Agent Work Items 面板、`graphflow.planInsight` 命令；Chat `/insight` 与 agent-delegated 闭环指引。

### Changed

- Bridge 文档强化：`report_outcome` / `submit_insight` 为必做步骤（AGENTS.md、Cursor rules）。
- `graphflow_inspect_graph` 支持 monorepo 包分组。

### Fixed

- `parseAgentInsightResponse` 优先解析 JSON 数组（plan-refinement）。
- Skill 融合测试与 stopword 过滤的平衡（m20 回归）。

## [1.0.3] - 2026-06-24

### Fixed

- **CI**：`m17` 测试不再硬编码 `/usr/bin/node`，兼容 GitHub Actions hosted Node 路径。
- **图谱存储**：`graphify-file-client` 原子写入（temp + rename）；损坏 JSON 时优雅降级为空 store 并提示 rebuild。
- **上下文检索**：`rankNodesForContextQuery` 降低 `.cursor/mcp.json`、`docs/integrations` 等配置噪声，优先 `src/` 与 Symbol 节点。
- **MCP metrics**：`graphflow_metrics` 支持 `rootDir` 并绑定工作区。

## [1.0.2] - 2026-06-24

### Fixed

- **MCP ENOENT（fnm 临时路径）**：安装 MCP 时不再写入 fnm multishell 临时 `node` 绝对路径；优先使用 IDE 自带 Electron（`ELECTRON_RUN_AS_NODE`），否则回退稳定 `node`。
- **Trae CN 支持**：安装器识别 `~/.trae-cn` 并写入 `~/.config/Trae CN/User/mcp.json`。

## [1.0.1] - 2026-06-24

### Fixed

- **多项目工作区隔离**：MCP / 扩展 / npm 包不再把图谱绑定到 vendor 目录或全局配置里的陈旧 `workspaceRoot`。
- **自动发现工作区**：新增 `discover-workspace`，从 cwd 向上查找项目根；仅在 runtime 目录（vendor、extensions）时回退到 IDE 环境变量。
- **MCP launcher**：子进程 `cwd` 与 `GRAPHFLOW_WORKSPACE_ROOT` 指向用户打开的项目，不再固定在扩展 vendor。
- **MCP 安装器**：默认写入 `GRAPHFLOW_WORKSPACE_ROOT: "${workspaceFolder}"`，merge 已有 env，扩展有工作区时同时写用户级与项目级配置。
- **MCP 工具**：`preview_context`、`inspect_graph`、`skill_insights`、`stats` 支持可选 `rootDir` 覆盖。

## [1.0.0] - 2026-06-19

首个正式版本。在 0.6.x 基础上完成「诚实执行语义」收敛与「上下文压缩」体系，所有新增能力均端到端接线到 CLI / MCP / orchestrator。

### Added

- **混合压缩模型策略（compressor role）**：新增 `compressor` 角色，默认复用 economy tier（`backend: "inherit"`）——配置了外部 provider（OpenAI/Anthropic/百炼）就用其 economy 模型，纯离线则回退内嵌 minicpm。零额外配置。
- **内嵌模型首次自动下载**：无外部 LLM 时，`resolveCompressionModel` 复用既有断点续传下载器，首次按需拉取 minicpm GGUF 到 `~/.graphflow/models/`（类似 Playwright 浏览器下载）。
- **图结构压缩（零成本，默认开启）**：`graph-compression.ts` 提供边权重加权连通子图（`extractConnectedSubgraph`）、加权 PageRank 中心性（`computePageRank`）、检索序与中心性融合重排（`blendWithCentrality`）。preview / orchestrator 默认启用。
- **语义压缩（opt-in）**：`semantic-compression.ts` 通过 minicpm/economy LLM 对相似节点聚类合并（`clusterSimilarNodes` + `summarizeCluster`）、长节点改写（`densifyNodeContent`），由 `graphPolicy.compression.enabled` 开启。
- **RepoMap 概览模式（opt-in）**：`repo-map.ts` 在 token 预算紧张时返回模块级地图（每模块一行 exports 摘要），由 `compression.enableRepoMapFallback` 开启。
- **自适应 Token 预算（opt-in）**：`adaptive-budget.ts` 的 `estimateContextBudget` 按任务复杂度（refactor/多文件/架构/局部修复/加测试）动态调整预算，由 `compression.enableAdaptiveBudget` 开启。
- **HNSW 向量索引（可选依赖）**：`hnsw-index.ts` 在候选集 ≥200 节点时使用 hnswlib-node ANN 加速（10~100x），未安装时优雅降级线性扫描。`hnswlib-node` 列为 optionalDependency。
- **`buildEnhancedContextPackage`**：统一六步压缩 pipeline（RepoMap fallback → 关键词+向量召回 → 图压缩 → 语义压缩 → 分层配额 → 边扩展），preview 与 orchestrator 共用。
- **压缩诊断**：`route diagnose` 输出新增 `compression=<backend>:<provider>/<model>` 行，可查当前压缩模型来源。
- 测试 m43（bridge 模式）、m44（增强压缩）、m45（真机 benchmark）。

### Changed

- **执行语义诚实化（bridge 模式）**：`graphflow_run` 默认进入 bridge 模式——规划 + 压缩上下文后输出 `executionDescriptor` 移交外部 coding agent 执行，状态为 `HUMAN_REVIEW_REQUIRED` 并标注 `[DELEGATED]`，不再伪造 `COMPLETED`。
- **校验启发式标注**：规则校验结果统一标注 `[heuristic]` 与 `heuristic_validation` riskTag；检测并拒绝 provider 占位符回显（`[openai:model] ...`）。
- `graphPolicy.compression` 配置项扩展：`enableGraphCompression` / `enableRepoMapFallback` / `enableAdaptiveBudget` / `enableHnsw`。

### Fixed

- worker 兜底分支不再返回 `"Simulated change..."` 伪造输出，无可用执行模式时抛出明确错误。
- README 版本号、测试数与失效文档引用同步至 1.0。


### Added

- MCP server 优雅停机：监听 `SIGTERM`/`SIGINT`，停止接收新的 stdin 输入并给在途请求短暂 flush 窗口后退出，避免长驻进程被硬杀导致状态丢失。
- `VectorStore.close()`：释放底层 SQLite 句柄，与 `SqliteClient.close()` 对齐，避免长驻进程文件描述符泄漏。
- MCP 工具入参长度上限（`MAX_STRING_FIELD_LENGTH`），防止超大 payload / prompt injection 风险。

### Changed

- `provider-executor` 改用结构化 `logger` 替换裸 `console.warn/error`，确保生产环境日志可被聚合采集。
- `orchestrate()` 增加顶层错误边界：上下文构建 / DAG 执行 / 图同步的未捕获异常统一收敛为结构化 `HUMAN_REVIEW_REQUIRED` 结果，不再裸抛给调用方。

### Fixed

- DAG 执行 timeout 定时器在任务成功路径未被清除，长驻进程下存在 timer 泄漏；改为 `finally` 中 `clearTimeout`。
- `m12-dynamic-routing` 测试不再依赖对 `api.anthropic.com` 的外网可达性：将 anthropic `baseUrl` 指向本地立即拒绝连接的地址，确定性触发非 strict 降级路径。

## [0.6.13] - 2026-06-14

### Fixed

- 知识图谱面板力导向布局在大量节点时坐标爆炸，导致 viewBox 过大、画布仅显示角落小点；布局后归一化到画布并收紧力模拟参数。

## [0.6.12] - 2026-06-14

### Added

- `snapshot-view` 模块：图谱样本的可读标签（`displayLabel`、`displayPath`、`folderGroup`）、分层视图（代码层 / 学习层）、按目录多样性采样。
- 知识图谱面板：暗色主题、分层 Tab、目录聚类着色、关系线型区分、双击/按钮跳转源文件。

### Changed

- `inspectGraph` 默认样本上限提升至 96 节点 / 160 边；VS Code「查看图谱」命令使用 120 / 200。
- 节点摘要预览长度由 96 提升至 160 字符。

## [0.6.11] - 2026-06-14

### Changed

- 默认开启 `autoIndexOnSave`：保存/变更文件后 debounce 增量索引，实现项目更新时持续静默建图。
- 路由就绪校验要求开启 Auto index on file save。
- 旧配置中遗留的 `maxContextTokens: 400` 自动升级到 1500。
- `graphflow.config.example.json` 同步 `autoIndexOnSave` 与 `maxContextTokens: 1500`。

## [0.6.10] - 2026-06-14

### Added

- `runtime/` 子模块：`env`、`settings`、`graph`、`routing`、`panel`、`helpers`、`facade`。
- `GraphFlowRuntimeModule` 与 `assertGraphFlowRuntime()`：扩展动态加载时使用统一类型校验。
- VS Code 扩展 esbuild 单文件打包（`dist/extension.js`）。

### Changed

- `runtime.ts` 改为薄 re-export 层；业务逻辑拆分到子模块。
- 扩展移除手写 `GraphFlowRuntime` 接口，改用 core 导出的类型。

## [0.6.9] - 2026-06-14

### Added

- `loadConfigSafe`：损坏/缺失配置文件时回退默认配置并记录告警。
- `hasPendingGraphIndexWork`：无文件变更时跳过 preview/run 的自动索引。
- `runtime/types.ts`：CLI/MCP 公共类型集中导出。
- `vscode-extension/src/workspace.ts`：可测试的工作区 cwd 解析。
- 测试 `m41-optimization-hardening`。

### Changed

- `postinstall` 默认不再自动 init/MCP 注入；需 `GRAPHFLOW_ENABLE_POSTINSTALL=1` 显式开启。
- CI 根依赖安装改为 `npm ci`，提升可复现构建。
- 默认 `maxContextTokens` 从 400 提升到 1500，避免宽查询预览为空。
- 文件索引器合并 stat 遍历，减少重复 I/O。
- VSIX `.vscodeignore` 裁剪 vendor 中的 map/d.ts/tests/docs。

### Fixed

- 损坏的全局/项目 JSON 不再导致 GraphFlow 启动失败。

## [0.6.8] - 2026-06-14

### Fixed

- 扩展在无工作区文件夹时也可打开 Settings 并保存全局模型配置；首次安装自动弹出 Settings 面板。
- `showSetupGuide` 不再因未打开项目而失败；图谱建立/路由测试在无工作区时给出中文提示。

## [0.6.7] - 2026-06-14

### Added

- 全局配置优先：`resolveWritableConfigPath` 默认将 Settings 保存到 `~/.graphflow.config.json`。
- MCP 安装范围：`installScope: "user" | "all"`，默认仅写入用户级 Agent 配置（如 `~/.cursor/mcp.json`）。
- 测试 `m40-config-global-first`：覆盖全局读取/写入与 MCP 用户级默认行为。

### Changed

- 扩展首次安装只 scaffold 全局 `~/.graphflow.config.json`，不再自动创建 `.graphflow/config.json` 工作区覆盖层。
- `resolveConfig` 以全局配置为底，项目 `graphflow.config.json` / `.graphflow/config.json` 作为可选覆盖层合并。
- `npm postinstall` / `graphflow init` 改为全局配置 + 用户级 MCP；README 说明更新为一次配置、所有项目可用。
- 配置指南（`formatModelConfigGuide`）优先展示全局配置路径。

### Fixed

- `saveGraphFlowSettings` 补全 `resolveGlobalConfigPath` 导入，修复扩展打包 TypeScript 编译错误。

## [0.6.6] - 2026-06-11

### Added

- Settings 面板：**建立图谱（无需 LLM）** — 仅需图谱存储路径即可扫描工作区并生成结构图谱（文件、符号、依赖）。
- Settings 面板：**路由连通性测试（可选）** — LLM 配置就绪后探测 Smart / Economy 路由，连通通过后自动索引并可运行语义提取。
- Runtime API：`indexGraphFromSettings`、`testRoutingAndIndexGraph`、`validateSettingsForGraphIndex`、`validateSettingsForRouting`。

### Changed

- 配置指南明确双路径：无 LLM 结构索引与可选 LLM 路由验证并存；语义提取失败时仍保留结构图谱。

## [0.6.5] - 2026-06-11

### Added

- Settings 面板：图谱状态（节点/边数、上次索引时间）、配置覆盖层 diff、一键路由诊断。
- `graphPolicy.autoIndexOnSave`：保存文件后 debounce 增量索引（Extension 可选开关）。
- `getSettingsPanelStatus` / `listConfigOverlayKeys`：Settings 与 CLI 共用状态 API。
- Husky pre-push：`lint-staged` 在推送前自动跑 ESLint。
- CI：`validate.yml` 可复用工作流；PR 与 main 发布分离；`v*` tag 触发 Build / npm publish。
- `postinstall` 完成后轻量 bootstrap `indexGraph`（非 CI 环境）。

### Fixed

- Settings 面板 HTML 模板中反引号导致 ESLint 解析失败，阻断 0.6.5 GitHub Actions 与 Release。

### Changed

- 收紧多处 `any` 类型；提交 `vitest.config.ts` 排除 extension 测试。
- README 更新至 v0.6.5，补充 Release 与本地 `npm run ci` 说明。

## [0.6.4] - 2026-06-10

### Added

- `graphPolicy.semanticEnrichment.backend`: `inherit` | `network` | `local`，明确区分网络模型与本地 OpenBMB。
- 语义提取可单独配置网络 API Key / Base URL（`semanticEnrichment.apiKey` / `baseUrl`）。
- Settings 面板「语义提取后端」：继承 Economy（网络）/ 自定义网络模型 / 本地 OpenBMB。

### Changed

- 语义富化运行时注入独立网络凭证（`applyEnrichmentProviderEnv`）；任务编排后增量富化同步应用。
- MCP `graphflow_enrich_graph` 描述更新为支持云端或本地后端。

## [0.6.3] - 2026-06-10

### Added

- `src/config/secrets.ts`: API Key 支持环境变量名、`${VAR}` 占位符、或直接 `sk-...` 明文；运行时按类型自动解析。
- Settings 面板新增 **Graph Semantic Enrichment**（知识图谱语义提取）：可单独配置 provider/model，或留空继承 Economy 层。
- `graphPolicy.semanticEnrichment.provider` 可选字段，允许语义提取使用与 Worker 不同的 provider。

### Changed

- Smart / Economy 模型改为可选；未配置时由 `model-router` 默认表按 provider 回退。
- 语义提取模型不再默认 `minicpm5-1b`；可配置 DeepSeek（`openai` + `baseUrl` + 模型名）或其它云端/本地模型，也可留空。
- OpenBMB 设置与语义提取解耦；OpenBMB 区块仅用于本地 MiniCPM。
- `formatModelConfigGuide` 与初始化文档补充 API Key 规则与图谱更新说明。

## [0.6.2] - 2026-06-10

### Fixed

- MCP install on Windows now uses `mcp-launcher.cmd` / `mcp-launcher.cjs` so `server.js` is never the MCP `command` (fixes Cursor opening the file as an editor tab).
- Vendor bundle skips Linux-only `onnxruntime-node`; GitHub Release VSIX is built on `windows-latest`.
- CI: Ubuntu runs full tests; Windows job only packages the VSIX. SQLite tests skip when optional `better-sqlite3` is unavailable.

## [0.6.1] - 2026-06-10

### Fixed

- MCP auto-install now uses system `node` (or Cursor/Electron with `ELECTRON_RUN_AS_NODE`) instead of writing `process.execPath` from the extension host, which broke MCP stdio on other machines.
- MCP server logs are redirected to stderr so JSON-RPC on stdout is not corrupted.
- Bundled MCP `cwd` points at the extension vendor runtime root for reliable module resolution.
- Extension first-install now scaffolds `~/.graphflow.config.json` (global) and workspace `.graphflow/config.json` when a folder is open.

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
