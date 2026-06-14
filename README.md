# GraphFlow

A Context-Aware Multi-Agent Orchestration Engine.

GraphFlow 是一个基于 TypeScript/Node.js 的多智能体编排引擎，将 **Graphify 式知识图谱** 与 **Superpowers 式任务编排** 整合为可本地运行的上下文层：自动建图、压缩检索、规划执行、经验沉淀，并通过 CLI、MCP 与 VS Code 扩展对外暴露。

## 当前能力总览（v0.6.13）

| 能力域 | 说明 |
| --- | --- |
| **任务编排** | 按任务复杂度分流 simple / complex；DAG 并行执行、校验、重试、集成轮 |
| **模型路由** | Smart / Economy 双 tier；多 provider 健康探测与 fallback（OpenAI、Anthropic、百炼、豆包、OpenBMB） |
| **知识图谱** | 工作区 AST 索引（TS/JS/Python/Rust/Go/C/C++）；File / Module / Symbol 节点 + 依赖/引用/定义边 |
| **上下文压缩** | L1/L2/L3 分层锚点；近无损打包；可选向量召回 + RRF 融合；默认 `maxContextTokens: 1500` |
| **持续建图** | 默认 `autoIndexOnSave`；preview / run 前按需增量索引（`hasPendingGraphIndexWork`） |
| **语义增强** | 可选 post-index LLM 语义 enrich；OpenBMB 本地 embedded 模式 |
| **学习飞轮** | Episodic Memory、Reflection、Skill 节点、nightly 学习、技能提示注入规划 |
| **Agent 接入** | CLI `--json`；MCP stdio（9 工具）；Cursor / Claude Code 规则与示例配置 |
| **VS Code 扩展** | Settings、建图、路由测试、Context Preview、**知识图谱可视化**、Skill Insights、Chat Agent |
| **存储后端** | `file`（JSON）/ `memory` / `sqlite`（FTS5）/ `mcp-http`（Graphify） |
| **工程质量** | TypeScript strict；**41 测试文件 / 177 tests**；`npm run ci` 含扩展 esbuild 打包与 bundled runtime smoke |

### 一句话总结

> 从 task 描述出发，自动规划 → 路由模型 → 压缩图谱上下文（含向量召回）→ 执行/校验/重试，并把经验沉淀回知识图谱；Coding Agent 通过 MCP/CLI 优先消费压缩上下文而非整库扫描。

### v0.6.7 – v0.6.13 近期演进

1. **知识图谱可视化（v0.6.12–0.6.13）**
   - 可读标签（文件名、符号名、目录组）、代码层 / 学习层 Tab
   - 暗色面板、目录聚类着色、关系线型、缩放/平移
   - 双击节点或「打开源文件」跳转源码行
   - 布局归一化修复大图谱「只剩角落小点」问题

2. **持续静默建图（v0.6.11）**
   - `autoIndexOnSave` 默认开启；保存文件后 debounce 增量索引
   - 旧配置 `maxContextTokens: 400` 自动升级到 1500

3. **Runtime 模块化与扩展打包（v0.6.10）**
   - `runtime/` 子模块 + `GraphFlowRuntimeModule` 类型校验
   - VS Code 扩展 esbuild 单文件 bundle

4. **配置与健壮性（v0.6.7–0.6.9）**
   - 全局配置优先（`~/.graphflow.config.json`）
   - 损坏 JSON 容错；postinstall 需显式 `GRAPHFLOW_ENABLE_POSTINSTALL=1`
   - 无工作区也可打开 Settings；CI 可复现 `npm ci`

5. **无 LLM 也能建图（v0.6.6 起）**
   - Settings「建立图谱（无需 LLM）」或 `graph index` 即可生成结构图谱
   - 可选「测试路由并建立图谱」在 LLM 连通后触发语义 enrich

### 发布信息

- 最新版本：**v0.6.13**（root + vscode-extension）；npm：`@roarpeng/graphflow@0.6.13`
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

预期：`lint` 无错误、`build` 成功、**177 tests** 通过、扩展 bundle 与 runtime smoke 通过。

## Agent 工具接入

GraphFlow 支持两种对外接入方式：

1. **CLI 机器输出**：核心命令均支持 `--json`
2. **MCP stdio server**：Cursor、Claude Code 等可直接调用

本仓库启动 MCP：

```bash
npm run start:mcp
```

### MCP 工具一览

| 工具 | 用途 |
| --- | --- |
| `graphflow_preview_context` | 压缩任务相关上下文（优先调用） |
| `graphflow_plan` | 多步任务分解 |
| `graphflow_run` | 执行编排循环 |
| `graphflow_index` / `graphflow_rebuild` | 增量 / 全量建图 |
| `graphflow_inspect_graph` | 图谱快照与统计 |
| `graphflow_enrich_graph` | 语义增强 |
| `graphflow_skill_insights` | 技能学习洞察 |
| `graphflow_diagnose` | 路由健康诊断 |
| `graphflow_model_download` | OpenBMB 模型下载 |

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

通过 `graphPolicy.includeExtensions` 限制扫描范围。

## 配置文件

默认：`graphflow.config.json`（也可使用 `~/.graphflow.config.json` 全局配置）。

```bash
cp graphflow.config.example.json graphflow.config.json
```

关键项：

| 配置 | 说明 |
| --- | --- |
| `graphPolicy.transport` | `file` / `memory` / `sqlite` / `mcp-http` |
| `graphPolicy.graphStorePath` | JSON 或 `.sqlite` 路径 |
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

正式测试文档：`docs/testing/2026-05-28-formal-usage-test-plan.md`

## 常见问题

**`context preview` 返回 0 anchors**

- 先执行 `graph index` 或 Settings 建图
- 检查查询词是否命中代码符号（如 `orchestrator`、`planner`）

**知识图谱面板空白或只有小点**

- 升级到 **v0.6.13+** 并重载窗口
- 点击画布工具栏 **「适应」**

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
├── tests/              # 41 文件 / 177 tests
├── vscode-extension/   # VS Code 面板与命令
├── docs/
└── CHANGELOG.md
```

## 版本与变更

- 变更日志：`CHANGELOG.md`
- License：Apache-2.0
