# GraphFlow

A Context-Aware Multi-Agent Orchestration Engine.

GraphFlow 是一个基于 TypeScript/Node.js 的多智能体编排引擎，当前版本聚焦于工程可用性：任务分流、DAG 执行、结果校验、图谱索引、近无损上下文压缩、CLI 与 VS Code 扩展联动。

## 当前进度（v0.1.0）

已完成并可用：

1. 简单/复杂任务自动分流（triage）。
2. 复杂任务编排链路：Planner -> DAG -> Worker -> Validator。
3. 任务级校验与重试机制。
4. 模型分层路由与 fallback。
5. 图谱增量同步与工作区索引。
6. 近无损上下文机制：summary + anchors + layer quota + refill。
7. CLI 命令：`run`、`context preview`、`graph index`。
8. VS Code 扩展已可调用工作区 CLI。
9. 学习飞轮基础能力（样本导出 + canary gate）。

发布信息：

1. GitHub Release: `v0.1.0`
2. VSIX 产物：`artifacts/graphflow-vscode-0.1.0.vsix`
3. 发布说明：`docs/releases/v0.1.0.md`

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
3. `vitest` 全量通过（当前应为 25 tests passed）

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
- `memory`：本地内存图谱（默认，适合本地调试）
- `mcp-http`：连接 Graphify MCP HTTP 服务
2. `graphPolicy.enableNearLosslessMode`
- 开启后启用近无损上下文打包
3. `graphPolicy.autoIndexOnPreview`
- `context preview` 前自动索引工作区
4. `graphPolicy.layerQuota`
- 控制 L1/L2/L3 锚点配额
5. `learningPolicy.exportPath`
- 学习样本导出路径

## 本地测试验收清单

你可以按下面清单判断“本地可用”：

1. 质量门禁通过：`npm run lint && npm run build && npm test`
2. `graph index` 返回 `indexedFiles > 0`
3. `context preview` 返回 `summary > 0` 且 `anchors > 0`
4. `run "..."` 能返回正常执行输出

## VS Code 扩展本地试用

### 方式 A：安装已打包 VSIX

```bash
code --install-extension artifacts/graphflow-vscode-0.1.0.vsix
```

安装后可在命令面板执行：

1. `GraphFlow: Run Task`
2. `GraphFlow: Show Runs`

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
2. 发布文档：`docs/releases/v0.1.0.md`
3. License：`LICENSE`
