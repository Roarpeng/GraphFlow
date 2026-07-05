# GraphFlow

> **Local-first 代码知识图谱 + 跨会话学习记忆** —— 不只是压缩上下文，还记住项目的决策与教训。

GraphFlow 把你的仓库变成一张**可查询的代码图谱**，在 agent 读全文之前先返回压缩摘要与锚点（入门钩子：**图谱 + 90%+ token 压缩**）；更进一步，它用 **Episodic / Skill / Decision 节点**把每次任务的决策与教训沉淀回图谱，形成跨会话的**学习飞轮**（差异化纵深）。

纯 TypeScript/Node 本地运行，通过 CLI、MCP、VS Code 扩展对外暴露。**无需 API key、无需配置**即可起步：结构索引 + 离线压缩开箱即用。

## 30 秒上手

无需 API key、无需注册——结构图谱与离线压缩本地直接跑：

```bash
# 1. 建立结构图谱（纯 AST，零 LLM、零网络）
npx @roarpeng/graphflow graph index .

# 2. 压缩预览：读全文前先拿摘要 + 锚点（通常省 90%+ token）
npx @roarpeng/graphflow context preview "orchestrator" --json
```

接入 MCP（Cursor / Claude Code 等），最小配置：

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

接好后让 agent 优先调用 `graphflow_preview_context` 取压缩上下文；多步任务用 `graphflow_plan`。配置 provider API key 是**可选**的——只在需要 LLM 规划增强时才用。

## 为什么选 GraphFlow（与同类对比）

这个赛道里有许多优秀的单点工具，GraphFlow 的定位不是"某一项最强"，而是**在代码图谱之上叠加了上下文压缩、规划编排与跨会话学习记忆**——尤其是"记忆型代码图谱"这一块目前少有人占据。诚实对比如下：

| 维度 | **GraphFlow** | CodeGraph | Serena | Repomix |
| --- | --- | --- | --- | --- |
| 结构代码图谱 | ✅ 多语言 AST 图谱 | ✅ 更成熟（★ 更高） | ⚠️ LSP 符号（非全图谱） | ❌ |
| 上下文压缩 | ✅ 两层渐进（结构+向量） | ⚠️ 图查询为主 | ⚠️ 符号级精修 | ✅ 整库打包（无压缩） |
| 规划编排 | ✅ DAG / 六顶思考帽 | ❌ | ❌ | ❌ |
| **跨会话学习记忆** | ✅ Episodic / Skill / Decision 节点 | ❌ | ❌ | ❌ |
| Local-first | ✅ | ✅ | ✅ | ✅ |
| 许可 | Apache-2.0 | MIT | MIT | 宽松开源 |

> 实话实说：论纯图谱的成熟度与社区规模，CodeGraph 更领先；论 LSP 符号编辑标准，Serena 更专精；论整库打包，Repomix 更简单。GraphFlow 的价值在于把"图谱 + 压缩 + 规划 + 学习记忆"合到一处，让 agent 不仅省 token，还能跨会话复用项目经验。

## 当前能力总览（v1.4.0+）

| 能力域 | 说明 |
| --- | --- |
| **任务规划与移交** | 按任务复杂度分流 simple / complex / insight；DAG 规划；`graphflow_plan_insight` 六顶思考帽 + 5-Why 深度分析；默认 **bridge 模式**输出结构化任务描述符交给外部 coding agent 执行 |
| **模型路由** | Smart / Economy 双 tier；多 provider 健康探测与 fallback（OpenAI、Anthropic、百炼、豆包） |
| **知识图谱** | 工作区 AST 索引（TS/JS/Python/Rust/Go/C/C++/Java/Ruby/Kotlin/Swift）；File / Module / Symbol 节点 + 依赖/引用/定义/调用/继承边；图谱 artifact 导入/导出 |
| **上下文压缩** | L1/L2/L3 分层锚点；近无损打包；图结构压缩（边权重+PageRank，零成本默认开启）；向量召回 + RRF + HNSW ANN；RepoMap 概览；自适应预算 |
| **持续建图** | 默认 `autoIndexOnSave`；MCP 启动时自动启动 FileWatcher；preview / run 前按需增量索引；MCP `graphflow_index_file` 单文件增量 |
| **学习飞轮** | Episodic Memory（Jaccard + embedding RRF 语义检索）、Reflection（聚类 + Lesson 提取）、Skill 节点（score ±1，bounded [-20,20]）、nightly 学习、技能提示注入规划 |
| **可观测性** | `graphflow_stats` 累计 token 节省；VS Code 知识图谱 Snapshot |
| **Agent 接入** | CLI `--json`；MCP stdio（**18 工具**）；自动安装 MCP 到 15+ Agent（Cursor / Claude Code / Windsurf / Cline / Codex / Gemini 等） |
| **VS Code 扩展** | Settings、建图、路由测试、Context Preview、**知识图谱可视化**、Skill Insights、Chat Agent、一键安装 MCP |
| **存储后端** | `file`（JSON）/ `memory` / `sqlite`（FTS5）/ `mcp-http`（Graphify） |
| **多项目隔离** | 全局配置共享 LLM/路由；**图谱路径按当前工作区解析**，不再串读其它项目的 `graphflow-out` |
| **工程质量** | TypeScript strict；**56 测试文件 / 249+ tests**；`npm run ci` 含扩展 esbuild 打包与 bundled runtime smoke |

### 一句话总结

> 从 task 描述出发，自动规划 → 路由模型 → 压缩图谱上下文（含向量召回）→ **输出结构化执行描述符交给外部 coding agent**，并把经验沉淀回知识图谱；定位为 **上下文与规划服务（context service）**，而非独立执行器。

### v1.4.0 核心（2026-07）

**奥卡姆剃刀精简**：移除 OpenBMB 本地部署、语义压缩模型、语义增强器、技能进化、金丝雀门控、本地嵌入模型、向量存储等未产生真实价值的模块。留下的是三条经过验证的闭环链路。

**三大核心功能验证修复**：

1. **HNSW 向量召回完全打通**（P0 修复）
   - `file-indexer` 现在为所有 File/Symbol/Module 节点附加 hash embedding（零成本 FNV-1a，256 维）
   - `orchestrator-context` 现在传递 `embeddingProvider` + `enableVectorRecall` 到压缩管道
   - HNSW 索引持久化路径接通（`vectorStorePath` → `.hnsw` 文件）
   - 大仓库（≥200 节点）自动使用 HNSW ANN（10-100x 提速），小仓库线性扫描

2. **FileWatcher 接入 MCP 启动**（P0 修复）
   - `startFileWatcherIfEnabled` 此前是死代码，现已接入 MCP 服务器启动路径
   - 当 `autoIndexOnSave: true` 时自动监听文件变化并增量索引

3. **技能飞轮闭环修复**（P1 修复）
   - `skillHints` 解耦：不再依赖 `enableGraphContextInPrompt`，独立注入 worker prompt
   - Dangling edges 修复：`applySkillLearning` 现在先创建 Decision 节点再连 `improves` 边

### 历史演进

- **v1.3.x**：多项目图谱隔离、Java/Ruby 索引器、MCP 工具扩展、知识图谱可视化
- **v1.0.x**：诚实执行语义（bridge 模式）、三层渐进压缩、混合压缩模型
- **v0.6.x**：全局配置脚手架、autoIndexOnSave、runtime 模块化、VS Code esbuild bundle

### 发布信息

- 最新版本：**v1.4.2**（root + vscode-extension）；npm：`@roarpeng/graphflow@1.4.2`
- **GitHub Release**：push 到 `main` 后 CI 在 `windows-2022` 上自动构建 VSIX 并发布到 [GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases)
- **npm 发布**：push tag `v*`（如 `v1.4.1`）触发 [Publish npm](https://github.com/Roarpeng/GraphFlow/actions/workflows/publish-npm.yml) 工作流
- 变更日志：`CHANGELOG.md`

## 环境要求

1. Node.js >= 20
2. npm >= 10
3. Windows / macOS / Linux 均可
4. **npm 安装 `@roarpeng/graphflow` 时**：`hnswlib-node` 为**强制依赖**（HNSW 向量召回），首次安装会编译原生模块
   - **Linux / macOS**：通常自带 C++ 工具链即可
   - **Windows**：需安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) 并勾选 **「使用 C++ 的桌面开发」**；或使用 WSL / Linux 环境安装

## 5 分钟本地试跑

```bash
npm install
npm run ci
```

预期：`lint` 无错误、`build` 成功、**249+ tests** 通过、扩展 bundle 与 runtime smoke 通过。

## Agent 工具接入

GraphFlow 支持两种对外接入方式：

1. **CLI 机器输出**：核心命令均支持 `--json`
2. **MCP stdio server**：Cursor、Claude Code 等可直接调用

本仓库启动 MCP：

```bash
npm run start:mcp
```

### MCP 工具一览（18 个）

| 工具 | 用途 |
| --- | --- |
| `graphflow_preview_context` | 压缩任务相关上下文（**优先调用**） |
| `graphflow_plan` | 多步任务分解与 DAG 规划 |
| `graphflow_plan_insight` | 六顶思考帽 + 5-Why 深度分析后规划（复杂任务） |
| `graphflow_run` | 规划 + 压缩上下文，输出 bridge 执行描述符 |
| `graphflow_report_outcome` | 向 GraphFlow 汇报任务执行结果，用于学习飞轮 |
| `graphflow_submit_insight` | 回传 `agentWorkItems` 中每条 prompt 的外部 agent 分析结果 |
| `graphflow_merge_insight` | 合并已提交的 agent 分析为完整 Six Hats insight + DAG plan |
| `graphflow_expand_anchor` | 扩展指定锚点的上下文详情 |
| `graphflow_index` | 全工作区增量建图 |
| `graphflow_index_file` | 单文件增量建图（适合 onSave / watcher） |
| `graphflow_rebuild` | 清空缓存后全量重建 |
| `graphflow_inspect_graph` | 图谱快照统计与样本节点 |
| `graphflow_skill_insights` | 技能学习洞察 |
| `graphflow_diagnose` | 路由与模型健康诊断 |
| `graphflow_export_artifact` | 导出压缩图谱 artifact |
| `graphflow_import_artifact` | 导入图谱 artifact |
| `graphflow_stats` | 累计 token 节省 ROI 统计 |
| `graphflow_skill_guide` | 获取 GraphFlow Skill 使用指南 |

**MCP 建图提示**：用户级 MCP 进程的 `cwd` 不一定是当前项目。请任选其一：

- 调用 `graphflow_index` 时传入 `rootDir`（项目绝对路径）
- 在 MCP 配置中设置 `GRAPHFLOW_WORKSPACE_ROOT` 环境变量
- 使用 VS Code 扩展「建立图谱」或项目级 `.cursor/mcp.json`

CLI 示例：

```bash
npm run start -- plan "refactor planner and add tests" --json
npm run start -- context preview "orchestrator" --json
npm run start -- graph inspect --json
```

外部 agent 约定文件：`AGENTS.md`、`CLAUDE.md`、`.cursor/rules/graphflow.mdc`

## 本地功能验证（CLI）

### 图谱索引

```bash
npm run start -- graph index .
```

预期：`indexedFiles=…; indexedSymbols=…`

### 上下文压缩预览

```bash
npm run start -- context preview "orchestrator"
```

预期：`summary=…; anchors=…; tokens=…`（相对原始上下文通常可节省 **90%+ token**）

### 执行任务 / 规划

```bash
npm run start -- run "update readme and add tests"
npm run start -- plan "update readme and add tests and refactor architecture module"
```

### 路由诊断 / 学习 / 洞察

```bash
npm run start -- route diagnose
npm run start -- learn nightly
npm run start -- graph inspect
npm run start -- skill insights
```

## 进阶能力

### 上下文压缩

GraphFlow 的压缩采用「两层渐进」策略，先用零成本图结构压缩砍掉冗余节点，再用向量召回补充语义相关节点：

| 层 | 机制 | 成本 | 默认 |
| --- | --- | --- | --- |
| 图结构压缩 | 边权重连通子图 + PageRank 中心性重排 | 零 LLM | **开启** |
| 向量召回 | hash embedding + RRF 融合；候选 ≥200 自动用 HNSW ANN | 零 LLM | **开启** |
| RepoMap 概览 | 预算紧张时返回模块级地图 | 零 LLM | opt-in |
| 自适应预算 | 按任务复杂度动态调整 token 预算 | 零 LLM | opt-in |

**向量召回设计**：

- 索引时：`file-indexer` 为每个节点生成 256 维 hash embedding（FNV-1a，零成本，无模型推理）
- 查询时：对 query 生成同样维度的 embedding，与图中节点做 cosine similarity
- 大仓库（≥200 候选节点）自动启用 HNSW ANN（hnswlib-node），10-100x 提速
- 小仓库使用线性扫描，避免 HNSW 构建开销
- 关键词检索 + 向量召回结果通过 RRF（Reciprocal Rank Fusion, k=60）融合

配置示例：

```json
{
  "graphPolicy": {
    "enableHnsw": true,
    "compression": {
      "enableGraphCompression": true,
      "enableAdaptiveBudget": true
    }
  },
  "embeddingPolicy": {
    "enabled": true,
    "provider": "hash",
    "topK": 8,
    "minSimilarity": 0.05
  }
}
```

查看当前压缩与路由状态：

```bash
npm run start -- route diagnose
```

### SQLite / FTS5 后端

```json
{
  "graphPolicy": {
    "transport": "sqlite",
    "graphStorePath": "tmp/graphflow-graph.sqlite",
    "maxContextTokens": 1500
  }
}
```

WAL + FTS5 全文索引；与 `file` / `memory` 接口一致。

### Episodic Memory + Reflection

```ts
const run = await orchestrate(
  { task: "refactor planner module and add tests" },
  { graphClient, enableEpisodicMemory: true, enableGraphContextInPrompt: true }
);
```

每次 task 写入 Episode（附带 embedding）；相似 task 注入历史决策（Jaccard + embedding RRF 融合检索）；`learn nightly` 合成 Lesson 节点；Lesson 自动注入后续任务的 planner prompt。

### 技能学习飞轮

- `applySkillLearning`：每次任务结束后提取技能原子，更新 Skill 节点 score（pass +1 / fail -1，bounded [-20,20]）
- `suggestSkillHints`：查询 Skill 节点，按 score/uses 排序，返回 top-N 技能提示
- 技能提示独立注入 worker prompt，不依赖图谱上下文是否启用
- 复合技能：技能对共现次数达阈值后自动创建 composite skill 节点

### 跨语言 AST 索引

| 语言 | 扩展 |
| --- | --- |
| TypeScript / JavaScript | `.ts .tsx .js .jsx` |
| Python | `.py` |
| Rust | `.rs` |
| Go | `.go` |
| C / C++ | `.c .h .cc .cpp .cxx .hpp .hxx` |
| Java | `.java` |
| Ruby | `.rb` |
| Kotlin | `.kt` |
| Swift | `.swift` |

通过 `graphPolicy.includeExtensions` 限制扫描范围。tree-sitter WASM 语法包在 `npm run build` 时打入 `wasm/` 并随 npm 包分发，安装后无需联网下载。

### Agent MCP 自动安装

GraphFlow CLI 可自动检测并安装 MCP 配置到 15+ 编码 Agent：

```bash
# 检测已安装的 Agent 与 MCP 配置状态
npx @roarpeng/graphflow doctor

# 一键安装 MCP + Skill + Cursor Rules（推荐）
npx @roarpeng/graphflow install

# 或仅初始化项目级配置（.graphflow/config.json 等）
npx @roarpeng/graphflow init
```

**本地 `npm install` 后**：若项目已有 `.cursor/mcp.json` 或 `.vscode/mcp.json`，postinstall 会自动注入 workspace 级 GraphFlow MCP 与 Skill；完整用户级安装请运行 `npx @roarpeng/graphflow install`。

支持的 Agent：Cursor、VS Code、Trae、Claude Code、Windsurf、Cline、Roo Code、Kilo Code、PearAI、Gemini、Codex、Antigravity、Amazon Q、Zed、Continue。

## 配置文件

默认：`graphflow.config.json`（也可使用 `~/.graphflow.config.json` 全局配置）。

```bash
cp graphflow.config.example.json graphflow.config.json
```

### 全局 vs 项目配置

| 层级 | 路径 | 适合存放 |
| --- | --- | --- |
| 全局 | `~/.graphflow.config.json` | Provider、API Key、Smart/Economy 模型、路由策略 |
| 项目根 | `graphflow.config.json` | 项目专属覆盖（可选） |
| 项目覆盖 | `.graphflow/config.json` | 工作区局部覆盖（`graphflow init` 生成） |

**多项目重要约定**：

- 图谱文件默认写在**当前工作区**下的 `graphflow-out/graphflow-graph.json`
- 全局配置**不应**包含固定的 `workspaceRoot`（旧版本若已写入，请删除该字段）
- MCP / 脚本可通过环境变量指定工作区：`GRAPHFLOW_WORKSPACE_ROOT=/path/to/project`

关键项：

| 配置 | 说明 |
| --- | --- |
| `graphPolicy.transport` | `file` / `memory` / `sqlite` / `mcp-http` |
| `graphPolicy.graphStorePath` | 相对当前工作区的 JSON 或 `.sqlite` 路径 |
| `graphPolicy.maxContextTokens` | 压缩上下文预算（默认 **1500**） |
| `graphPolicy.autoIndexOnSave` | 保存后增量索引（默认 **true**） |
| `graphPolicy.autoIndexOnPreview` / `autoIndexOnRun` | preview / run 前自动索引 |
| `graphPolicy.enableNearLosslessMode` | 近无损上下文打包 |
| `graphPolicy.enableHnsw` | HNSW ANN 加速（默认 **true**） |
| `graphPolicy.layerQuota` | L1/L2/L3 锚点配额 |
| `routingPolicy.enableDynamicRouting` | provider 健康路由 |
| `skillPolicy.enableSkillFlywheel` | 技能飞轮 |
| `embeddingPolicy.provider` | embedding 提供者（`hash` 零成本 / `openai`） |

## VS Code / Cursor 扩展

扩展内置 GraphFlow runtime，**安装 VSIX 后无需再 clone 本仓库或配置 `npm run start`**。

### 安装 VSIX（推荐）

1. 打开 [GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases)，下载最新 `graphflow-vscode-<version>.vsix`（CI 在每次 push `main` / tag 后自动构建）
2. **VS Code**：扩展视图 → `…` → **从 VSIX 安装…** → 选择下载的文件
3. **Cursor**：扩展视图 → 右上角 `…` → **Install from VSIX** → 选择下载的文件
4. 重启编辑器；首次激活会自动尝试安装 GraphFlow MCP 到本机 Agent 配置
5. 命令面板运行 **GraphFlow: Show Settings** → **建立图谱（无需 LLM）** → 即可使用 Context Preview / 知识图谱

CLI 安装（若已安装 `code` / `cursor` 命令）：

```bash
code --install-extension graphflow-vscode-1.4.2.vsix
# 或
cursor --install-extension graphflow-vscode-1.4.2.vsix
```

### 命令面板

| 命令 | 说明 |
| --- | --- |
| GraphFlow: Show Settings | 配置、建图、路由测试 |
| GraphFlow: Show Graph | **知识图谱可视化**（分层、搜索、跳转源码） |
| GraphFlow: Preview Context | 上下文压缩与 Token Budget |
| GraphFlow: Plan & Brainstorm | 任务规划 |
| GraphFlow: Run Task | 执行任务 |
| GraphFlow: Skill Insights | 技能学习面板 |
| GraphFlow: Install MCP | 注入 MCP 配置 |

Chat Agent（`@graphflow`）：`/run`、`/plan`、`/graph`、`/skills`、`/diagnose`、`/learn`、`/history`

### Settings 推荐流程

1. 填写 Graph Store Path → **Save Settings**
2. **建立图谱（无需 LLM）** → 生成结构图谱
3. （可选）配置 Provider → **测试路由并建立图谱**

其它建图入口：`graph index` CLI、MCP `graphflow_index`、`autoIndexOnPreview` / `autoIndexOnRun` / `autoIndexOnSave`

### 开发模式（贡献者）

```bash
cd vscode-extension
npm install
npm run build
```

在 VS Code 中 `F5` 启动 Extension Development Host。

### 本地打包 VSIX

```bash
npm run package:extension
# 输出：artifacts/graphflow-vscode-<version>.vsix
```

## 本地验收清单

1. `npm run ci` 全绿
2. `graph index` → `indexedFiles > 0`
3. `context preview` → `summary > 0` 且 `anchors > 0`
4. VS Code **Show Graph** → 画布正常显示节点聚类（非角落小点）
5. `plan` / `run` 返回正常输出
6. `route diagnose` → 显示 provider 路由状态

## 常见问题

**切换项目后 Snapshot 显示别的仓库的图谱**

- 检查 `~/.graphflow.config.json` 是否含有旧的 `workspaceRoot`，**删除该字段**后重载窗口
- 在当前项目重新「建立图谱」，确认顶栏 `store` 路径指向本项目的 `graphflow-out/`

**MCP 建图失败或索引到错误目录**

- `graphflow_index` 传入 `rootDir: "/你的项目绝对路径"`
- 或在 MCP 配置中加 `"env": { "GRAPHFLOW_WORKSPACE_ROOT": "/你的项目绝对路径" }`
- 离线环境索引多语言项目时，WASM 语法包已随 `@roarpeng/graphflow` 安装包内置，无需联网下载

**`context preview` 返回 0 anchors**

- 先执行 `graph index` 或 Settings 建图
- 检查查询词是否命中代码符号（如 `orchestrator`、`planner`）

**知识图谱面板空白或只有小点**

- 点击画布工具栏 **「适应」**
- 注意：画布展示的是**采样子图**（约 120 节点），全库规模请看顶栏统计

**API Key 未配置**

- 在 `graphflow.config.json` 配置 provider `apiKey`，支持 `${ENV_VAR}` 占位

**无 LLM 时能用吗**

- 可以：结构索引、图谱可视化、context preview（基于结构图谱 + hash embedding 向量召回）、MCP `graphflow_inspect_graph` 均不强制 LLM
- 只有 Six Hats 深度规划和 LLM 语义压缩需要配置 provider

## 项目结构

```text
GraphFlow/
├── src/
│   ├── core/           # 编排核心：orchestrator, triage, dag-engine, types
│   ├── graph/          # 索引、上下文切片、图压缩、snapshot
│   ├── routing/        # 模型路由与健康探测（openai/anthropic/bailian/doubao）
│   ├── learning/       # embeddings, episode, skill-flywheel, reflector, hnsw
│   └── surfaces/
│       ├── cli/        # CLI + runtime 子模块
│       └── mcp/        # MCP server (18 tools)
├── tests/              # 56 文件 / 249+ tests
├── vscode-extension/   # VS Code 面板与命令
├── docs/
└── CHANGELOG.md
```

## 版本与变更

- 变更日志：`CHANGELOG.md`
- License：Apache-2.0
