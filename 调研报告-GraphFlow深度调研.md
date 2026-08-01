# GraphFlow 深度调研报告（综合版 v1.3.1 → v1.9.4）

> 综合日期：2026-08-01 ｜ 覆盖版本：`@roarpeng/graphflow@1.3.1` → `1.9.4` ｜ 前身报告：深度技术调研（v1.3.1，2026-07-03）+ 深度调研（v1.7.14，2026-07-28），本报告为两者深度综合
> 本报告基于对源码实际阅读、CHANGELOG（v0.x → v1.9.4）、基准测试结果与本地运行验证（652 个测试全绿）。

---

## 一、执行摘要

GraphFlow 是一个 **Local-first 的代码上下文引擎 + 跨会话学习记忆层**，以 TypeScript/Node 实现，通过 CLI、MCP stdio（10 个工具）和 VS Code 扩展三种形态对外服务。它把自己定位为"Context-Aware Multi-Agent Orchestration Engine"，但从实际架构看，**它的真实形态已经收敛为：宿主编码 Agent（Cursor / Claude Code 等）的"外挂记忆与上下文服务"**——规划与执行通过 Bridge 模式委托给宿主 Agent 完成，GraphFlow 自己不持有 LLM 也能完整闭环。

四个能力支柱：

| 支柱 | 机制 | 成熟度 |
|---|---|---|
| **代码知识图谱** | 12 种语言 AST 索引（TS 走官方编译器 API，其余走 tree-sitter WASM，离线分发） | 高 |
| **上下文压缩** | L0 关键词+向量召回 → L1 图压缩（PageRank）→ L2 语义压缩 → L3 自适应预算；实测节省 99.0% token | 高 |
| **规划与编排** | ATP v1.0（8 步思考协议）+ DAG 引擎 + Bridge 委托模式 | 中（重心在委托） |
| **学习飞轮** | Episodic Memory → Reflection → Skill 节点（原子/复合/进化三层 + canary 验证） | 中（差异化最强、验证最少） |

演进轨迹：v1.3.1 → v1.7.14 用了 25 天（212 个提交，187 个在 6 月之后），MCP 工具从 22 个**收敛**到 10 个，测试从 280+ 增至 402 个；v1.7.14 → v1.9.4 继续在安装适配与协议层发力（15+ Agent profile、MCP 官方 SDK 迁移、协议版本升级到 2025-11-25），测试增至 **652 个**。这是一个**方向明确、迭代极快、但由单人驱动**的项目。

---

## 二、项目定位与核心价值主张

### 2.1 项目的本质：不是编排引擎，而是"Agent 的记忆与感知层"

README 自称"多智能体编排引擎"，但代码讲述了一个不同的故事：

1. **默认执行模式是 Bridge**：`orchestrate()` 在 `executionMode === "bridge"` 时不执行任何任务，而是产出 `executionDescriptor`（含 plan DAG、压缩上下文、agentWorkItems、agentAssignments）交给外部 Agent。status 为 `DELEGATED`，由 `graphflow_report_outcome` 回填结果。
2. **LLM 模式是次要路径**：只有配置了 API key 且 provider 健康时才启用，且实现是相对简单的 worker→validator 状态机。
3. **无 LLM 时能力反而更完整**：v1.7.13 起，连 simple 模式的 plan 都默认桥接给宿主 Agent（`mode=agent-delegated`），本地启发式结果降级为 `suggestedNodes`（仅供参考）。
4. README 自己的比喻："GraphFlow 不是执行者，而是 context service"。

**结论**：GraphFlow 的真实价值主张是 **"给任何编码 Agent 装上项目级的长期记忆（图谱 + 技能 + 经验）和高效感知（压缩上下文）"**。编排只是这个价值交付的载体协议。竞品对标不应是 LangGraph / CrewAI 这类编排框架，而应是 **Serena（LSP 符号）+ mem0/Letta（Agent 记忆）在编码场景的合体**。

### 2.2 与竞品的差异化

赛道内其他工具各有单点优势：CodeGraph 在纯图谱成熟度上更领先，Serena 在 LSP 符号编辑上更专精，Repomix 在整库打包上更简单。GraphFlow 的差异化价值在于把 **"图谱 + 压缩 + 规划 + 学习记忆"合到一处**，让 agent 不仅省 token，还能跨会话复用项目经验：

| 能力域 | 核心特征 |
|---|---|
| **结构代码图谱** | 多语言 AST 索引（TS/JS/Python/Rust/Go/C/C++/Java/Ruby/Kotlin/Swift/Dart），File/Module/Symbol 节点 + 依赖/引用/定义/调用/继承边 |
| **上下文压缩** | L1/L2/L3 分层锚点，图结构压缩（边权重 + PageRank，零成本默认），可选语义压缩（MiniCPM/economy LLM），向量召回 + RRF + HNSW |
| **规划编排** | DAG 拓扑执行，六顶思考帽 + 5-Why 深度分析，Bridge 模式输出结构化执行描述符 |
| **跨会话学习** | Episodic Memory、Reflection、三层技能体系（原子/复合/进化）、nightly 学习循环 |
| **对外接入** | CLI `--json`、MCP stdio（10 个工具）、VS Code 扩展（Settings / Panel / Graph） |

---

## 三、架构全景与分层评价

### 3.1 架构全景

```
┌─ Surfaces ─────────────────────────────────────────────┐
│ CLI (20+ cmds, --json) │ MCP stdio (10 tools) │ VS Code 扩展 │
├─ Core ─────────────────────────────────────────────────┤
│ orchestrator (双轨 bridge/llm) │ triage │ dag-engine │ ATP │
├─ Graph ────────────────────────────────────────────────┤
│ 12 语言索引器 │ context-slicer │ 压缩 │ repo-map │ 4 种存储后端 │
├─ Learning ─────────────────────────────────────────────┤
│ episodic-memory │ skill-flywheel │ reflector │ nightly-trainer │
├─ Routing ──────────────────────────────────────────────┤
│ 5 provider 适配器 │ 健康探测+熔断 │ smart/economy 双 tier │
└────────────────────────────────────────────────────────┘
```

所有 Surface 汇入 CLI Runtime Facade（`src/surfaces/cli/runtime`），统一调度 graph/（索引与压缩）、core/（编排）、routing/（模型路由）、learning/（飞轮）、config/（配置）五层。

### 3.2 架构上的三个优秀决策

1. **Optional Capability Pattern**（`GraphClient`）：memory/file/sqlite/mcp-http 四种后端共用一个接口，能力可选、上层优雅降级。这是全项目最干净的设计。
2. **零成本降级链**：embedding 失败 → FNV-1a hash embedding；HNSW 未装 → 线性扫描；语义压缩不可用 → 返回原文；LLM 不可用 → Bridge 委托。任何一层失败都不阻断主流程。
3. **Agent-in-the-loop 闭环**：无 API key 时生成结构化 `agentWorkItems`（ATP 各阶段的填空题），宿主 Agent 作答后经 submit/merge 写回 Decision 节点。这把"没有 LLM"从缺陷变成了产品特性。

### 3.3 架构上的三个隐忧

1. **身份分裂**：core/orchestrator、dag-engine、runtime-controller 等编排代码实际处于半闲置状态（bridge 模式下不执行 DAG），但仍占据大量维护成本与测试时间。编排与上下文服务两条产品线在一个 repo 里互相稀释。
2. **学习飞轮缺乏效果验证**：技能打分、canary 验证、nightly 学习在机制上完整，但长期以来没有任何基准证明"注入了 skill hints 的 Agent 完成任务成功率更高"（v1.9.4 已补 skill A/B benchmark 基建，见 §13.2）。
3. **检索质量没有评估基建**：引用边靠正则扫描，PageRank 每次全图重算，召回质量没有 hit-rate 类指标。压缩节省 99% token 有 benchmark，但"剩下的 1% 是不是对的那 1%"没有答案。

---

## 四、图存储与索引系统

### 4.1 文件索引流水线

四阶段流水线：**扫描 → 分批并行处理 → 顺序合并 → 全局边构建**。

1. **扫描**：`file-indexer-walker.ts` 递归遍历工作区，按扩展名过滤，跳过 `node_modules`、`.git`，默认最大文件 200KB。
2. **分批并行**：`file-indexer.ts` 按 `concurrency`（默认 10）分 batch 并行 `processFile`，结果由外层**顺序合并**到共享数组，避免锁竞争。
3. **缓存校验**：基于 `mtimeMs` 快速筛选 + MD5 hash 确认内容变更；图快照为空但缓存非空时自动重置缓存。
4. **全局边构建**：构建 `symbolIndex` 后批量生成跨文件 `references`/`calls`/`inherits` 边。

**并行安全设计**：`processFile` 不修改任何共享状态，只返回本文件局部结果，由调用方顺序合并——避免了锁机制。

### 4.2 节点与边模型

| 节点类型 | 说明 |
|---|---|
| `File` | 代码文件，ID `file:${relPath}` |
| `Module` | 模块，按路径去扩展名归一化，ID `module:${moduleKey(relPath)}` |
| `Symbol` | 符号，ID `symbol:${relPath}:${hashText(name)}` |
| `Skill` / `Decision` / `TaskRun` / `Episode` | 学习与执行记忆节点 |

| 边类型 | 说明 |
|---|---|
| `defines` / `imports` / `references` / `calls` / `inherits` | 结构与引用 |
| `co_occurs` / `prerequisite` | 技能共现与前置 |

### 4.3 存储后端抽象（Optional Capability Pattern）

`client-factory.ts` 定义统一 `GraphClient` 接口，能力均可选（`readSnapshot?`、`deleteNode?` 等），上层 `typeof` 检查后优雅降级：

| 后端 | 类型 | 特点 |
|---|---|---|
| `memory` | `GraphifyClient` | 内存 Map，用于测试和默认场景 |
| `file`（默认） | `GraphifyFileClient` | JSON 文件持久化，写临时文件 + rename 原子替换，Windows EPERM 重试（Atomics.wait 50ms × 5） |
| `sqlite` | `GraphifySqliteClient` | 生产级后端，FTS5 全文索引、WAL 模式、批量事务；失败自动降级 file |
| `mcp-http` | `GraphifyMcpClient` | JSON-RPC 2.0 远程通信（Graphify 团队后端试点，端点校验 + 15s 超时 + 失败降级） |

### 4.4 上下文压缩分层

```
用户查询
   │
   ▼
L0: 关键词检索 + 可选向量召回 → RRF 融合排名（零成本）
   │
   ▼
L1: 图结构压缩（连通子图 + PageRank，零成本默认开启）
   │
   ▼
L2: 语义压缩（聚类合并 + 摘要 densify，可选本地 MiniCPM）
   │
   ▼
L3: 自适应预算 + 边扩展（按任务类型调 token 预算，anchor 1-hop 扩展）
   │
   ▼
LayeredContextPackage（分层配额打包输出）
```

### 4.5 语言索引器架构

| 语言 | 解析方式 |
|---|---|
| TypeScript | `typescript` 编译器 API（动态 require），深度集成 |
| Python / Go / Rust / C / C++ / Java / Ruby / Kotlin / Swift / Dart | Tree-sitter WASM 统一提取符号与边 |

WASM 语法包随 npm 包离线分发，无需网络下载；后续版本加入 Dart 索引器与 @huggingface/transformers v3 迁移。

---

## 五、编排器与任务执行引擎

### 5.1 编排器生命周期

```
orchestrate(input, options)
  ├─► 种子技能预置（幂等写入）
  ├─► 构建近无损上下文包（L1/L2/L3 + 图压缩）
  ├─► 模型路由决策（planner/worker/validator 的 provider/model）
  ├─► 技能飞轮召回高相关技能提示
  ├─► 语义检索历史 episode（Jaccard + Embedding + RRF）
  ├─► 拼接 PromptContext（summaryChannel + skillHints + episodes）
  ├─► 任务分类 triage：simple / complex（启发式或 LLM 双路径）
  ├─► [simple] worker → validator → 反馈重试（maxRetries 轮）
  └─► [complex]
        ├─► 深度规划：Six Hats + Five Whys（有 LLM）
        │     或 Agent 委托洞察（无 API key → agentWorkItems）
        ├─► DAG 计划生成（TaskNode[] 拓扑图）
        ├─► [bridge — 默认] 组装 executionDescriptor 交外部 coding agent
        └─► [llm 执行] DAG 拓扑排序 → 并发批执行 → checkpoint 持久化
```

### 5.2 DAG 执行引擎与错误体系

- **拓扑排序**：Kahn 算法；**并发批处理**；**超时控制**（`Promise.race` + `clearTimeout` 防泄漏）；**Checkpoint 恢复**（`dag:${taskHash}` 键，进程崩溃可恢复）；**失败传播**（下游自动 `blocked`）。
- **错误体系**：`errors.ts` 定义 `GraphFlowError` 基类带 `code`/`recovery` 字段，子类覆盖索引、模型、规划、执行、路由、验证等域，为上层提供结构化错误依据。

---

## 六、学习飞轮与技能系统

### 6.1 三层技能体系

| 层级 | 生成方式 | 进化机制 |
|---|---|---|
| **原子技能** | 任务文本提取（中英文分词 + stopword） | score ±1，bounded [-20,20] |
| **复合技能** | 原子技能共现且成功次数达标 | `coOccur/success/failure` 计数 |
| **进化技能** | MiniCPM-1B 对复合技能跨领域融会贯通 | `canaryStatus`: probation → verified/demoted |

**复合技能门控**：共现 ≥2、成功 ≥2、成功 > 失败才触发 LLM 进化。
**Canary 验证**：进化技能 probation 后需 ≥3 次使用，按 50% 通过率判定转正（verified）或降级（demoted 分数 -10）——**A/B 验证式技能进化**。

### 6.2 学习飞轮数据闭环

```
TaskRunResult (COMPLETED/FAILED/DELEGATED)
  ├─► 技能原子提取 → score 更新；复合技能计数更新
  ├─► 门控达标 → LLM 进化高阶技能（probation）
  └─► 写入 GraphNode (Skill) + Edge (co_occurs/prerequisite)
       ▼
feedback-collector → learning-events.jsonl → nightly-trainer
  ├─► passRate / avgTokenCost 计算 → canary 门控
  ├─► 导出 ranking 学习数据集
  └─► reflectOnEpisodes → LessonRecord → Decision 节点
       ▼
episodic-memory：recordEpisode / updateEpisodeOutcome（bridge 回填）/ findSimilarEpisodes
```

**Bridge 模式特殊处理**：`orchestrator-episode.ts` 对 `status === "DELEGATED"` 的任务跳过技能打分，防止外部 agent 未报告时误记失败。

### 6.3 优雅降级原则

所有外部依赖失败均静默 swallow 不阻断主流程：HNSW 未装 → 线性扫描；embedding 失败 → `hashEmbedding`（FNV-1a 哈希 256 维稀疏向量 + L2 归一化，零成本）；语义压缩不可用 → 返回原文。

---

## 七、模型路由与配置系统

| Tier | 角色 | 默认模型 |
|---|---|---|
| **Smart** | planner, validator | gpt-4.1 / claude-3-5-sonnet / qwen-max / doubao-pro-32k |
| **Economy** | worker, enricher, evolver, compressor | gpt-4.1-mini / claude-3-5-haiku / qwen-plus / doubao-lite-32k / minicpm5-1b |

- **动态路由**：`buildProviderHealthMap()` 依配置存在性、连续失败次数（<3）、API Key 可解析性判定健康；Fallback 链 `openai → anthropic → bailian → doubao → openbmb`。
- **熔断与限流**：连续失败 5 次熔断 60s；Token Bucket（容量 60/每秒 1）；默认超时 15s。
- **配置分层**：Global（`~/.graphflow.config.json`，禁写 workspaceRoot）→ Project Root（`<workspace>/graphflow.config.json`）→ Overlay（`<workspace>/.graphflow/config.json`），逐层 merge。
- **workspaceRoot 解析优先级**：显式参数 → `GRAPHFLOW_WORKSPACE_ROOT` 环境变量 → 配置值 → 向上查找 `.git`/`graphflow.config.json` → `cwd`。

---

## 八、对外接口：MCP / CLI / VS Code

### 8.1 MCP 工具面（22 → 10 收敛）

v1.3.1 时代 22 个工具（preview_context/expand_anchor/plan_insight/index_file/submit_insight/merge_insight/enrich_graph/rebuild/stats/metrics 等）；v1.7.14 收敛为 10 个核心工具，降低 LLM 工具调用认知负荷：

| 类别 | 工具 |
|---|---|
| **Core** | `graphflow_run`、`graphflow_report_outcome`、`graphflow_context`（preview/expand 合一）、`graphflow_plan`（simple/insight）、`graphflow_index`（filePath/mode=full）、`graphflow_skill_guide` |
| **Advanced** | `graphflow_insight`（submit/merge）、`graphflow_skill_insights` |
| **Maintenance** | `graphflow_diagnose`（含 runtime timeline）、`graphflow_artifact`（export/import） |

### 8.2 MCP 传输层演进（2026-08-01 重大变更）

- **v1.9.4 前**：手写 JSON-RPC 2.0 over stdio（约 240 行），声明 `protocolVersion: "2024-11-05"`（初版协议），capabilities 仅 `tools`，无 ping/logging/progress；`@modelcontextprotocol/sdk@1.29` 躺在依赖里未使用。
- **本次升级（2026-08-01，1.9.4 基础上）**：迁移至官方 SDK `Server` 类 + `StdioServerTransport`：
  - 协议版本 **2024-11-05 → 2025-11-25**，SDK 自动协商与旧版回退；ping 由 SDK 原生处理
  - capabilities 增加 **logging**：pino 日志经 tee destination 镜像为 `notifications/message`；文件监听器启动/失败等生命周期事件显式推送
  - **progress 通知**：`graphflow_index`（含 full rebuild）按文件上报 `notifications/progress`，`_meta.progressToken` 正确回传（onProgress 回调经 file-indexer → runtime → tool-handlers 全程可选参数，向后兼容）
  - 错误码标准化（`ErrorCode.InternalError/MethodNotFound`），移除裸 `-32000`
  - 对外 API 兼容：`createMcpServer`/`executeToolCall`/`startStdioServer`/`handleRequest` 保持不变，10 个工具定义零改动
  - 验证：652 测试全绿 + dist 产物端到端 stdio 冒烟（initialize/ping/tools/list/tools/call/logging/progress 全部通过）

### 8.3 多 Agent 安装器

15+ Agent 自动检测安装（Cursor、VS Code、Trae/CN/SOLO、Claude Code、Windsurf、Cline、Roo Code、Kilo Code、PearAI、Gemini、Codex、Antigravity、Amazon Q、Zed、Continue、Opencode、Qoder）。安装策略三选一：`npx` / `npm-script` / `node-bundled`；Windows 下处理 `npx.cmd`、8.3 短路径、`.cjs` launcher 等坑。

### 8.4 CLI 与 VS Code 扩展

CLI 20+ 命令全部支持 `--json` 与 `--config`；VS Code 扩展提供 Settings / Panel / Graph 视图，激活时安装 MCP + Rules + Skill，WSL 下仅写用户级配置。

---

## 九、关键设计决策与独特亮点

### 9.1 关键设计决策

| 决策点 | 设计选择 | 原因/权衡 |
|---|---|---|
| **并行索引** | 分 batch 并行（concurrency=10），结果顺序合并 | 避免共享数组锁竞争 |
| **存储抽象** | `GraphClient` 统一接口，能力 optional | 多后端差异大，上层优雅降级 |
| **压缩分层** | 图结构（零 LLM）→ 语义（本地小模型）→ 自适应预算 | 成本递增、精度递增；任一环节可降级 |
| **Bridge 模式** | 默认输出 executionDescriptor 给外部 agent | 诚实执行语义，不伪造 COMPLETED |
| **双轨解析** | TS 官方编译器 API；其他语言 Tree-sitter WASM | TS 深度集成 + 统一 WASM 运行时 |
| **引用检测** | 正则 `\b\w{3,}\b` 扫描 + skip list | 简单、语言无关、快；牺牲精度 |
| **Checkpoint** | `dag:${taskHash}` 持久化节点状态 | 崩溃恢复，避免重复执行/计费 |
| **Canary 验证** | 进化技能 probation ≥3 次后 50% 阈值升降级 | A/B 验证式进化，防低质技能上线 |

### 9.2 独特设计亮点

1. **Optional Capability Pattern**：一接口适配内存/文件/SQLite/MCP 四种差异巨大的后端。
2. **Windows 文件锁重试**：EPERM 时 `Atomics.wait` 50ms 重试（最多 5 次）。
3. **Agent 委托"人机共生"**：无 API key 时生成结构化 `AgentWorkItem[]` 填空式闭环。
4. **HNSW 懒加载与透明回退**：首次 `search` 才构建，失败自动降级暴力扫描。
5. **本地 Embedding 预热**：`warmup()` 用 dummy 文本触发首次推理，消除真实请求延迟。
6. **零成本 Hash Embedding**：FNV-1a → 256 维稀疏向量 + L2 归一化。
7. **Bridge 学习闭环保护**：DELEGATED 任务跳过技能打分。
8. **种子技能"有基础但不过度"**：score=2（满分 20）、uses=0，提供冷启动又不误判已验证。
9. **runtime timeline**：`diagnose` 附运行时取消/阶段时间线，便于排查桥接任务。

---

## 十、潜在问题与改进空间（含修复状态）

### 10.1 性能相关

| 问题 | 状态 |
|---|---|
| 引用边构建 O(N×M)：正则提取标识符 × 查全局 symbolIndex | 未修复（大仓库索引耗时/内存主要瓶颈） |
| `GraphifyFileClient` 读写放大：每次 `upsertNodes` 全量读写 JSON + 重建倒排 | 未修复（默认后端仍是 file；sqlite 已实现未默认） |
| PageRank 每次全图重算 | 未修复 |

### 10.2 正确性相关

| 问题 | 状态 |
|---|---|
| 符号哈希冲突：`symbol:${relPath}:${hashText(name)}` 同名符号冲突 | 未修复 |
| `GraphifyMcpClient` 无超时/重试 | 已修复（15s 超时 + `withFallback` 降级） |

### 10.3 工程相关

| 问题 | 状态 |
|---|---|
| Tree-sitter WASM 查找硬编码 `../../../wasm` 相对路径 | 未验证 |
| TS `fallbackExtract` 正则过于简陋 | 未验证 |
| **测试环境敏感**：embedding 模型真实下载/加载致 35-60s 单测与偶发超时 | 显著改善（本地全套 652 测试约 9s） |
| **默认存储 file 的读写放大** | 未修复（sqlite 后端已实现） |

### 10.4 风险清单

1. **单人项目**：bus factor = 1，v1.7.x 期间一天多个 patch 版本的节奏不可持续。
2. **竞争挤压**：上游模型厂商（Claude Code、Codex）正在把上下文管理、记忆内置化；Serena 已占据 LSP 符号心智，独立中间层窗口收窄。
3. **"编排"叙事与实际功能落差**可能误导新用户预期（v1.9.4 README 已改写为「编码 Agent 的上下文与记忆层」，缓解）。

---

## 十一、演进轨迹 v1.3.1 → v1.9.4

按 CHANGELOG 归纳投入分布（v1.3.1 → v1.7.14）：

| 投入方向 | 占比（估算） | 代表性变更 |
|---|---|---|
| **安装/集成/多 IDE 适配** | ~40% | 15+ Agent profile、Trae/Qoder/Opencode 支持、MCP home-cwd 修复、Open VSX 发布 |
| **CI/发布工程** | ~20% | Node 22 矩阵、幂等发布、VSIX 自动化 |
| **协议与产品形态** | ~20% | ATP v1.0、MCP 工具 22→10 收敛、agent-delegated 模式 |
| **核心算法** | ~15% | transformers v3 迁移、Dart 索引器、技能衰减、embedding 超时/HF 镜像 |
| **隐私与治理** | ~5% | `learn forget`、episode 导出排除、毒技能剪枝 |

v1.7.14 → v1.9.4 的关键投入：

- **MCP 传输层 SDK 化**（2026-08-01）：官方 SDK、协议 2025-11-25、logging/progress 能力（§8.2）
- **CI 触发修正**：ci.yml 增加 `push: branches: [main]`，main 推送即跑完整 CI
- **README 重写**：定位改为「编码 Agent 的上下文与记忆层」，修复中文乱码（0x3F 损坏）
- **Skill A/B benchmark** 进入 CI（skill-ab 基准作业）

**解读**：项目处于**"分发打磨期"**——核心算法创新放缓，精力集中在"让更多人装得上、用得起来"。这是合理的阶段性选择，但护城河尚未挖深：安装体验是必要条件，不是充分条件。

---

## 十二、实测验证（综合调研执行）

| 验证项 | 结果 |
|---|---|
| Token 节省基准 | 226,281 → 2,151 tokens（99.0%），gpt-tokenizer 独立复核，方法论诚实（基线保守、自我估值单列） |
| 测试套件（v1.9.4） | **95 文件 / 652 用例全部通过**，本地约 9s；v1.7.14 时代的 60s 超时与 m16 断言回归已消失 |
| MCP 端到端（dist 产物） | initialize 返回 2025-11-25、ping、tools/list（10 工具）、tools/call、logging 通知、25 文件逐文件 progress 通知——全部正常 |
| 工程成熟度 | TypeScript strict、husky + lint-staged、CI 含扩展打包 smoke、版本/changelog 纪律良好 |

---

## 十三、进化方向建议与执行状态

### 13.1 战略层建议执行状态

| 建议（v1.7.14 提出） | 状态 |
|---|---|
| **抉择一**：定位从"编排引擎"收敛为"Context & Memory Layer for Coding Agents" | ✅ 已执行（README 重写为「编码 Agent 的上下文与记忆层」） |
| **抉择二**：护城河押在学习飞轮并补效果证据（Agent 成功率 A/B 基准） | 🟡 部分（skill A/B benchmark 已入 CI，公开证据仍不足） |
| **抉择三**：ATP IR + insight 协议做成公开版本化规范 | ✅ 已执行（docs/atp-ir-spec-v1.md 存在） |

### 13.2 战术层建议执行状态

| 建议 | 优先级 | 状态 |
|---|---|---|
| 治理测试超时（embedding 可注入 fake provider） | P0 | ✅ 显著改善（652 测试约 9s） |
| 修复 m16 断言回归（triage 环境敏感） | P0 | ✅ 已消失 |
| 检索 hit-rate golden set 入 CI | P0 | ⬜ 未执行 |
| sqlite 后端默认化（或大项目自动切换） | P1 | ⬜ 未执行（仍 file） |
| 引用边构建优化（Trie/布隆过滤） | P1 | ⬜ 未执行 |
| HNSW 索引持久化 | P1 | 🟡 有进展（hnsw-persistence 测试） |
| 技能共享包（git-based 团队记忆同步） | P2 | 🟡 部分（artifact export/import 已存在） |
| 飞轮可观测性（VS Code 技能贡献报告） | P2 | 🟡 部分（面板已存在，技能归因未全量可视化） |
| 技能冷启动（git log 自动挖掘） | P2 | ⬜ 未验证 |
| 公开基准页（CI 产物 + 对标） | P3 | 🟡 部分（benchmarks/RESULTS.md 已有） |
| surface profile 数据化（JSON 声明 + 通用安装器） | P3 | ⬜ 未验证 |
| README 乱码修复 | P3 | ✅ 已修复（README 重写时一并处理） |

### 13.3 新演化建议（2026-08-01 综合版新增）

**已完成（本版本落地）：**

1. **MCP 传输层 SDK 化**（P0）：手写 JSON-RPC → `@modelcontextprotocol/sdk@1.29`；协议 2024-11-05 → 2025-11-25；新增 ping/logging/progress；错误码标准化。收益：协议协商与版本回退由 SDK 保证，未来协议升级免重写握手层。详见 §8.2。
2. **CI 完整化**（P0）：ci.yml 增加 `push: branches: [main]`——此前完整 CI 只在 PR 触发，main 推送只跑 Build，导致"推送了但没有 CI"的观感。

**待办（按优先级）：**

3. **MCP resources 能力**（P2）：把知识图统计/诊断数据暴露为 `graphflow://` resources，配合 `notifications/resources/list_changed`，让客户端原生发现图状态。
4. **MCP 2026-07-28 无状态规范适配**（P3 前瞻）：MCP 刚发布史上最大改版（2026-07-28，业界称 MCP 2.0）：移除 initialize 握手、新增 `server/discover`、每请求 `_meta` 携带协议信息、工具 schema 升级 JSON Schema 2020-12（`oneOf` 可用于 `graphflow_insight` 的 mode 条件必填）、`ping`/`logging/setLevel` 移除但保留 12 个月兼容窗口、roots/sampling/logging 进入弃用期。当前 SDK 1.29 最新支持 2025-11-25；**升级 SDK 即自动获得兼容，无需重写**（这是 SDK 化的核心收益）。注意：2026-07-28 移除 ping——若升级 SDK 后协议声明到新版本，需复核 ping 依赖。
5. **学习飞轮效果证据**（P1，延续）：把 skill A/B 基准从"基建存在"推进到"公开结论"——同一批真实任务开关 skill hints 各跑 N 次，对比成功率与 token，结果进 benchmarks/RESULTS.md。

### 13.4 一句话总结

GraphFlow 已经完成了从"编排引擎"到"Agent 记忆层"的蜕变：代码诚实（bridge 不伪造执行）、降级链优雅、基准方法论严谨，且 MCP 接入层已在官方 SDK 上与协议演进对齐。下一步的关键不是加功能，而是**收敛定位、为学习飞轮补上效果证据、把协议做成标准**——在被平台内置化之前，先成为跨平台的记忆基础设施。
