# GraphFlow

[![npm version](https://img.shields.io/badge/npm-1.9.7-blue)](https://www.npmjs.com/package/@roarpeng/graphflow)

> **编码 Agent 的上下文与记忆层** — Local-first 代码知识图谱 + 上下文压缩 + 跨会话学习飞轮

GraphFlow 为 Cursor / Claude Code 等编码 Agent 提供项目级的"感知与记忆"：把仓库索引成知识图谱，将 Agent 需要的上下文压缩 **90%+ token**（基准实测 98.7%），并通过 Episodic / Skill / Decision 三类节点让 Agent **跨会话复用项目经验**。规划与执行通过 Bridge 模式委托给宿主 Agent 完成——GraphFlow 不持有 LLM 也能完整闭环。

纯 TypeScript/Node 实现，CLI + MCP + VS Code 扩展三种形态，无 API key 即可离线运行。

## 30 秒上手

无需 API key（离线 AST 建图 + 图压缩）：

```bash
# 1. 离线建图（AST 索引，无需 LLM）
npx @roarpeng/graphflow graph index .

# 2. 预览压缩上下文（锚点 + 摘要，节省 90%+ token）
npx @roarpeng/graphflow context preview "orchestrator" --json
```

接入 MCP（Cursor / Claude Code 等）：

```json
{
  "mcpServers": {
    "graphflow": {
      "command": "npx",
      "args": ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"]
    }
  }
}
```

Agent 先调 `graphflow_context` 拿压缩上下文，再用 `graphflow_plan` 规划；无 provider API key 时 GraphFlow 自动把 ATP 思考协议桥接给宿主 Agent 作答（agent-delegated 模式）。

## 为什么是 GraphFlow

单点工具各有长项，GraphFlow 把"图谱 + 压缩 + 规划协议 + 学习记忆"合到一处：

| 能力 | **GraphFlow** | CodeGraph | Serena | Repomix |
| --- | --- | --- | --- | --- |
| 代码图谱 | 12 语言 AST 索引 | 更成熟 | LSP 符号级 | 无 |
| 上下文压缩 | 分层 + 图压缩 + 向量召回 | 部分 | 部分 | 整库打包 |
| 规划协议 | ATP IR + DAG + Agent 桥接 | 无 | 无 | 无 |
| **学习记忆** | Episodic / Skill / Decision 飞轮 | 无 | 无 | 无 |
| Local-first | ✅ | ✅ | ✅ | ✅ |
| 协议开放 | [ATP/IR 公开规范](docs/atp-ir-spec-v1.md) | — | — | — |

> 差异化核心是**学习飞轮**：图谱索引和 token 压缩都可复制，跨会话积累的项目私有经验（技能、教训、决策）不可复制——它随使用时长增值。

## 核心能力（v1.7.15+）

| 模块 | 能力 |
| --- | --- |
| **规划协议** | ATP v1.1（Intent / Requirement / Six Hats / 5-Why / First Principles / Decision Matrix / Planning / Reflection）；simple / complex / insight 三种模式；无 LLM 时 agent-delegated 桥接；[ATP/IR 公开规范 v1.1](docs/atp-ir-spec-v1.md) |
| **目标对齐** | **Goal 锚点节点化**（intent 五元组固化为一等公民，每次打包自动注入原始需求）；**低置信度澄清门**（confidence < 0.6 不出 plan）；**alignment-check 执行期回检**；**deviation 偏离分类**（misread-requirement / scope-creep / tech-drift）；**Goal 版本链 + 变更 diff** |
| **知识图谱** | 12 语言 AST 索引（TS/JS/Python/Rust/Go/C/C++/Java/Ruby/Kotlin/Swift/Dart）；File / Module / Symbol 节点 + 依赖/引用/定义/调用/继承边 |
| **上下文压缩** | L1/L2/L3 分层锚点；图结构压缩（边权重 + PageRank，**LRU 缓存**）；**词干匹配召回**（orchestrate ↔ orchestration）；向量召回 + RRF；RepoMap 概览；自适应预算 |
| **检索质量** | **Golden-set 回归门禁**（132 查询，Hit@5=100%、MRR=0.836、NDCG@5=0.601） |
| **向量索引** | 进程内记忆化 + **磁盘持久化**（指纹校验，MCP 重启秒级恢复） |
| **存储后端** | `file` / `memory` / `sqlite`（FTS5，**searchtext 分词增强**，camelCase 可检索）/ **`auto`（sqlite 优先自动切换）** / `mcp-http` |
| **学习飞轮** | Episodic Memory、Reflection、Skill 节点（score ±1，bounded [-20,20]）、nightly 学习、技能衰减/剪枝、**飞轮贡献报告**（`skill report` / `graphflow_diagnose`，含偏离聚合与 Goal 统计） |
| **团队共享** | **`skill sync`**：技能包导出/导入到可提交的 `.graphflow/skills/team-skills.json`；导入为**双向 MERGE**（per-skill-id 并集，updatedAt 较新者胜、并列保留本地、本地独有技能保留；`--force` 覆盖）；golden 检索基准随包往返 → `.graphflow/team-golden.json` |
| **效果基准** | [综合评测 92.9%](benchmarks/COMPREHENSIVE-RESULTS.md) · [独立评测 96.2%](benchmarks/INDEPENDENT-RESULTS.md) · [SWE-bench 100%](benchmarks/SWE-BENCH-RESULTS.md) · [Token 节省 98.2%](benchmarks/RESULTS.md) |
| **模型路由** | Smart / Economy 双 tier；多 provider 健康探测与 fallback（DeepSeek、OpenAI、Anthropic、百炼、豆包） |
| **可观测性** | `graphflow_diagnose`：provider 健康 + 图统计 + token 节省 + **飞轮报告** |
| **Agent 接入** | CLI `--json`；MCP stdio（10 工具）；自动安装 MCP 到 15+ Agent |
| **工程质量** | TypeScript strict；**99 测试文件 / 692 tests**；`npm run ci` 含扩展打包与 smoke |

### 定位说明

> GraphFlow **不是编排执行器**——它是编码 Agent 的**上下文与记忆层**。任务执行通过 Bridge 模式交给宿主 coding agent（诚实语义，不伪造 COMPLETED）；GraphFlow 负责让它"看得准、记得住"。

## MCP 工具（10 个）

| 工具 | 功能 |
| --- | --- |
| `graphflow_context` | 压缩上下文包（query → 锚点 + 摘要；anchorId → 展开） |
| `graphflow_plan` | 任务规划（mode='simple' 或 'insight'；无 LLM 时 agent-delegated） |
| `graphflow_run` | 编排 + Bridge 执行描述符 |
| `graphflow_report_outcome` | 结果回填（含 deviation 偏离分类），闭环学习飞轮 |
| `graphflow_insight` | ATP 洞察 submit / merge（Agent 桥接协议） |
| `graphflow_index` | 增量 / 全量索引 |
| `graphflow_skill_insights` | 技能洞察 |
| `graphflow_diagnose` | 诊断（provider + 图 + token 节省 + 飞轮） |
| `graphflow_artifact` | 图谱 artifact 导入 / 导出 |
| `graphflow_skill_guide` | GraphFlow Skill 使用指南 |

**MCP 工作区解析**：自动从 MCP 客户端 `cwd` 发现工作区；也可用 `GRAPHFLOW_WORKSPACE_ROOT` 显式指定。

## CLI 速查

```bash
graphflow graph index .                    # 建图
graphflow context preview "orchestrator"   # 上下文预览
graphflow plan "refactor planner" --json   # 规划
graphflow run "update readme"              # 编排（Bridge）
graphflow skill insights                   # 技能洞察
graphflow skill report                     # 飞轮贡献报告
graphflow skill sync export                # 导出团队技能包 + golden 查询集（git 共享）
graphflow skill sync import                # 导入团队技能包（MERGE；--force 覆盖）＋ golden 合并到 .graphflow/team-golden.json
graphflow route diagnose                   # 路由诊断
graphflow learn nightly                    # 夜间学习
graphflow doctor                           # 安装自检
```

## 配置

三层合并：全局 `~/.graphflow.config.json` → 项目 `graphflow.config.json` → 项目 `.graphflow/config.json`。复制 [graphflow.config.example.json](graphflow.config.example.json) 起步。

关键项：

| 配置 | 说明 |
| --- | --- |
| `graphPolicy.transport` | `file` / `memory` / `sqlite` / **`auto`（推荐：sqlite 优先，不可用自动降级 file）** / `mcp-http` |
| `graphPolicy.maxContextTokens` | 上下文预算（默认 1500） |
| `graphPolicy.autoIndexOnSave` | 保存时自动增量索引（默认 true） |
| `embeddingPolicy.provider` | `transformers`（本地默认）/ `openai` / `hash` |
| `embeddingPolicy.vectorStorePath` | 向量索引持久化路径（自动派生 `.hnsw`） |
| `skillPolicy.enableSkillFlywheel` | 学习飞轮开关 |

## Team backend pilot（团队后端试点）

将 `graphPolicy.transport` 设为 `mcp-http` 即可把图谱托管到远程 Graphify 服务（团队共享），需配置 `graphPolicy.mcpEndpoint`（http(s) URL，可选 `mcpApiKey` bearer token）：

```json
{ "graphPolicy": { "transport": "mcp-http", "mcpEndpoint": "http://graphify.team.internal:8080" } }
```

Endpoint 缺失/格式非法会在配置校验时直接报错；连接失败或运行期请求失败则透明降级到本地 JSON 文件存储（`graphPolicy.graphStorePath`，默认 `graphflow-out/graphflow-graph.json`）并记录 `logger.warn`，与 sqlite→file 降级一致，不会中断 Agent 流程。试点协议暂不支持全量快照：`readSnapshot` 返回本地镜像文件（可能滞后）。

## 基准

- **综合能力**：[COMPREHENSIVE-RESULTS.md](benchmarks/COMPREHENSIVE-RESULTS.md) — P1-P6 六维度评测，总体 **92.9%**（索引 100% / 压缩 64.9% / 规划 100% / 学习 100% / Bridge 100% / 性能 99.7%）
- **独立评测**：[INDEPENDENT-RESULTS.md](benchmarks/INDEPENDENT-RESULTS.md) — CodeGraph 风格 5 域评测，Hit@5 **96%**、Token 节省 **96.6%**、总体 **96.2%**
- **SWE-bench**：[SWE-BENCH-RESULTS.md](benchmarks/SWE-BENCH-RESULTS.md) — 12 实例端到端评测，上下文就绪率 **100%**（easy/medium/hard 全覆盖）
- **Token 节省**：[RESULTS.md](benchmarks/RESULTS.md) — 8 个代表性查询，**98.2%** 节省，独立 gpt-tokenizer 复核
- **检索质量**：[RETRIEVAL-EVAL-RESULTS.md](benchmarks/RETRIEVAL-EVAL-RESULTS.md) — 132 查询，Hit@5=100%、MRR=0.836、NDCG@5=0.601
- **Skill 飞轮 A/B**：[SKILL-AB-RESULTS.md](benchmarks/SKILL-AB-RESULTS.md) — 注入率 100%、召回 100%、开销 25.6 tok/任务

## VS Code / Cursor 扩展

从 [GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases) 下载 `graphflow-<version>.vsix` 安装（或 Open VSX：`roarpeng.graphflow`）。

命令：Settings / Show Graph（图谱可视化）/ Preview Context / Plan & Brainstorm / Run Task / Skill Insights / Install MCP；Chat Agent `@graphflow`（`/run` `/plan` `/graph` `/skills` `/diagnose` `/learn` `/history`）。

## Agent 集成

```bash
npx @roarpeng/graphflow doctor     # 检测已安装的 Agent
npx @roarpeng/graphflow install    # 自动安装 MCP + Skill + Rules
npx @roarpeng/graphflow init       # 写入最小项目配置
```

支持：Cursor、VS Code、Trae（含 CN）、Claude Code、Windsurf、Cline、Roo Code、Kilo Code、Gemini CLI、Codex、Antigravity、Opencode、Qoder、Amazon Q、Zed、Continue 等 15+。

## 协议

[ATP/IR — Agent Thinking Protocol 公开规范 v1.0](docs/atp-ir-spec-v1.md)：work-item 注册表、submit/merge 契约、兼容性规则。第三方工具可实现兼容的 producer / consumer。

## 社区

GraphFlow 是单人维护项目（bus factor = 1），社区协作是降低单点风险的关键，欢迎参与：

- [贡献指南](CONTRIBUTING.md)：开发环境、代码规范、测试要求与 PR 检查清单
- [路线图](ROADMAP.md)：已完成里程碑与下一阶段计划（P0–P2）
- [Issues](https://github.com/Roarpeng/GraphFlow/issues)：bug 报告与功能请求（请使用内置模板）
- [Discussions](https://github.com/Roarpeng/GraphFlow/discussions)：使用疑问与想法讨论

## 开发

```bash
npm install
npm run ci        # lint + build + 测试 + 扩展打包 + smoke
```

要求 Node.js ≥ 20、npm ≥ 10。预期：lint 无错误、构建成功、692 测试通过。

## 项目结构

```text
GraphFlow/
├── src/
│   ├── core/           # 编排核心：orchestrator, triage, dag-engine, agent-delegation
│   ├── graph/          # 索引、上下文切片、图压缩、sqlite/auto 存储、snapshot
│   ├── routing/        # 模型路由与健康探测（5 provider）
│   ├── learning/       # embeddings, episodic, skill-flywheel, hnsw, nightly
│   ├── agents/         # ATP schema, planner, insight, brainstormer
│   └── surfaces/
│       ├── cli/        # CLI + runtime
│       └── mcp/        # MCP server（10 工具）
├── tests/              # 99 文件 / 692 tests（含检索 golden set、bridge+DAG）
├── benchmarks/         # 综合 + 独立 + SWE-bench + token 节省 + skill A/B（可复现）
├── docs/               # ATP v1.0 设计 + ATP/IR 公开规范
├── vscode-extension/   # VS Code 面板与命令
└── CHANGELOG.md
```

## 历史变更

详细记录见 [CHANGELOG.md](CHANGELOG.md)。License：Apache-2.0。
