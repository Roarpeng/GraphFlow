# Changelog

All notable changes to this project are documented in this file.

## [1.9.6] - 2026-08-03

### Fixed

- **Cursor/VS Code MCP 启动失败**：扩展 vendor 打包漏掉 `@modelcontextprotocol/sdk`，MCP launcher 加载 `vendor/graphflow/dist/surfaces/mcp/server.js` 时抛出 `Cannot find module '@modelcontextprotocol/sdk/server/index.js'`（Connection closed / -32000）。`sync-runtime.mjs` 已将 MCP SDK 纳入 `runtimeRoots`，并在同步后校验必选包存在；新增 `test:mcp` 烟雾测试防止回归

## [1.9.5] - 2026-08-01

### Fixed

- **图谱索引排除 Agent 工具目录（P1）**：`IGNORED_DIRS` 新增 `.agent` / `.claude` / `.cursor` / `.gemini` / `.joycode` / `.trae` / `Cursor`——`.claude/worktrees` 为每个 worktree 保存完整仓库副本，此前被当作源码索引进图（本地实测 1421 个 File 节点中 1076 个来自 worktrees，占 76%），污染检索锚点、PageRank 与存储；修复后 `graph rebuild` 扫描文件数从 ~1500+ 降至 326，旧图可在下次增量/全量索引时自动清理
- **增量索引剪枝批量删除（P1，读写放大修复的伴生问题）**：排除目录后首次增量索引需从缓存差集剪除大量过期节点，而 `pruneFileFromGraph` 逐节点 `deleteNode`（file 后端每次全量读写 JSON，实测 62MB 图 × 1000+ 节点 → 305s 挂起）；新增可选能力 `GraphClient.deleteNodes(ids)`（file 单次读+写、sqlite 单事务分块 IN、memory 批处理，均级联清理悬空边），剪枝改为单次快照读取 + 单次批量删除，mcp-http 试点保留逐节点回退路径
- **测试 95 文件 / 656**（+2 walker 排除、+1 剪枝批量删除、+1 file 批量删除用例）

## [1.9.4] - 2026-08-01

### Changed

- **扩展市场说明更新**：vscode-extension/README.md 重写为 v1.9.x 最新使用说明（记忆审计 CLI、飞轮归因面板、语义 embedding 配置、技能分类、skill sync、改名后市场身份 `roarpeng.graphflow` / `GraphFlow Context & Memory`）；扩展 description 改为版本无关描述（消除版本钉死导致的文档腐化）

## [1.9.3] - 2026-08-01

### Fixed

- **Marketplace 发布（二次）**：`GraphFlow` 显示名亦被第三方占用（不出现在公开搜索，疑似下架/保留名），改为 `GraphFlow Context & Memory`

## [1.9.2] - 2026-08-01

### Fixed

- **Marketplace 发布**：新身份 `roarpeng.graphflow` 的 displayName 改为 **`GraphFlow`**（`GraphFlow Tool` 被旧列表 `roarpeng.graphflow-tool` 持有，VS Marketplace 拒绝重复 displayName；经 Marketplace 搜索 API 验证 `GraphFlow` 未被占用）

## [1.9.1] - 2026-08-01

记忆透明化版本:让「跨会话记忆」可度量、可审计、可归因。

### Added

- **记忆 ROI 基准（正式化）**：`npm run benchmark:memory`（`benchmarks/run-memory-ab.ts`）——62 任务（26 golden + 36 hard：跨模块影响面/消歧/间接形态），记忆开 vs 关双臂，实测 **ON 100.0% vs OFF 56.5%**（救回 27 任务、0 受损，其中 hard 域 17 个）；**归因链**逐任务记录「哪条记忆救了哪个任务」（top episode + 相似度 + 注入文本），JSON 落 `benchmarks/.cache/memory-ab-results.json`
- **记忆审计 CLI**：`graphflow memory list [--outcome pass|fail|pending]`（证据记录：id/任务/结局/lessons/staleGoal）、`memory search "<query>"`（相似度排序命中）、`memory forget <id>`（物理删除，未知 id 干净 no-op）；runtime facade 暴露 `listEpisodes/searchEpisodes/forgetEpisode`
- **飞轮报告归因区块**：`getFlywheelReport` 新增 `memoryAttribution`（memoryHits / staleEpisodes / confidence 分布 / topContributingMemories 证据链 / deviationBreakdown），全字段增量兼容

### Changed

- **VS Code 扩展改名**：`graphflow-tool` → **`graphflow`**（Open VSX 名称可用已验证；新身份 `roarpeng.graphflow`，VSIX 产物 `graphflow-<version>.vsix`）；扩展包名、agent 标识、CI 工件、文档同步
- **测试 94 文件/646 → 95 文件/652**，全量通过

## [1.9.0] - 2026-08-01

技能质量与团队化版本:飞轮从「机制完整、效果未知」走向「A/B 实证 + 质量门禁 + 团队共享」。

### Added

- **语义 embedding 可选后端（P0）**：`graphPolicy.embeddingProvider: "fnv" | "transformers"`（默认 `fnv` 离线安全）；`transformers` 时经 `@huggingface/transformers` 懒加载 all-MiniLM-L6-v2，任何失败（缓存缺失/超时/加载错误）永久降级 FNV-1a 并告警；`graphflow_diagnose` 新增 `embeddingBackend: semantic | off` 上报活动后端
- **技能结果分类（P0）**：单一分数升级为 `proven / correctable / anti-pattern / noise` 四类——noise 提取即拒、装载时清理（`cleanupNoiseSkills`）；仅 anti-pattern 记负分（消灭「首次失败即 -20 下沉」）；proven 需 ≥2 次使用或链接成功结局
- **检索 golden set 26 → 132（P1）**：10 域覆盖（含 PLC），12 负样本断言 + 132 Top-K 位置断言（rank 稳定性门），每域 ≥8 查询护栏
- **技能飞轮端到端 A/B 基准（P1）**：`npm run benchmark:ab` 以 golden 查询为任务集、真实学习路径跑双臂——实测飞轮开 **100.0% vs 关 61.5%**（救回 10 任务、0 受损），开销 33 tok/任务
- **CI 版本一致性门禁（P1）**：`scripts/ci-version-check.cjs` 断言 package.json / CHANGELOG 最新条目 / README 徽章三源一致；CI 新增 skill A/B 基准 job（文件存在性守卫）
- **skill sync 双向 merge（P2）**：导入改为按技能 ID 合并——同 ID 取较新 `updatedAt`、平手保本地、本地独有保留；`--force` 恢复覆盖；包 schema 1.1 新增 `goldenQueries`，团队 golden 集随包同步（合并去重写 `.graphflow/team-golden.json`）
- **VS Code 飞轮贡献面板（P2）**：新增「Flywheel · 学习飞轮贡献」区块——技能正/中/负分布、topUsed、episodes pass/fail/pending 结果条；`runtime.getFlywheelReport()` 暴露数据
- **Graphify mcp-http 团队后端试点（P2）**：`GraphifyMcpClient` 补齐完整 `GraphClient` 接口，所有操作 `withFallback` 失败降级本地 file 存储；端点校验 + 15s 超时 + `readSnapshot`/`ping`/`isDegraded`；README 试点说明
- **PLC 索引器加固（P0）**：PLCopen XML POU `returnType`（嵌套/inline 双形态）提取为 `POU.return` 符号；ST 分析器 CASE 数值分支（`1:` / `1..10:`）不再被误判为跳转标签；45 测试 + 双 fixture

### Changed

- **测试 92 文件/489 用例 → 94 文件/646 用例**，全量 14.7s 通过
- `vitest.config.ts` 排除 `.claude/worktrees/**`，根治多 worktree 并行时测试互扫污染（m50 假失败）

### Fixed

- skill 节点全负分（-2/fail）根因：浅层 n-gram 技能（update/readme）被提取——现按符号证据门禁拒绝

## [1.8.0] - 2026-07-28

目标对齐（Goal Alignment）版本：让 Agent 在长时间、多步骤任务中始终记得为什么出发——治「需求理解不透」与「干着干着偏离」两大痛点。

### Added

- **Goal 锚点节点化（P0）**：`intent-analysis` / `simple-plan-intent` / `clarification` 提交自动把意图五元组（coreProblem / successDefinition / nonGoals…）固化为图一等公民节点（`goal:<hash(task)>`，metadata `kind:"goal"`）；`PromptContext.goalAnchors` 在每次打包时以最高优先级位置注入原始需求，orchestrate 各角色 prompt 全程可见
- **低置信度澄清门（P3）**：intent 载荷新增 `confidence`；有效置信度 < 0.6 时 merge 拒绝定稿（`complete=false` + `needsClarification=true` + `intentConfidence`），须先提交 `clarification` work item 澄清至 ≥ 0.6；无 confidence 字段的旧载荷按 1.0 处理（向后兼容）
- **alignment-check 执行期回检（P2）**：新 work item（`kind:"alignment"`，optional）——子任务/计划完成后回检「产出是否服务 successDefinition、是否触碰 nonGoals」，附 drift 分类；simple bridge 与 full ATP 的 agentInstructions 均加入执行期协议说明；永不阻塞 merge
- **deviation 偏离分类（P1）**：`report_outcome` / `outcome report --deviation` 接受 `none | misread-requirement | scope-creep | tech-drift`，持久化到 episode record；飞轮报告新增 `episodes.deviations` 聚合与 `goals`（active/superseded）统计；MCP `graphflow_report_outcome` schema 同步
- **Goal 版本链 + 变更 diff（P4）**：需求实质变更时旧记录快照为 `goal:<hash>:v<n>`（status `superseded`），active 节点版本 +1 并带 `changedFields` diff；同任务 pending episodes 自动标记 `staleGoal`；相同再提交仅刷新时间戳
- **ATP/IR 规范 v1.1**：`docs/atp-ir-spec-v1.md` 升级——§4.3 协议级 work items、§5.1 goal anchor / clarification gate / alignment check / deviation / goal versioning（纯增量，v1.0 兼容）

### Changed

- **测试**：新增 `tests/goal-anchor.test.ts`（12 用例覆盖 P0–P4）；m80 simple bridge 断言更新为「required 2 项 + optional alignment-check」；flywheel report 测试覆盖 deviation 聚合与 goal 统计；全套 **92 文件 / 455 tests** 通过

## [1.7.15] - 2026-07-28

### Added

- **检索 golden set 回归测试**：`tests/retrieval-golden.test.ts` 固定 26 条代表性查询（orchestrator / context / skill flywheel / planner 等），断言关键源文件召得回且命中率 ≥ 80%，检索质量从此有回归护栏
- **词干匹配**：`rankNodesForContextQuery` 对 ≥ 6 字符的查询 token 做前缀词干匹配（如 `routing` 命中 `route`），修复 "orchestrate task routing" 类查询召不回 orchestrator 的盲区
- **PageRank LRU 缓存**：`computePageRank` 以全图指纹（节点 + 边 + 参数）为键缓存结果（上限 8 条），重复上下文打包零重算；导出 `pageRankCacheStats` / `resetPageRankCache`
- **HNSW 向量索引持久化**：`getSharedVectorIndex(nodes, persistPath?)` 进程内 memo + 磁盘恢复（Float32 base64，上限 20k 向量）；`OrchestrateOptions.hnswIndexPath` / `embeddingPolicy.vectorStorePath` 派生 `.hnsw` 路径，跨进程复用向量召回索引
- **`transport: "auto"`**：图存储自动选择——sqlite 优先（FTS5 检索、避免大仓库全文件读写放大），better-sqlite3 不可用时透明降级 JSON 文件存储；`graphflow.config.example.json` 默认改为 auto
- **Skill A/B 基准**：`benchmarks/run-skill-ab-benchmark.ts`（`npm run benchmark:skills`）离线确定性度量 skill 飞轮价值——hint 注入率、episode 召回率、Jaccard 相关性代理、token 开销（实测注入 100% / 召回 100% / 25.6 tok 每任务）
- **技能包团队共享**：`graphflow skill sync export|import [--path]` 双向同步技能包到可进 git 的 JSON 文件（默认 `.graphflow/skills/team-skills.json`），幂等再导入
- **飞轮贡献报告**：`graphflow skill report` / `graphflow_diagnose` 新增 flywheel 字段——skills 正/中/负分分布、topUsed、episodes pass/fail/pending/withLessons、insight decisions 计数
- **ATP IR 公开规范**：`docs/atp-ir-spec-v1.md` 定义 `atp-ir/1.0`——角色、AgentWorkItem/TaskNode 载荷 schema、full ATP vs simple-plan bridge ID 注册表、submit/merge 契约、兼容性规则
- **测试基建**：`tests/helpers/no-llm-config.ts` 隔离配置工厂（providers 空 + budget/learning/embedding/graph policy 完整，防 `loadConfigSafe` 静默回退默认配置）；`tests/helpers/setup.ts` 注册进 vitest setupFiles，测试默认 2s provider/embedding 超时

### Changed

- **README 重写**：新定位「编码 Agent 的上下文与记忆层」，修复旧版中文乱码（0x3F 损坏）；30 秒上手、能力矩阵、10 MCP 工具表、CLI 速查、基准与 ATP 规范链接
- **Bridge 模式省一次 LLM 调用**：orchestrate 在 bridge（agent-delegated）模式下跳过 `plannerDraft` 的纯装饰性 LLM 调用（其结果仅用于 feedback 字符串，无下游引用）
- **引用边构建优化**：`file-indexer-edges` 改用 `matchAll` 流式扫描避免大中间数组，symbolIndex 为空时早退
- **测试环境隔离**：m7/m9/m10/m14/m16/m44/m48/m-bridge-cli-loop 全部改用显式隔离 configPath，本机 ambient 配置（真实 API key）不再把单测变成 30–60s 网络调用

### Fixed

- **sqlite FTS camelCase 盲区**：FTS5 不拆 camelCase，而查询侧经 `tokenizeForIndex` 拆成子词，后缀子词永远匹配不上；schema 升级 v2（`searchtext` 列 = 原文 + 拆分子词，含 ALTER/backfill/重建 FTS/trigger 迁移）
- **m16 环境敏感断言**：agent 集成测试改用 mkdtemp 临时 config，`agent-delegated` 断言在任意本机环境下确定性通过
- **m48 文档一致性**：README 版本徽章回归，与 package.json 单一事实源对齐
- **lint**：`client-factory` auto 降级分支未使用变量、golden set 测试冗余 eslint-disable

## [1.7.14] - 2026-07-28

### Fixed

- **CI / m16**：无 LLM 时 `graphflow_plan` 返回 `mode=agent-delegated`，更新集成测试断言（修复 v1.7.13 构建失败）

## [1.7.13] - 2026-07-28

### Changed

- **`graphflow_plan` 无 LLM 也 Bridge**：默认 simple 模式在未配置 GraphFlow LLM 时返回 `mode=agent-delegated`，下发 `simple-plan-intent` + `simple-plan-decomposition` work items，由连接的 coding agent 理解任务并拆 DAG；本地启发式结果以 `suggestedNodes`（`nodesStatus=suggested`）附带，不作终稿
- **merge 协议**：识别 simple-plan work item ID，两步 submit 后即可 merge 出最终 plan（不与 insight 全量帽子协议混淆）

## [1.7.12] - 2026-07-28

### Fixed

- **`graphflow_plan` 误拆分析维度**：冒号后的评价维度列表（如 assumptions、failure modes、validation gates）不再被 `,`/`、`/`，` 拆成独立并行任务节点；仅当各子句都像可执行任务时才弱分隔
- **brainstormer** 共用同一 `splitTaskClauses`，避免目标澄清变成名词碎片

## [1.7.11] - 2026-07-27

### Changed

- **Settings 工具页**：同步展示 v1.7.11 本版亮点（MCP home-cwd 修复、install/doctor JSON 自检、Bridge 飞轮、无需 LLM 能力）
- **扩展 README / marketplace description**：对齐最新版本与 FAQ

## [1.7.10] - 2026-07-27

### Fixed

- **MCP home-cwd discovery**：安装后 Cursor 常以 `cwd=/home/<user>` 启动 MCP；discovery 不再通过 IDE hint 把 home 当作工作区（修复 `Refusing to use unsafe workspace root from discovery: /home/...`）
- **读取 `WORKSPACE_FOLDER_PATHS`**：优先使用 Cursor 注入的工作区路径；忽略未展开的 `${workspaceFolder}` 占位符
- **npx MCP 安装**：写入 `GRAPHFLOW_WORKSPACE_ROOT=${workspaceFolder}`，由 Cursor/VS Code 插值到真实项目根

## [1.7.9] - 2026-07-22

### Added

- **Open VSX 自动发布**：`Build` workflow 在 `package-windows` 成功后幂等推送到 Open VSX（密钥 `open_vsx_token`，namespace `roarpeng`，与扩展 publisher 一致）
- **Opencode agent 支持**：自动检测 `~/.config/opencode/` 并安装 MCP（`mcp` 键/数组 `command`/`enabled`/`type: "local"` 格式）、Skill（`~/.config/opencode/skills/`）和 AGENTS.md 指令；workspace 级 MCP 注入支持 opencode 格式
- **embedding 超时**：`pipelines()` 模型下载 60s 超时（`GRAPHFLOW_EMBEDDING_TIMEOUT_MS`），超时自动降级 hash
- **HF 镜像**：`HF_ENDPOINT` / `GRAPHFLOW_HF_ENDPOINT` 环境变量配置 HuggingFace 镜像（如 hf-mirror.com）
- **fallback 标注**：`ResilientLocalEmbeddingProvider.getFallbackReason()`，diagnose 输出当前 backend 和降级原因
- **全面健康检查**：`graphflow_diagnose` 增加 workspaceRoot 解析、graphFreshness、modelCache、connectivitySummary
- **技能衰减**：`maybeDecaySkills`（七天内无活动分数向 0 衰减 ±1）、`resetSkillScore`、`pruneLowSkills`；CLI `skill decay/reset/prune`
- **Episode 隐私**：`forgetEpisodes()` + `learn forget`；artifact export 默认排除 episode（`--include-episodes` 可还原）
- **CI 矩阵**：`validate.yml` Node 20/22 矩阵 + `validate-platforms` job（win/mac Node 22）
- **Surface sync 脚本**：`scripts/sync-surfaces.cjs` + `--check` 模式 + `npm run sync:surfaces`
- **WASM 版本标记**：`wasm/.grammar-version` 版本校验，升级时强制重建

### Changed

- **迁移到 `@huggingface/transformers` v3**：`loadTransformersModule` 优先使用已在 `dependencies` 中的 v3，`@xenova/transformers` 保留为 legacy fallback
- **`pino-pretty` 移到 devDependencies**：减小生产安装体积
- **README 测试数**：59→72 文件、280+→357+ tests（脚本化生成，避免再次漂移）

### Fixed

- **macOS CI**：`m49-workspace-root-isolation` 测试通过 `realpathSync` 解析 `/var` → `/private/var` 符号链接
- **package-lock.json 同步**：与 `package.json` 依赖版本对齐
- **CI tsc 构建**：`@huggingface/transformers` 直接可解析，无需额外安装

## [1.7.8] - 2026-07-19

### Added

- **Dart / Flutter 索引器**：新增 `.dart` tree-sitter 索引器（class/mixin/extension/enum/typedef/function/import）；忽略 `.dart_tool`；`tree-sitter-wasms` 升至 0.1.13，`web-tree-sitter` 升至 0.25.10（支持 Dart ABI 15）

## [1.7.7] - 2026-07-19

### Added

- **npm 幂等发布**：`scripts/publish-npm-idempotent.mjs`，已发布版本不再因 E403 失败
- **技能飞轮卫生**：全 stopword 短语过滤、`pruneFailedSkills` 软隐藏毒技能、`reportOutcome` lessons 质量门
- **架构检索加权**：架构/CJK 查询优先 orchestrator / MCP / README，压低 types/errors/panels
- **安装指令块**：统一为 10 工具面 + `graphflow_context` + CallMcpTool 契约

### Changed

- CI / publish workflows 升级 Node **22**
- Marketplace：无密钥时 dispatch 跳过警告；tag 推送无密钥则明确失败；日志使用 GraphFlow Tool / `graphflow-tool`

## [1.7.6] - 2026-07-19

### Changed

- **VS Code 扩展更名**：`graphflow-vscode` → `graphflow-tool`，规避 Marketplace displayName 冲突；VSIX 文件名同步改为 `graphflow-tool`
- **扩展 displayName**：更新为 `GraphFlow Tool`

## [1.7.5] - 2026-07-18

### Added

- **Qoder MCP / Skill 支持**：自动检测用户级 `~/.qoder/mcp.json`（Windows `%APPDATA%/Qoder/User/mcp.json`）与项目级 `.qoder/mcp.json`；Skill 安装至 `~/.qoder/skills/graphflow/SKILL.md`
- **Agent Profile 模块化**：新建 `src/integrations/agent-profiles/` 目录与注册机制，各 IDE/Agent profile 独立成文件维护
- **统一错误类型**：新增标准化错误类型与处理函数
- **增量索引取消机制**：`file-indexer` 支持 `AbortController` 取消
- **Skill 健康检查**：新增 Skill 完整性检测
- **previewContext LRU 缓存**：新增 `src/graph/context-cache.ts`
- **VS Code Marketplace 自动发布**：新增 `publish-marketplace.yml` workflow

### Changed

- **自动执行模式**：LLM 仅在已配置且健康时启用，否则自动回退 bridge mode（`src/core/orchestrator.ts`）
- **安装体验优化**：无项目打开时由报错改为友好提示并提供打开文件夹按钮；npm 与插件安装后的项目引导提示统一

## [1.7.4] - 2026-07-13

### Added

- **DeepSeek 一等 provider**：`ProviderName` 新增 `deepseek`；默认模型 `deepseek-v4-pro` / `deepseek-v4-flash`；Settings 可选 deepseek
- **配置→env 桥接**：`resolveConfig` 将 `providers.*.apiKey/baseUrl` 注入 `DEEPSEEK_*` / `OPENAI_*` 等（不覆盖已有环境变量）
- **DeepSeek 能力**：思考模式（thinking + reasoning_effort）、JSON Output、`reasoning_content` 解析、KV cache usage 记录、可选只读 graph tool_calls

### Fixed

- **LLM 配置无法联通**：此前适配器只读环境变量，忽略配置文件中的 apiKey/baseUrl

## [1.7.3] - 2026-07-12

### Fixed

- **无痛 Windows MCP**：扩展激活时调用 `repairUnsafeWindowsMcpCommands`，自动扫描 Trae / Trae CN / TRAE SOLO 等已有 `mcp.json`，把含空格的 `command` 就地改成短路径或 `node`（无需手动 Install）
- **CI Test 挂死**：禁用 vitest/CI 下 embedding 后台预热（HuggingFace MiniLM 下载无超时可卡 30m+）；`validate.yml` 设置 `GRAPHFLOW_SKIP_EMBEDDING_WARMUP=1`

## [1.7.2] - 2026-07-12

### Fixed

- **Trae/Windows MCP install**：`buildMcpServerNode` / 写入配置时统一将含空格的 `command`（如 `C:\Program Files\nodejs\node.exe`）转为 8.3 短路径或回退 `node`，避免 Trae Solo 经 cmd 无引号启动时出现 `'C:\Program' 不是内部或外部命令`

## [1.7.1] - 2026-07-12

### Added

- **Resilient local embedding**：`@xenova/transformers` 缺失或加载失败时自动降级到 `fnv1a-384` hash；支持从 workspace `node_modules` 解析
- **可选全图向量召回**：`embeddingPolicy.enableFullGraphVectorRecall`（默认 `false`），开启后对带 embedding 的图节点做 HNSW + RRF
- **P2 transformers 离线缓存路径**：`embeddingPolicy.modelCacheDir` / `transformersCachePath` 或 `GRAPHFLOW_EMBEDDING_CACHE_DIR`
- **测试**：`m77-embedding-fallback`、`m78-full-graph-vector-recall`

### Changed

- **检索降噪**：架构查询提升 `src/graph`/`src/core` 等，降低 `vscode-extension`/`vendor`/`node_modules`/非 src `dist` 权重
- **Adaptive budget 日志**：`logger.info` → `logger.debug`，避免 MCP stderr 被 IDE 标成伪 error
- **Installer surface 冻结**：当前 IDE/Agent 安装目标保持维护，不再继续扩展新的 IDE 自动安装面
- **VSIX / 扩展说明**：`graphflow-vscode@1.7.1` 描述与 README 同步上述行为
- **Windows MCP launcher**：优先 spawn `.cjs`，避免 `.cmd` + `shell:false` 的 EINVAL

### Notes (VSIX)

- VSIX **仍不**捆绑 `@xenova/transformers`（体积与平台原生依赖）
- 默认 hash embedding 可用；真语义请预置缓存目录

## [1.7.0] - 2026-07-11

### Added

- **P0 向量召回修正**：引入 `@xenova/transformers` + `all-MiniLM-L6-v2`（384 维，约 22MB），实现真正的本地语义 embedding 召回
- **P2 ATP 自适应截断**：简单任务（低优先级、无约束、短描述）自动 short-circuit，跳过 First Principles / Decision Matrix / Reflection，节省 4-6 次 LLM 调用
- **P2 MCP 工具精简**：18 个工具合并为 10 个核心工具，降低 LLM 工具调用认知负荷

### Changed

- **embedding provider 默认改为 `transformers`**：替代原有的 FNV-1a hash embedding（伪语义）
- **MCP 工具合并**：
  - `graphflow_context` = `preview_context` + `expand_anchor`
  - `graphflow_plan` = `plan` + `plan_insight`（mode 参数区分）
  - `graphflow_index` = `index` + `index_file` + `rebuild`
  - `graphflow_insight` = `submit_insight` + `merge_insight`
  - `graphflow_diagnose` = `diagnose` + `inspect_graph` + `stats`
  - `graphflow_artifact` = `export_artifact` + `import_artifact`

### Removed

- **P1 移除 `hnswlib-node`**：彻底移除 C++ 编译依赖，向量召回统一使用纯线性扫描
- 移除 `graphPolicy.enableHnsw` 配置项及相关代码
- 移除 `hash` embedding provider 及相关函数

## [1.4.4] - 2026-07-05

### Added

- **Antigravity IDE 安装**：MCP 写入 `~/.gemini/antigravity/mcp_config.json`；全局 Skill、项目 `.agent/rules` / `.agent/skills`；项目 `GEMINI.md` 受管块
- **Gemini CLI**：共享 MCP 路径 `~/.gemini/config/mcp_config.json`
- **GitHub Copilot**：专用 `.github/copilot-instructions.md` 源文件（token-first，非 CLAUDE.md 副本）
- **Trae CN 项目安装**：`.trae/rules/graphflow.md`（alwaysApply）与项目 Skill；doctor 自检
- **测试**：`m62-trae-cn-install`、`m63-agents-install`

### Fixed

- **Antigravity MCP 路径错误**：不再写入 VS Code `Code/User/mcp.json`
- **用户级 MCP 污染**：`install` 不再向用户配置注入 `GRAPHFLOW_WORKSPACE_ROOT`；切换策略时自动清除 stale env

## [1.4.3] - 2026-07-05

### Added

- **PascalCase/camelCase 拆词**：`BattlePage` → `battle` + `page`，`EnergyShield` → `shield` 等，英文子词可命中代码符号
- **合并 englishQuery 重排**：RRF 子查询使用中文 + englishQuery + 子查询共同打分
- **UI 路径加权**：含 avatar/shield/battle/camera 等 UI 意图时优先 `src/pages/`、`src/components/`

### Fixed

- **TOKEN_SPLIT**：不再把大写字母误当分隔符（修复 `oldFunctionName` 等标识符被错误切碎）
- **SQLite FTS**：ASCII 单词前缀匹配（`battle*` → `BattlePage`），多词短语仍用 AND

### Changed

- **Agent 翻译提示 / Skill**：优先精确文件/类/组件名，避免泛化 `exercise` 误命中数据层

## [1.4.2] - 2026-07-05

### Added

- **CJK 查询支持**：中文/日文/韩文分词与双字切分；FTS 对 CJK 查询使用 OR 匹配
- **Agent 委托翻译**：`graphflow_preview_context` 新增 `englishQuery`；当 CJK 查询锚点不足时返回 `agentWorkItems`（`query-translate-en`），由连接的 Agent 翻译为英文符号关键词后重试
- **多查询 RRF**：`expandSearchQueries` 合并原始查询、Agent 英文翻译与工作区路径提示进行检索
- **索引增强**：Symbol 节点 content 附加 JSDoc 摘要（≤160 字符），提升中文意图对英文符号的命中

### Fixed

- **自动索引**：`preview_context` 在图存储为空时即使 workspace 缓存已 warm 也会触发索引

## [1.4.1] - 2026-07-05

### Fixed

- **CI Windows 构建**：`package-windows` 固定 `windows-2022`，修复 `windows-latest`（VS 2026）上 node-gyp 无法识别 VS 18 导致 `hnswlib-node` 编译失败
- **validate**：Linux CI 增加 `npm rebuild hnswlib-node`，确保 HNSW 原生模块在测试前就绪
- **文档一致性**：同步 MCP 工具列表（移除 v1.4 已删除的 `enrich_graph` / `model_download` / `metrics`；补充 `submit_insight` / `merge_insight` / `skill_guide`）

### Changed

- **README / 扩展 README**：补充 VSIX 安装步骤（VS Code / Cursor）、MCP `install` 命令、`hnswlib-node` 原生编译环境说明

## [1.4.0] - 2026-07-04

### Changed

- **奥卡姆剃刀精简**：移除未产生真实价值的模块，保留三条经过验证的闭环链路。
  - 移除 OpenBMB 本地部署（`provider-adapters/openbmb.ts`）
  - 移除语义压缩模型（`compression-model.ts`、`semantic-compression.ts`）
  - 移除语义增强器（`semantic-enricher.ts`）
  - 移除技能进化（`skill-evolution.ts`）
  - 移除金丝雀门控（`canary-gate.ts`）
  - 移除本地嵌入模型（`local-embedding.ts`，改为零成本 hash embedding）
  - 移除向量存储（`vector-store.ts`，HNSW 直接内嵌）
  - 移除 `@xenova/transformers` 和 `node-llama-cpp` 依赖
  - `hnswlib-node` 从 optionalDependencies 移到 dependencies
  - embedding 默认 provider 从 `"local"` 改为 `"hash"`

### Fixed

- **HNSW 向量召回完全打通**（P0）：`file-indexer` 现在为所有 File/Symbol/Module 节点附加 256 维 hash embedding（FNV-1a，零成本），HNSW 索引不再为空。
- **Orchestrator 向量召回激活**（P0）：`orchestrator-context.ts:maybeBuildNearLosslessContext` 现在传递 `embeddingProvider` + `enableVectorRecall` 到压缩管道，`graphflow_run` 路径的向量召回不再被跳过。
- **HNSW 索引持久化**（P1）：`buildEnhancedContextPackage` 现在从 `vectorStorePath` 派生 `.hnsw` 路径并传入 `HnswVectorIndex`，`save()`/`loadIndex()` 不再是空操作。
- **FileWatcher 接入 MCP 启动**（P0）：`startFileWatcherIfEnabled` 此前是死代码，现已接入 MCP 服务器启动路径，`autoIndexOnSave: true` 时自动监听文件变化并增量索引。
- **skillHints 解耦**（P1）：`buildPromptContext` 中 `skillHints` 不再依赖 `enableGraphContextInPrompt === true`，独立注入 worker prompt。
- **Dangling edges 修复**（P1）：`applySkillLearning` 现在先创建 Decision 节点再连 `improves` 边，不再产生指向不存在节点的悬空边。
- **buildPlanFromInsight null 安全**（P0）：`insight.ts` 异常时返回 `null` 而非 `[]`，orchestrator 正确检测并回退到 `planTasks`。

### Added

- **Agent MCP Installer 恢复并优化**：支持 15+ Agent 自动检测安装（Cursor、VS Code、Trae、Claude Code、Windsurf、Cline、Roo Code、Kilo Code、PearAI、Gemini、Codex、Antigravity、Amazon Q、Zed、Continue）；WSL 检测修复（`platform()` → `release()`）。
- **Reflector 恢复并优化**：`reflectOnEpisodes` 贪心聚类 + Lesson 提取；`getLessonsForEpisode` 提取到 `episodic-memory.ts`；Lesson 自动注入 planner prompt。
- **HNSW 恢复并优化**：`HnswVectorIndex` 支持持久化加载/保存；大仓库自动 ANN，小仓库线性扫描。
- **Kotlin / Swift 索引器**：新增 `.kt` 和 `.swift` tree-sitter 索引器。
- **hash embedding**：零成本 FNV-1a 256 维向量，无需模型推理，作为 embedding 默认 provider。

### Removed

- `src/graph/compression-model.ts`
- `src/graph/semantic-compression.ts`
- `src/graph/semantic-enricher.ts`
- `src/learning/canary-gate.ts`
- `src/learning/local-embedding.ts`
- `src/learning/skill-evolution.ts`
- `src/learning/vector-store.ts`
- `src/routing/provider-adapters/openbmb.ts`
- `src/types/node-llama-cpp.d.ts`
- 相关测试文件：m17、m17b、m17c、m20、m28、m29、m30、m31、m38、m47、m4m5

## [1.3.4] - 2026-07-03

### Fixed

- **MCP / Windows EPERM**：修复 MCP 在 `AppData\Local` 等系统目录启动时误将系统路径当作工作区并扫描 `ElevatedDiagnostics` 导致 `EPERM` 的问题。
  - 目录遍历对 `EPERM`/`EACCES` 静默跳过（`safe-fs`）
  - 忽略 `ElevatedDiagnostics` 等 Windows 受保护目录
  - `ensureMcpWorkspaceEnv` 不再将 `LOCALAPPDATA` 根目录当作隐式工作区；优先使用 IDE 环境变量（`VSCODE_CWD` 等）

## [1.3.3] - 2026-07-03

### Fixed

- **VS Code 扩展（WSL）**：激活时默认仅写入用户级 MCP（`~/.config/Code/User/mcp.json`），不再自动创建项目级 `.vscode/mcp.json` 与项目 Rules，避免 WSL 下 GUI 提交触发 git hook 时与 pyenv 环境冲突。项目级安装改为显式执行 **GraphFlow: Install MCP to Agents**。
- **MCP 启动**：仅在原生 Windows 传入 `electronExecPath`，Linux/WSL 不再写入 IDE 可执行路径。

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
