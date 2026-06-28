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

接好后让 agent 优先调用 `graphflow_preview_context` 取压缩上下文；多步任务用 `graphflow_plan`。配置 provider API key 是**可选**的——只在需要语义压缩 / 规划增强时才用。

> 可复现的 token 节省基准见 [`benchmarks/RESULTS.md`](benchmarks/RESULTS.md)。

## 为什么选 GraphFlow（与同类对比）

这个赛道里有很多优秀的单点工具，GraphFlow 的定位不是"某一项最强"，而是**在代码图谱之上叠加了上下文压缩、规划编排与跨会话学习记忆**——尤其是"记忆型代码图谱"这一块目前少有人占据。诚实对比如下：

| 维度 | **GraphFlow** | CodeGraph | Serena | Repomix |
| --- | --- | --- | --- | --- |
| 结构代码图谱 | ✅ 多语言 AST 图谱 | ✅ 更成熟（★ 更高） | ⚠️ LSP 符号（非全图谱） | ❌ |
| 上下文压缩 | ✅ 三层渐进（结构+向量+语义） | ⚠️ 图查询为主 | ⚠️ 符号级精修 | ✅ 整库打包（无压缩） |
| 规划编排 | ✅ DAG / 六顶思考帽 | ❌ | ❌ | ❌ |
| **跨会话学习记忆** | ✅ Episodic / Skill / Decision 节点 | ❌ | ❌ | ❌ |
| Local-first | ✅ | ✅ | ✅ | ✅ |
| 许可 | Apache-2.0 | MIT | MIT | 宽松开源 |

> 实话实说：论纯图谱的成熟度与社区规模，CodeGraph 更领先；论 LSP 符号编辑标准，Serena 更专精；论整库打包，Repomix 更简单。GraphFlow 的价值在于把"图谱 + 压缩 + 规划 + 学习记忆"合到一处，让 agent 不仅省 token，还能跨会话复用项目经验。

## 当前能力总览（v1.0.0+）

| 能力域 | 说明 |
| --- | --- |
| **任务规划与移交** | 按任务复杂度分流 simple / complex；DAG 规划；`graphflow_plan_insight` 六顶思考帽 + 5-Why 深度分析；默认 **bridge 模式**输出结构化任务描述符交给外部 coding agent 执行 |
| **模型路由** | Smart / Economy 双 tier；多 provider 健康探测与 fallback（OpenAI、Anthropic、百炼、豆包、OpenBMB） |
| **知识图谱** | 工作区 AST 索引（TS/JS/Python/Rust/Go/C/C++/Java/Ruby/Kotlin/Swift）；File / Module / Symbol 节点 + 依赖/引用/定义边；图谱 artifact 导入/导出 |
| **上下文压缩** | L1/L2/L3 分层锚点；近无损打包；图结构压缩（边权重+PageRank，零成本默认开启）；可选语义压缩（minicpm/economy LLM 聚类合并）；向量召回 + RRF + HNSW；RepoMap 概览；自适应预算 |
| **持续建图** | 默认 `autoIndexOnSave`；preview / run 前按需增量索引（`hasPendingGraphIndexWork`）；MCP `graphflow_index_file` 单文件增量 |
| **语义增强** | 可选 post-index LLM 语义 enrich；OpenBMB 本地 embedded 模式 |
| **学习飞轮** | Episodic Memory、Reflection、Skill 节点、nightly 学习、技能提示注入规划 |
| **可观测性** | `graphflow_stats` 累计 token 节省；`graphflow_metrics` Prometheus 指标；VS Code 知识图谱 Snapshot |
| **Agent 接入** | CLI `--json`；MCP stdio（**20 工具**）；Cursor / Claude Code 规则与示例配置 |
| **VS Code 扩展** | Settings、建图、路由测试、Context Preview、**知识图谱可视化**、Skill Insights、Chat Agent、一键安装 MCP |
| **存储后端** | `file`（JSON）/ `memory` / `sqlite`（FTS5）/ `mcp-http`（Graphify） |
| **多项目隔离** | 全局配置共享 LLM/路由；**图谱路径按当前工作区解析**，不再串读其它项目的 `graphflow-out` |
| **工程质量** | TypeScript strict；**62 测试文件 / 280+ tests**；`npm run ci` 含扩展 esbuild 打包与 bundled runtime smoke |

### 一句话总结

> 从 task 描述出发，自动规划 → 路由模型 → 压缩图谱上下文（含向量召回）→ **输出结构化执行描述符交给外部 coding agent**，并把经验沉淀回知识图谱；定位为 **上下文与规划服务（context service）**，而非独立执行器。

### v1.0.0 核心（2026-06）

- **诚实执行语义（bridge 模式）**：`graphflow_run` 规划 + 压缩上下文后输出 `executionDescriptor`，交给 Cursor / Claude Code 等外部 agent 执行，不再伪造 `COMPLETED`。
- **三层渐进压缩**：图结构压缩（默认零成本）→ 向量召回 + HNSW → 可选语义压缩（economy / minicpm）。
- **混合压缩模型**：`compressor` 角色默认继承 economy tier；纯离线时首次按需下载 minicpm GGUF。

### 最新更新（v1.0.x / main）

1. **多项目图谱隔离**
   - 全局配置（`~/.graphflow.config.json`）只保存 LLM、路由等**机器级**设置，**不再持久化 `workspaceRoot`**
   - 运行时按 `process.cwd()` 或 `GRAPHFLOW_WORKSPACE_ROOT` 解析 `graphflow-out/graphflow-graph.json`
   - 修复：切换项目后 Snapshot / MCP 仍显示旧项目图谱的问题

2. **索引与语言扩展**
   - 新增 **Java**（`.java`）、**Ruby**（`.rb`）tree-sitter 索引器
   - C/C++、Rust 索引器增强；WASM 语法包随 npm 包离线分发（构建时 `npm run wasm:bundle` 打入 `wasm/`）
   - MCP 新增 `graphflow_index_file` 单文件增量索引

3. **MCP 工具扩展（9 → 18）**
   - `graphflow_plan_insight`：六顶思考帽 + 5-Why 深度规划
   - `graphflow_export_artifact` / `graphflow_import_artifact`：图谱压缩包导入导出
   - `graphflow_stats`：累计 token 节省统计
   - `graphflow_metrics`：Prometheus 格式可观测性指标
   - `graphflow_report_outcome` / `graphflow_expand_anchor`：结果回传与锚点扩展

4. **知识图谱可视化（延续 v0.6.12+）**
   - 可读标签、代码层/学习层 Tab、目录聚类、缩放平移、跳转源码
   - Snapshot 为**采样视图**（默认约 120 节点 / 200 边），顶栏显示全库真实规模

5. **配置与工程**
   - 全局配置优先；损坏 JSON 容错；CI 全链路 validate + VSIX 打包
   - Settings「建立图谱（无需 LLM）」或 `graph index` 即可生成结构图谱

### 历史演进（v0.6.7 – v0.6.13 摘要）

- v0.6.12–0.6.13：知识图谱面板、布局归一化、Snapshot 可读标签
- v0.6.11：`autoIndexOnSave` 默认开启；`maxContextTokens` 400 → 1500 自动升级
- v0.6.10：runtime 模块化、VS Code esbuild bundle
- v0.6.7–0.6.9：全局配置脚手架、无工作区也可打开 Settings

### 发布信息

- 最新版本：**v1.3.0**（root + vscode-extension）；npm：`@roarpeng/graphflow@1.3.0`
- **GitHub Release**：push 到 `main` 且 CI 通过后自动发布 VSIX（见 [Actions](https://github.com/Roarpeng/GraphFlow/actions)）
- 变更日志：`CHANGELOG.md`

## 环境要求

1. Node.js >= 20
2. npm >= 10
3. Windows / macOS / Linux 均可

## 5 分钟本地试跑

```bash
npm install
npm run ci
```

预期：`lint` 无错误、`build` 成功、**280+ tests** 通过、扩展 bundle 与 runtime smoke 通过。

## Agent 工具接入

GraphFlow 支持两种对外接入方式：

1. **CLI 机器输出**：核心命令均支持 `--json`
2. **MCP stdio server**：Cursor、Claude Code 等可直接调用

本仓库启动 MCP：

```bash
npm run start:mcp
```

### MCP 工具一览（20 个）

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
| `graphflow_enrich_graph` | 符号节点语义增强 |
| `graphflow_skill_insights` | 技能学习洞察 |
| `graphflow_diagnose` | 路由与压缩模型健康诊断 |
| `graphflow_model_download` | OpenBMB / minicpm 模型下载 |
| `graphflow_export_artifact` | 导出压缩图谱 artifact |
| `graphflow_import_artifact` | 导入图谱 artifact |
| `graphflow_stats` | 累计 token 节省 ROI 统计 |
| `graphflow_metrics` | Prometheus 格式运行指标 |

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

外部 agent 约定文件：`AGENTS.md`、`CLAUDE.md`、`.cursor/rules/graphflow.mdc`、`docs/integrations/*.json`

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

### 上下文压缩（v1.0 核心）

GraphFlow 的压缩采用「三层渐进」策略，先用零成本图结构压缩砍掉冗余节点，再按需用 LLM 做语义合并：

| 层 | 机制 | 成本 | 默认 |
| --- | --- | --- | --- |
| 图结构压缩 | 边权重连通子图 + PageRank 中心性重排 | 零 LLM | **开启** |
| 向量召回 | embedding + RRF 融合；候选 ≥200 自动用 HNSW ANN | 零 LLM | 配 embedding 时开启 |
| 语义压缩 | minicpm/economy LLM 聚类合并相似节点 + 长节点改写 | LLM | opt-in |
| RepoMap 概览 | 预算紧张时返回模块级地图 | 零 LLM | opt-in |
| 自适应预算 | 按任务复杂度动态调整 token 预算 | 零 LLM | opt-in |

**压缩模型策略（零额外配置）**：压缩复用 economy tier——

- 配了外部 provider（OpenAI/Anthropic/百炼）→ 自动用其 economy 模型（如 `gpt-4.1-mini`）
- 纯离线无外部 LLM → 自动回退内嵌 minicpm，**首次使用按需下载** GGUF 到 `~/.graphflow/models/`（约 650MB，仅一次）

配置示例：

```json
{
  "graphPolicy": {
    "compression": {
      "enabled": true,
      "backend": "inherit",
      "enableGraphCompression": true,
      "enableHnsw": true,
      "enableRepoMapFallback": false,
      "enableAdaptiveBudget": false,
      "autoDownloadEmbedded": true
    }
  }
}
```

查看当前压缩模型来源：

```bash
npm run start -- route diagnose
# 输出含：compression=inherit:openai/gpt-4.1-mini
```

**HNSW 加速（可选依赖）**：大仓库（候选 ≥200 节点）向量召回自动使用 HNSW ANN（10~100x 提速）。需安装可选依赖：

```bash
npm install hnswlib-node   # 未安装时自动降级线性扫描，不影响功能
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

### 向量召回 + RRF 融合

```ts
import { createHashEmbeddingProvider } from "graphflow/dist/learning/embeddings";

const pkg = await buildLayeredContextPackage(client, query, {
  enableVectorRecall: true,
  embeddingProvider: createHashEmbeddingProvider(),
  vectorTopK: 8,
});
```

### Episodic Memory + Reflection

```ts
const run = await orchestrate(
  { task: "refactor planner module and add tests" },
  { graphClient, enableEpisodicMemory: true, enableGraphContextInPrompt: true }
);
```

每次 task 写入 Episode；相似 task 注入历史决策；`learn nightly` 合成 Lesson 节点。

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

通过 `graphPolicy.includeExtensions` 限制扫描范围。tree-sitter WASM 语法包在 `npm run build` 时打入 `wasm/` 并随 npm 包分发，安装后无需联网下载。

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
| `graphPolicy.layerQuota` | L1/L2/L3 锚点配额 |
| `routingPolicy.enableDynamicRouting` | provider 健康路由 |
| `skillPolicy.enableSkillFlywheel` | 技能飞轮 |

## VS Code 扩展

### 命令面板

| 命令 | 说明 |
| --- | --- |
| GraphFlow: Show Settings | 配置、建图、路由测试 |
| GraphFlow: Show Graph | **知识图谱可视化**（分层、搜索、跳转源码） |
| GraphFlow: Preview Context | 上下文压缩与 Token Budget |
| GraphFlow: Plan & Brainstorm | 任务规划 |
| GraphFlow: Run Task | 执行任务 |
| GraphFlow: Skill Insights | 技能学习面板 |
| GraphFlow: Enrich Graph | 语义增强 |
| GraphFlow: Install MCP | 注入 MCP 配置 |

Chat Agent（`@graphflow`）：`/run`、`/plan`、`/graph`、`/skills`、`/diagnose`、`/learn`、`/history`

### Settings 推荐流程

1. 填写 Graph Store Path → **Save Settings**
2. **建立图谱（无需 LLM）** → 生成结构图谱
3. （可选）配置 Provider → **测试路由并建立图谱** → 语义 enrich

其它建图入口：`graph index` CLI、MCP `graphflow_index`、`autoIndexOnPreview` / `autoIndexOnRun` / `autoIndexOnSave`

### 开发模式

```bash
cd vscode-extension
npm install
npm run build
```

在 VS Code 中 `F5` 启动 Extension Development Host。

### 安装 VSIX

从 [GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases) 下载最新 VSIX，或本地：

```bash
cd vscode-extension && npm run package
code --install-extension artifacts/graphflow-vscode-*.vsix
```

## 本地验收清单

1. `npm run ci` 全绿
2. `graph index` → `indexedFiles > 0`
3. `context preview` → `summary > 0` 且 `anchors > 0`
4. VS Code **Show Graph** → 画布正常显示节点聚类（非角落小点）
5. `plan` / `run` 返回正常输出
6. `route diagnose` → 显示 `compression=<backend>:<provider>/<model>`

## 常见问题

**切换项目后 Snapshot 显示别的仓库的图谱**

- 检查 `~/.graphflow.config.json` 是否含有旧的 `workspaceRoot`，**删除该字段**后重载窗口
- 在当前项目重新「建立图谱」，确认顶栏 `store` 路径指向本项目的 `graphflow-out/`
- 使用 v1.0.x 最新版（已修复全局 `workspaceRoot` 串项目问题）

**MCP 建图失败或索引到错误目录**

- `graphflow_index` 传入 `rootDir: "/你的项目绝对路径"`
- 或在 MCP 配置中加 `"env": { "GRAPHFLOW_WORKSPACE_ROOT": "/你的项目绝对路径" }`
- 离线环境索引多语言项目时，WASM 语法包已随 `@roarpeng/graphflow` 安装包内置，无需联网下载

**`context preview` 返回 0 anchors**

- 先执行 `graph index` 或 Settings 建图
- 检查查询词是否命中代码符号（如 `orchestrator`、`planner`）

**知识图谱面板空白或只有小点**

- 升级到 **v1.0.0+** 并重载窗口
- 点击画布工具栏 **「适应」**
- 注意：画布展示的是**采样子图**（约 120 节点），全库规模请看顶栏统计

**API Key 未配置**

- 在 `graphflow.config.json` 配置 provider `apiKey`，支持 `${ENV_VAR}` 占位

**无 LLM 时能用吗**

- 可以：结构索引、图谱可视化、context preview（基于结构图谱）、MCP `graphflow_inspect_graph` 均不强制 LLM

## 项目结构

```text
GraphFlow/
├── src/
│   ├── core/           # 编排核心类型
│   ├── graph/          # 索引、上下文切片、snapshot-view
│   ├── routing/        # 模型路由与健康探测
│   ├── learning/       # 向量、episode、skill
│   └── surfaces/
│       ├── cli/        # CLI + runtime 子模块
│       └── mcp/        # MCP server
├── tests/              # 62 文件 / 280+ tests
├── vscode-extension/   # VS Code 面板与命令
├── docs/
└── CHANGELOG.md
```

## 版本与变更

- 变更日志：`CHANGELOG.md`
- License：Apache-2.0

## 自动优化记录

### 2026-06-27 11:55
- **改进内容**：修复 Windows 上 GraphifyFileClient 文件重命名偶发 EPERM 错误（增加5次重试机制）；修复 m52 技能层测试超时问题（超时时间从15秒延长至30秒）；修复自动优化脚本的北京时间显示错误（使用 formatBeijingTime 替代 toISOString）
- **涉及文件**：`src/graph/graphify-file-client.ts`、`tests/m52-skill-layer.test.ts`、`scripts/auto-optimize.js`
- **分析来源**：GraphFlow + ESLint 自动化分析
- **测试结果**：m10（9/9 通过）、m52（7/7 通过）
