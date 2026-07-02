# GraphFlow 深度技术调研报告

## 执行摘要

GraphFlow（`@roarpeng/graphflow@1.3.1`）是一个基于 TypeScript/Node 的 **Local-first 代码知识图谱 + 跨会话学习记忆** 引擎。它通过 AST 多语言索引将代码仓库转化为可查询的图结构，在此基础上叠加三层渐进式上下文压缩、DAG 任务编排与规划、以及基于 Episodic/Skill/Decision 节点的学习飞轮，形成"图谱 + 压缩 + 规划 + 学习记忆"的完整闭环。项目通过 CLI、`--json` 输出、MCP stdio 协议和 VS Code 扩展四种方式对外暴露能力，支持在无 API key 的情况下纯离线运行结构索引与图压缩。

---

## 一、项目定位与核心价值主张

GraphFlow 的定位不是"某一项最强"，而是 **在代码图谱之上叠加了上下文压缩、规划编排与跨会话学习记忆**。赛道内其他工具各有单点优势：CodeGraph 在纯图谱成熟度上更领先，Serena 在 LSP 符号编辑上更专精，Repomix 在整库打包上更简单。GraphFlow 的差异化价值在于把"图谱 + 压缩 + 规划 + 学习记忆"合到一处，让 agent 不仅省 token，还能跨会话复用项目经验。

| 能力域 | 核心特征 |
|---|---|
| **结构代码图谱** | 多语言 AST 索引（TS/JS/Python/Rust/Go/C/C++/Java/Ruby/Kotlin/Swift），File/Module/Symbol 节点 + 依赖/引用/定义/调用/继承边 |
| **上下文压缩** | L1/L2/L3 分层锚点，图结构压缩（边权重 + PageRank，零成本默认），可选语义压缩（MiniCPM/economy LLM），向量召回 + RRF + HNSW |
| **规划编排** | DAG 拓扑执行，六顶思考帽 + 5-Why 深度分析，Bridge 模式输出结构化执行描述符 |
| **跨会话学习** | Episodic Memory、Reflection、三层技能体系（原子/复合/进化）、nightly 学习循环 |
| **对外接入** | CLI `--json`、MCP stdio（22 个工具）、VS Code 扩展 |

---

## 二、架构全景

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Surfaces (对外接口层)                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐  │
│  │  MCP Server │  │  CLI Index  │  │  VS Code Extension          │  │
│  │ (22 tools)  │  │ (20+ cmds)  │  │ (Settings / Panel / Graph)  │  │
│  └──────┬──────┘  └──────┬──────┘  └─────────────┬───────────────┘  │
│         └─────────────────┼───────────────────────┘                  │
│                           ▼                                          │
│              ┌────────────────────────┐                              │
│              │   CLI Runtime Facade   │                              │
│              └───────────┬────────────┘                              │
└──────────────────────────┼──────────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│   graph/xxx   │  │   core/xxx    │  │  routing/xxx  │
│ file-indexer  │  │ orchestrator  │  │ model-router  │
│ context-slicer│  │ dag-engine    │  │provider-health│
│ semantic-     │  │ agent-delegat.│  │provider-exec. │
│ enricher      │  │ planner etc.  │  │  adapters     │
└───────┬───────┘  └───────┬───────┘  └───────┬───────┘
        │                  │                  │
        ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      learning/ (学习飞轮)                            │
│  episodic-memory / skill-flywheel / reflector / nightly-trainer     │
│  skill-evolution / seed-skills / vector-store / hnsw-index          │
└─────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      config/ (配置系统)                              │
│  schema / loader / resolve / merge / workspace-root / defaults      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 三、图存储与索引系统

### 3.1 文件索引流水线

文件索引采用 **扫描 → 分批并行处理 → 顺序合并 → 全局边构建** 的四阶段流水线：

1. **扫描**：`file-indexer-walker.ts` 递归遍历工作区，按扩展名过滤，跳过 `node_modules`、`.git` 等目录，默认最大文件大小 200KB。
2. **分批并行处理**：`file-indexer.ts` 按 `concurrency`（默认 10）将文件分 batch，每 batch 内并行 `processFile`，但结果由外层 **顺序合并** 到共享数组，避免锁竞争。
3. **缓存校验**：基于 `mtimeMs` 快速筛选，再用 MD5 hash 确认内容变更；发现图快照为空但缓存非空时自动重置缓存。
4. **全局边构建**：构建 `symbolIndex: Map<string, IndexedSymbol[]>` 后，批量生成跨文件 `references`/`calls`/`inherits` 边。

**并行安全设计**：`processFile` 不修改任何共享状态，只返回本文件的局部 `FileProcessResult`，由调用方顺序合并。这种设计避免了复杂的锁机制。

### 3.2 节点与边模型

| 节点类型 | 说明 |
|---|---|
| `File` | 代码文件，ID 为 `file:${relPath}` |
| `Module` | 模块，按路径去扩展名归一化，ID 为 `module:${moduleKey(relPath)}` |
| `Symbol` | 符号（函数/类/接口等），ID 为 `symbol:${relPath}:${hashText(sym.name)}` |
| `Skill` | 技能节点（原子/复合/进化） |
| `Decision` | 决策节点（Six Hats / Plan-refinement 洞察） |
| `TaskRun` | DAG 执行检查点 |
| `Episode` | 情景记忆 |

| 边类型 | 说明 |
|---|---|
| `defines` | Symbol 属于 File |
| `imports` | File 导入 Module |
| `references` | File 中提及 Symbol（正则扫描标识符） |
| `calls` | Symbol 调用 Symbol |
| `inherits` | Symbol 继承 Symbol |
| `co_occurs` | 技能原子共现 |
| `prerequisite` | 技能前置依赖 |

### 3.3 存储后端抽象

`client-factory.ts` 定义统一 `GraphClient` 接口，采用 **Optional Capability Pattern**：

| 后端 | 类型 | 特点 |
|---|---|---|
| `memory` (默认) | `GraphifyClient` | 内存 Map，用于测试和默认场景 |
| `file` | `GraphifyFileClient` | JSON 文件持久化，写临时文件 + rename 原子替换，带 Windows EPERM 重试 |
| `sqlite` | `GraphifySqliteClient` | 生产级后端，FTS5 全文索引、WAL 模式、批量事务；失败时自动降级到 file |
| `mcp-http` | `GraphifyMcpClient` | JSON-RPC 2.0 远程通信 |

`GraphClient` 的后端能力均为可选（`readSnapshot?`、`deleteNode?` 等），上层在使用前做 `typeof` 检查，优雅降级。这让同一个接口能同时适配四种差异巨大的后端，而不需要复杂的适配器链。

### 3.4 上下文压缩分层

```
用户查询
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│ L0: 关键词检索 + 可选向量召回 → RRF 融合排名                      │
│     （零成本，不依赖 LLM）                                       │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│ L1: 图结构压缩（连通子图 + PageRank，零成本默认开启）              │
│     提取种子节点的连通子图，按边权重和 PageRank centrality 重排    │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│ L2: 语义压缩（聚类合并 + 摘要 densify，可选本地 MiniCPM）          │
│     基于 embedding 余弦相似度聚类，小型 LLM 生成统一摘要            │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│ L3: 自适应预算 + 边扩展                                          │
│     根据任务类型动态调整 token 预算，从 anchor 做 1-hop 邻居扩展   │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
LayeredContextPackage（分层配额打包输出）
```

### 3.5 语言索引器架构

| 语言 | 解析方式 | 提取内容 |
|---|---|---|
| TypeScript | `typescript` 编译器 API（动态 require） | function/class/interface/type/enum/variable、import/export、call expression、heritage clause |
| Python | Tree-sitter WASM | class/function/method、import/import_from、call、继承 |
| Go / Rust / C / C++ / Java / Ruby / Kotlin / Swift | Tree-sitter WASM | AST 遍历统一提取符号和边 |

TypeScript 走官方 TS 编译器 API 实现深度集成，其他语言统一走 Tree-sitter WASM 运行时，避免原生依赖。WASM 语法包随 npm 包离线分发，无需网络下载。

---

## 四、编排器与任务执行引擎

### 4.1 编排器生命周期

`orchestrator.ts` 中的 `orchestrate()` 函数协调完整的编排生命周期：

```
orchestrate(input, options)
  │
  ├─► 种子技能预置（幂等写入，避免冷启动）
  ├─► 构建近无损上下文包（L1/L2/L3 + 图压缩）
  ├─► 解析模型路由决策（planner/worker/validator 的 provider/model）
  ├─► 从技能飞轮召回高相关技能提示
  ├─► 语义检索历史 episode（Jaccard + Embedding + RRF）
  ├─► 拼接 PromptContext（summaryChannel + skillHints + episodes）
  │
  ├─► 任务分类（triage）：simple / complex
  │     基于启发式关键词 + 文本长度，或 LLM-based 双路径
  │
  ├─► [simple 分支]
  │     └─► 状态机闭环：worker → validator → 反馈重试（最多 maxRetries 轮）
  │
  └─► [complex 分支]
        ├─► 深度规划：Six Hats + Five Whys（有 LLM 时）
        │     或 Agent 委托洞察（无 API key 时，生成 agentWorkItems）
        ├─► DAG 计划生成：TaskNode[] 拓扑图
        │
        ├─► [bridge 模式 — 默认]
        │     └─► 组装 executionDescriptor 交给外部 coding agent
        │         (action, task, context, agentAssignments, agentWorkItems)
        │
        └─► [llm 执行模式]
              └─► DAG 拓扑排序 → 并发批执行 → checkpoint 持久化
                  └─► [drift replan 可选] 失败时注入反馈重新规划
```

### 4.2 Bridge 模式与双轨执行

GraphFlow 的默认执行模式是 **Bridge 模式**：`graphflow_run` 规划 + 压缩上下文后输出 `executionDescriptor`，交给 Cursor / Claude Code 等外部 agent 执行，不再伪造 `COMPLETED`。

**无 API key 时的降级路径**：
- `planInsightResult` 不直接报错，而是返回 `agentWorkItems`（Six Hats + Five Whys 结构化问题）
- 外部 coding agent 用自己的模型回答
- 通过 `submit_insight` / `merge_insight` 闭环，将回答写入 Decision 节点
- 最终生成完整洞察与 DAG 计划

这是典型的 **Human-in-the-loop / Agent-in-the-loop** 架构，让 GraphFlow 在没有云端 LLM 的情况下仍能提供有价值的规划辅助。

### 4.3 DAG 执行引擎

`dag-engine.ts` 实现了完整的 DAG 执行能力：

- **拓扑排序**：Kahn 算法，按依赖顺序执行
- **并发批处理**：无依赖的节点并发执行
- **超时控制**：`Promise.race` 任务 Promise 与 timeout Promise，并在 `finally` 中 `clearTimeout` 防止 timer 泄漏
- **Checkpoint 恢复**：`dag-checkpoint.ts` 以 `dag:${taskHash}` 为键，将节点完成状态持久化为 `TaskRun` GraphNode，进程崩溃后可恢复已完成的节点
- **失败传播**：失败节点的下游节点自动标记为 `blocked`

### 4.4 错误体系

`errors.ts` 定义了统一错误体系：`GraphFlowError` 基类带 `code`/`recovery` 字段，子类覆盖索引、模型、规划、执行、路由、验证等域，为上层提供结构化的错误处理依据。

---

## 五、学习飞轮与技能系统

### 5.1 三层技能体系

| 层级 | 生成方式 | 存储形态 | 进化机制 |
|---|---|---|---|
| **原子技能** | 从任务文本提取（中英文分词 + stopword 过滤） | `SkillState` | score ±1 更新 |
| **复合技能** | 两个原子技能共现且成功次数达标 | `CompositeSkillState` | `coOccur/success/failure` 计数 |
| **进化技能** | MiniCPM-1B 对复合技能做跨领域融会贯通 | `EvolutionarySkillNode` | `canaryStatus`: probation → verified/demoted |

**复合技能门控**：`compositeGateMet` 要求共现次数 ≥2、成功次数 ≥2、成功 > 失败，才触发 LLM 进化。

**Canary 验证**：进化技能进入 probation 后需 ≥3 次使用，按 50% 通过率判定是否转正（verified）或降级（demoted 分数设为 -10）。这是 **A/B 验证式技能进化**。

### 5.2 学习飞轮数据闭环

```
执行阶段
  │
  ▼
TaskRunResult (COMPLETED/FAILED/DELEGATED)
  │
  ├─► 技能原子提取 → 原子技能 score 更新
  ├─► 复合技能共现/成功/失败计数更新
  ├─► 若门控达标 → LLM 进化高阶技能（probation）
  └─► 写入 GraphNode (Skill) + Edge (co_occurs/prerequisite)
       │
       ▼
feedback-collector → learning-events.jsonl
       │
       ▼
nightly-trainer（定期运行）
  ├─► 计算 passRate / avgTokenCost
  ├─► canary 门控判定新策略是否上线
  ├─► 导出 ranking 学习数据集
  └─► reflectOnEpisodes → 聚类 → 提取 LessonRecord → 写入 Decision 节点
       │
       ▼
episodic-memory
  ├─► recordEpisode → Decision 节点（embedding 可选）
  ├─► updateEpisodeOutcome → bridge 模式下外部 agent 回填结果
  └─► findSimilarEpisodes → Jaccard + Embedding + RRF 召回历史经验
```

### 5.3 优雅降级原则

所有外部依赖（embedding provider、checkpoint、graph sync、triage telemetry、plan insight）失败时均静默 swallow，不抛异常，不阻断主编排流程：

- HNSW 索引未安装时自动回退线性扫描
- 本地 embedding 失败时回退 `hashEmbedding`（FNV-1a 哈希映射为 256 维稀疏向量并 L2 归一化，零成本）
- 语义压缩模型不可用时返回原内容

### 5.4 Triage 决策数据闭环

`triage.ts` 不仅分类任务为 simple/complex，还记录分类原因（命中关键词、文本长度、触发来源）。`triage-telemetry.ts` 将其持久化并在任务完成后回填实际步数、是否 drift replan、最终状态，形成 **可度量的决策-结果对**，用于后续优化启发式规则。

---

## 六、MCP/CLI 与对外接口

### 6.1 MCP 工具（22 个）

| 类别 | 工具名 | 功能 |
|---|---|---|
| **Core** | `graphflow_preview_context` | 近无损上下文压缩，返回锚点、token 预算、节省率 |
| | `graphflow_expand_anchor` | 锚点展开为完整 GraphNode 内容 |
| | `graphflow_plan` | 启发式 DAG 任务计划 |
| | `graphflow_plan_insight` | 六顶思考帽 + 5-Why 深度规划 |
| | `graphflow_run` | 编排任务，默认 Bridge 模式 |
| | `graphflow_report_outcome` | Bridge 模式闭环上报 |
| | `graphflow_index` / `graphflow_index_file` | 增量索引 |
| **Advanced** | `graphflow_submit_insight` / `graphflow_merge_insight` | Agent 委托洞察提交与合并 |
| | `graphflow_skill_insights` / `graphflow_skill_guide` | 技能洞察与指南 |
| | `graphflow_enrich_graph` | 语义富化 |
| **Maintenance** | `graphflow_diagnose` / `graphflow_inspect_graph` | 诊断与图检查 |
| | `graphflow_rebuild` | 全量重建 |
| | `graphflow_export_artifact` / `graphflow_import_artifact` | 图谱压缩包导入导出 |
| | `graphflow_stats` / `graphflow_metrics` | Token 节省统计与 Prometheus 指标 |

### 6.2 CLI 命令结构

CLI 入口 `cli/index.ts` 通过 `executeCommand` 分派 20+ 命令，覆盖 `install`/`doctor`/`uninstall`、`config init`/`validate`、`run`/`plan`/`plan insight`、`context preview`、`graph index`/`file`/`rebuild`/`inspect`/`enrich`、`artifact export`/`import`、`stats`/`metrics`、`skill insights`/`export`/`import`、`route diagnose`、`learn nightly` 等。所有命令均支持 `--json` 输出和 `--config <path>` 指定配置。

### 6.3 Agent MCP 安装器

`integrations/agent-mcp-installer.ts` 支持自动检测并安装到 11 种 Agent：Cursor、VS Code、Trae（含 CN/AICC）、Claude Code、Windsurf、Cline、Roo Code、Gemini CLI、Codex、Zed、Continue。

安装策略三选一：`npx`（默认）、`npm-script`（本地仓库）、`node-bundled`（系统 Node 或 Electron）。Windows 下额外处理 `npx.cmd` 与 `npx-cli.js` 路径。`resolveMcpNodeLaunch()` 优先使用系统 Node（排除 IDE 内嵌 Node、fnm 临时路径），回退到 Electron。

---

## 七、模型路由与配置系统

### 7.1 模型路由策略

| Tier | 角色 | 默认模型 |
|---|---|---|
| **Smart** | planner, validator | gpt-4.1 / claude-3-5-sonnet / qwen-max / doubao-pro-32k |
| **Economy** | worker, enricher, evolver, compressor | gpt-4.1-mini / claude-3-5-haiku / qwen-plus / doubao-lite-32k / minicpm5-1b |

**动态路由**：`routingPolicy.enableDynamicRouting`（默认 true），`buildProviderHealthMap()` 依据配置存在性、连续失败次数（<3）、API Key 可解析性判定健康状态。Fallback 链默认 `openai → anthropic → bailian → doubao → openbmb`。

**熔断与限流**：连续失败 5 次后熔断 60 秒；非 OpenBMB Provider 使用 Token Bucket（容量 60，每秒填充 1）；默认超时 15 秒。

### 7.2 配置系统分层

| 层级 | 文件路径 | 作用 |
|---|---|---|
| Global | `~/.graphflow.config.json` | 机器级默认，**不允许持久化 workspaceRoot** |
| Project Root | `<workspace>/graphflow.config.json` | 项目级主配置 |
| Project Overlay | `<workspace>/.graphflow/config.json` | 项目级附加层 |

`resolveConfig()` 的合并逻辑：Global → Project Root → Overlay，逐层 `mergeGraphFlowConfig()`。`workspaceRoot` 解析优先级：显式参数 → `GRAPHFLOW_WORKSPACE_ROOT` 环境变量 → 配置值 → 向上查找 `.git` / `graphflow.config.json` → `process.cwd()`。

---

## 八、关键设计决策总结

| 决策点 | 设计选择 | 原因/权衡 |
|---|---|---|
| **并行索引策略** | 分 batch 并行（concurrency=10），结果顺序合并 | 避免共享数组锁竞争；IO-bound 场景下并行读取收益大 |
| **存储抽象** | `GraphClient` 统一接口，能力 optional | 不同后端能力差异大，上层优雅降级 |
| **压缩分层** | 图结构压缩（零 LLM）→ 语义压缩（本地小模型）→ 自适应预算 | 成本递增、精度递增；任一环节失败均可降级 |
| **Bridge 模式** | 默认输出 executionDescriptor 给外部 agent | 诚实执行语义，不伪造 COMPLETED；支持无 API key 场景 |
| **双轨解析** | TypeScript 用官方 TS 编译器 API；其他语言用 Tree-sitter WASM | TS 生态深度集成；其他语言统一 WASM 运行时 |
| **引用检测** | 正则 `\b\w{3,}\b` 扫描 + skip list | 实现简单、语言无关、速度快；牺牲一定精度 |
| **Checkpoint 机制** | 以 `dag:${taskHash}` 为键持久化节点状态 | 进程崩溃后可恢复，避免重复执行与重复计费 |
| **Canary 验证** | 进化技能 probation ≥3 次后按 50% 阈值升/降级 | A/B 验证式技能进化，防止低质量技能过早上线 |

---

## 九、独特设计亮点

1. **Optional Capability Pattern**：`GraphClient` 的后端能力均为可选，让同一个接口能同时适配内存、文件、SQLite、MCP 四种差异巨大的后端。

2. **Windows 文件锁重试**：`graphify-file-client.ts` 在 Windows 上遇到 `EPERM` 时，用 `Atomics.wait` 做 50ms 重试（最多 5 次），是跨平台原子写入的巧妙处理。

3. **Agent 委托的"人机共生"设计**：无 API key 时不直接报错，而是生成结构化 `AgentWorkItem[]` 让外部 coding agent 像填空一样回答，形成 Agent-in-the-loop 闭环。

4. **HNSW 懒加载与透明回退**：`hnsw-index.ts` 在首次 `search` 时才构建索引，且加载失败时自动降级为暴力扫描，对上层完全透明。

5. **本地 Embedding 的预热机制**：`local-embedding.ts` 通过 `warmup()` 用 dummy 文本触发首次推理，消除真实请求时的模型加载延迟。

6. **零成本 Hash Embedding**：`embeddings.ts` 的 `hashEmbedding` 使用 FNV-1a 哈希将文本映射为 256 维稀疏向量并 L2 归一化，无需任何外部模型。

7. **Bridge 模式下学习闭环的特殊处理**：`orchestrator-episode.ts` 对 `status === "DELEGATED"` 的任务跳过技能打分，防止外部 agent 尚未报告结果时就把任务记为失败。

8. **种子技能的"有基础但不过度"**：种子原子技能 score 设为 2（满分 20）、uses 设为 0，复合技能的共现/成功计数保持 0，既提供冷启动提示，又不被误判为已验证。

---

## 十、潜在问题与改进空间

### 10.1 性能相关

1. **引用边构建的 O(N×M) 复杂度**：`buildBatchReferenceEdges` 对每个文件内容用正则提取所有标识符，再对每个标识符查全局 symbolIndex。若项目极大（百万级标识符），内存和 CPU 开销显著。建议引入布隆过滤器或 Trie 树先快速排除不可能命中的标识符。

2. **GraphifyFileClient 的读写放大**：每次 `upsertNodes` 都全量读写 JSON 文件，且 `queryByKeyword` 每次都重建倒排索引。大项目下性能差。建议增加内存缓存层，或序列化时一并持久化倒排索引。

3. **PageRank 重复计算**：`computePageRank` 每次调用都遍历全图边，若图很大且频繁查询，重复计算浪费。建议对 PageRank 结果做 LRU 缓存。

### 10.2 正确性相关

4. **符号哈希冲突风险**：`symbol:${relPath}:${hashText(sym.name)}` 使用 name 的 hash 作为 nodeId。同一文件内同名符号（如重载函数）会冲突。建议 nodeId 加入行号或签名。

5. **`hasPendingGraphIndexWork` 仅比较 mtime**：未比较 hash，若文件 mtime 被 touch 但内容未变，会触发不必要的重索引。建议增加内容 hash 校验。

6. **MCP 客户端无超时控制**：`GraphifyMcpClient` 使用原生 `fetch`，无超时、无重试、无连接复用。建议增加 `AbortSignal` 超时和指数退避重试。

### 10.3 工程相关

7. **Tree-sitter WASM 查找的硬编码路径**：`resolveBundledWasmPath` 中使用多层 `../../../wasm` 相对路径，对源码布局敏感。建议通过 `import.meta.url` 或 `__dirname` 计算更鲁棒。

8. **语言索引器的 fallback 正则过于简陋**：TypeScript 的 `fallbackExtract` 只按行匹配 `export` / `function`，丢失大量符号信息。建议 fallback 至少保留更通用的多语言正则。

---

## 十一、结论

GraphFlow 是一个架构清晰、设计深思熟虑的项目。它成功地将代码知识图谱、上下文压缩、任务编排和跨会话学习记忆四个能力域整合到一套 Local-first 的 TypeScript 运行时中。其核心优势在于：

- **分层压缩策略**（结构 → 向量 → 语义）提供了成本与精度的优雅权衡
- **Bridge 模式 + Agent 委托** 使其在无 API key 场景下仍能提供价值
- **学习飞轮**（Episodic → Skill → Evolution）形成了真正的跨会话记忆闭环
- **Optional Capability Pattern** 的存储抽象让多后端适配极为简洁

项目当前处于 v1.3.1，拥有 62 个测试文件、280+ 测试用例，工程成熟度较高。主要改进方向应聚焦于大规模项目的性能优化（引用边构建、文件存储读写放大）和边缘场景的正确性（符号冲突、超时控制）。
