# GraphFlow

A Context-Aware Multi-Agent Orchestration Engine.

GraphFlow 是一个基于 TypeScript/Node.js 的多智能体编排引擎，当前版本聚焦于工程可用性：任务分流、DAG 执行、结果校验、图谱索引、近无损上下文压缩、CLI 与 VS Code 扩展联动。

## 当前进度（v0.3.0 + main）

已完成并可用：

1. 简单/复杂任务自动分流（triage）。
2. 复杂任务编排链路：Brainstorm -> Planner -> DAG -> Worker -> Validator，并支持 LLM 驱动变体（`enableLlmAgents`）。
3. 任务级需求对账校验、重试机制，以及失败后 mid-DAG 漂移重规划（`enableDriftReplan`）。
4. 模型分层路由与 provider fallback（OpenAI / Anthropic / 百炼 / 豆包）。
5. 工作区 AST 索引：基于 TypeScript Compiler API 提取 function/class/interface/type/enum/variable/method 节点 + 跨文件 `references` 边。
6. 知识图谱真正注入 prompt：summary + skill hints 作为结构化上下文块送入 planner / brainstormer / worker / validator（`enableGraphContextInPrompt`）。
7. 节点压缩：Symbol content 改为签名行（约 1.76× 字节缩减），元数据迁到 `metadata` 字段。
8. 真 tokenizer（gpt-tokenizer / o200k_base）替代 `length/4` 估算，token 预算更准确。
9. 检索升级：倒排索引 keyword 查询、邻接表、`getNodesByIds`、`getNeighbors`、`expandSubgraph` k-hop BFS 沿 `references/imports/depends_on/prerequisite` 扩展上下文。
10. 学习飞轮 + 技能融合：技能抽取、score/uses、co_occurs 边，以及当 A+B 共现 ≥2 次且成功 ≥2 次时合成复合技能 C 并写 `prerequisite` 边；`suggestSkillHints` 优先返回融合技能。
11. CLI 命令：`run`、`plan`、`route diagnose`、`learn nightly`、`context preview`、`graph index`、`graph inspect`、`skill insights`，全部支持 `--json`。
12. MCP stdio server（`graphflow-mcp` bin）暴露 7 个工具，可被 Cursor / Claude Code / Claude Desktop / Codex / Aider 等直接调用。
13. VS Code 扩展内置 runtime + `@graphflow` chat（`/run`、`/plan`、`/history`、`/diagnose`、`/learn`、`/graph`、`/skills`）+ 图谱快照与技能洞察面板。
14. SQLite/FTS5 图谱后端：`transport: "sqlite"`、WAL+FTS5 全文索引、边表 PK+三索引、邻居查询 O(度)。
15. 向量召回 + RRF 双路融合：`enableVectorRecall` + `embeddingProvider`；hash embedding 默认供应商零依赖，可丝滑切换到 OpenAI text-embedding-3-small。
16. Episodic Memory + Reflection：Episode 节点记录每次 task 轨迹，复现相似 task 时注入历史决策；nightly reflector 集类成功 episode 合成 Lesson 节点。
17. 跨语言 AST 索引：TypeScript / JavaScript / Python / Rust / Go / C / C++；统一输出 Symbol / Module / imports / defines / references 边，后续图谱 / prompt 注入 / episode 检索透明复用。

发布信息：

1. GitHub Release: `v0.3.0`
2. VSIX 产物：`artifacts/graphflow-vscode-0.3.0.vsix`
3. 发布说明：`docs/releases/v0.3.0.md`
4. 正式测试报告：`docs/testing/2026-05-28-formal-usage-test-report.md`

## 环境要求

1. Node.js >= 20
2. npm >= 10
3. Windows / macOS / Linux 均可

## 5 分钟本地试跑（推荐）

在仓库根目录执行：

```bash
npm install
npm run lint
npm run build
npm test
```

预期结果：

1. `lint` 无错误
2. `build` 成功
3. `vitest` 全量通过（当前应为 95 tests / 25 files passed）

可选一键 CI 本地校验：

```bash
npm run ci
```

## Agent 工具接入

GraphFlow 已支持两种对外接入方式：

1. CLI 机器输出：所有核心命令支持 `--json`
2. MCP stdio server：可被 Cursor、Claude Code 等支持 MCP 的 agent 直接调用

本仓库内直接启动 MCP server：

```bash
npm run start:mcp
```

CLI 结构化输出示例：

```bash
npm run start -- plan "refactor planner and add tests" --json
```

CLI 标准帮助与版本：

```bash
npm run start -- --help
npm run start -- --version
```

外部 agent 约定文件：

1. `AGENTS.md`
2. `CLAUDE.md`
3. `.cursor/rules/graphflow.mdc`
4. `docs/integrations/cursor.mcp.json`
5. `docs/integrations/claude-code.mcp.json`
6. `docs/integrations/claude-desktop-config.json`

## 本地功能验证（CLI）

### 1) 图谱索引

```bash
npm run start -- graph index .
```

预期输出示例：

```text
indexedFiles=52; indexedSymbols=98
```

### 2) 上下文压缩预览

```bash
npm run start -- context preview "orchestrator"
```

预期输出示例：

```text
summary=6; anchors=6; tokens=98; truncated=false; L1=3; L2=2; L3=1
```

### 3) 执行任务

```bash
npm run start -- run "update readme and add tests"
```

说明：该命令会根据任务复杂度自动走 simple 或 complex 工作流。

### 4) 规划与头脑风暴

```bash
npm run start -- plan "update readme and add tests and refactor architecture module"
```

预期输出示例：

```text
mode=complex; ideas=...; plan=task-1... | task-2... | task-3...
```

### 5) 动态路由诊断

```bash
npm run start -- route diagnose
```

预期输出示例：

```text
dynamicRouting=on; health=openai:true,...; planner=openai/...; worker=openai/...
```

### 6) 学习夜跑

```bash
npm run start -- learn nightly
```

预期输出示例：

```text
events=12; passRate=0.833; avgTokens=118.0; canary=allow; dataset=tmp/learning-dataset.jsonl
```

### 7) 图谱快照洞察

```bash
npm run start -- graph inspect
```

预期输出示例：

```text
nodes=120; edges=184; types=File:20,Symbol:54,...; relations=defines:44,imports:20,...
```

### 8) 技能洞察

```bash
npm run start -- skill insights
```

预期输出示例：

```text
source=graph-store; transport=file; count=8; top=add tests:4/6,refactor planner:3/4
```

## 配置文件

默认使用根目录 `graphflow.config.json`。

首次使用建议从模板复制：

Windows CMD:

```bash
copy graphflow.config.example.json graphflow.config.json
```

PowerShell / macOS / Linux:

```bash
cp graphflow.config.example.json graphflow.config.json
```

关键配置：

1. `graphPolicy.transport`
- `file`：本地持久化图谱（默认，适合正式使用测试）
- `memory`：本地内存图谱（适合轻量调试）
- `mcp-http`：连接 Graphify MCP HTTP 服务
2. `graphPolicy.graphStorePath`
- `file` transport 的图谱存储路径
2. `graphPolicy.enableNearLosslessMode`
- 开启后启用近无损上下文打包
3. `graphPolicy.autoIndexOnPreview`
- `context preview` 前自动索引工作区
4. `graphPolicy.autoIndexOnRun`
- `run` 前自动索引工作区
5. `graphPolicy.layerQuota`
- 控制 L1/L2/L3 锚点配额
6. `learningPolicy.exportPath`
- 学习样本导出路径
7. `learningPolicy.eventsPath`
- 运行反馈事件日志路径（用于 nightly 学习）
8. `learningPolicy.summaryPath`
- 学习汇总指标路径
9. `routingPolicy.enableDynamicRouting`
- 启用按 provider 健康状态的自动路由
10. `routingPolicy.requireApiKeyForHealthy`
- 若开启，缺少 apiKey 的 provider 会被标记为不健康并触发 fallback
11. `routingPolicy.providerPriority`
- 设置 fallback 优先级，例如 `["anthropic", "openai", "bailian", "doubao"]`
12. `skillPolicy.enableSkillFlywheel`
- 开启技能飞轮（技能抽取、技能连接、技能提示复用）
13. `skillPolicy.maxSkillHints`
- 每次规划注入的技能提示上限

## 本地测试验收清单

你可以按下面清单判断“本地可用”：

1. 质量门禁通过：`npm run lint && npm run build && npm test`
2. `graph index` 返回 `indexedFiles > 0`
3. `context preview` 返回 `summary > 0` 且 `anchors > 0`
4. `run "..."` 能返回正常执行输出
5. `plan "..."` 返回 `mode=...; ideas=...; plan=...`

## 正式使用测试

正式使用测试脚本（含通过标准）见：

1. `docs/testing/2026-05-28-formal-usage-test-plan.md`
2. `docs/testing/2026-05-28-formal-usage-test-report.md`

## VS Code 扩展本地试用

### 方式 A：安装已打包 VSIX

```bash
code --install-extension artifacts/graphflow-vscode-0.3.0.vsix
```

安装后可在命令面板执行：

1. `GraphFlow: Run Task`
2. `GraphFlow: Show Runs`
3. `GraphFlow: Plan & Brainstorm`
4. `GraphFlow: Graph Snapshot`
5. `GraphFlow: Skill Insights`

并可在 Agent 对话框通过 `@graphflow` 使用：

1. `/run <task>`
2. `/plan <task>`
3. `/history`
4. `/diagnose`
5. `/learn`
6. `/graph`
7. `/skills`

分发给同事：

1. 直接发送 `artifacts/graphflow-vscode-0.3.0.vsix`
2. 同事执行 `code --install-extension artifacts/graphflow-vscode-0.3.0.vsix`
3. 不需要克隆 GraphFlow 仓库即可使用插件核心能力

### 方式 B：开发模式运行扩展

```bash
cd vscode-extension
npm install
npm run build
```

然后在 VS Code 中按 `F5` 启动 Extension Development Host 进行联调。

## 常见问题

1. `context preview` 返回 0 anchors
- 先执行 `npm run start -- graph index .`
- 检查查询词是否命中现有代码符号（例如 `orchestrator`, `runtime`, `planner`）

2. 扩展打包产物不存在
- 确认目录 `artifacts/` 已存在
- 在 `vscode-extension` 目录执行 `npm run package`

3. API Key 未配置导致模型调用失败
- 在 `graphflow.config.json` 中配置对应 provider 的 `apiKey`
- `graphflow.config.json` 与示例模板支持 `${ENV_VAR}` 环境变量占位写法

## 项目结构（简版）

```text
GraphFlow/
├── src/
│   ├── core/
│   ├── graph/
│   ├── routing/
│   ├── learning/
│   └── surfaces/cli/
├── tests/
├── docs/releases/
├── vscode-extension/
└── artifacts/
```

## 版本与变更

1. 变更日志：`CHANGELOG.md`
2. 发布文档：`docs/releases/v0.3.0.md`
3. License：`LICENSE`
