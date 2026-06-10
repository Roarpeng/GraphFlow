# GraphFlow VS Code Extension

GraphFlow VS Code 扩展用于在编辑器内快速触发 GraphFlow CLI 任务执行，并查看运行历史。

从 `0.3.0` 起，扩展已内置 GraphFlow runtime，安装后不再依赖工作区存在 GraphFlow 源码或 `npm run start` 命令。

从 `0.6.0` 起，扩展在首次安装/升级时会自动嗅探本机 Agent 工具（Cursor、VS Code、Trae、Claude Code、Windsurf），并将 GraphFlow MCP 写入对应配置；安装完成后会提示如何配置模型。

支持两种触发方式：

1. 命令面板触发
2. Agent 对话框触发（`@graphflow`）

## 当前版本

1. Extension: `0.6.0`
2. 对应 VSIX: `../artifacts/graphflow-vscode-0.6.0.vsix`
3. 依赖：扩展内置 GraphFlow runtime（默认）

## 功能命令

1. `GraphFlow: Run Task`
2. `GraphFlow: Show Runs`
3. `GraphFlow: Plan & Brainstorm`
4. `GraphFlow: Graph Snapshot`
5. `GraphFlow: Skill Insights`
6. `GraphFlow: Install MCP to Agents`（手动重试 MCP 自动安装）
7. `GraphFlow: Model Setup Guide`（查看模型配置说明）
8. `GraphFlow: Settings`（图形化配置 provider / 模型 / token 预算）

## 安装后配置模型（推荐流程）

1. 安装 VSIX 后重启 VS Code，等待弹窗 `GraphFlow MCP 已安装到: ...`
2. 点击 **配置模型**，或运行 `GraphFlow: Settings`
3. 选择 provider，填写 API Key 环境变量名与 Base URL（如 DeepSeek: `https://api.deepseek.com`）
4. 设置 `smart` / `economy` 模型名（规划用强模型，执行用快模型）
5. 保存后重启 Cursor / Claude Code 等 Agent 工具，使 MCP 生效
6. 在 Agent 对话框验证：`使用 graphflow 预览 orchestrator 相关上下文`

可选本地语义增强：

1. `GraphFlow: Download MiniCPM Model`
2. `GraphFlow: Enrich Graph Semantics`

其中：

1. `Graph Snapshot` 面板支持节点搜索、类型过滤、节点聚焦、关系高亮
2. `Skill Insights` 面板支持技能搜索、结果筛选、按分数/使用次数/更新时间排序

## Agent 对话框触发

在 Chat / Agent 对话框中选择 `@graphflow`，支持：

1. `/run <task>`
- 示例：`/run update readme and add tests`
2. `/plan <task>`
- 示例：`/plan refactor architecture and add tests`
3. `/history`
- 查看最近运行记录
4. `/diagnose`
- 查看动态路由健康与分发结果
5. `/learn`
- 触发 nightly 学习并返回摘要
6. `/graph`
- 输出图谱快照（节点/边规模、类型分布、关系统计）
7. `/skills`
- 输出技能飞轮 Top 技能洞察

## 本地测试前置条件

在仓库根目录先完成基础构建：

```bash
npm install
npm run build
```

建议额外验证：

```bash
npm test
```

## 给同事分发

可以，直接把 VSIX 文件发给同事安装即可：

1. `artifacts/graphflow-vscode-0.6.0.vsix`
2. 安装命令：`code --install-extension artifacts/graphflow-vscode-0.6.0.vsix`

同事本地不需要拉取 GraphFlow 仓库代码。

## 方式 A：安装 VSIX 测试

在仓库根目录执行：

```bash
code --install-extension artifacts/graphflow-vscode-0.6.0.vsix
```

然后重启 VS Code，在命令面板执行：

1. `GraphFlow: Run Task`
2. `GraphFlow: Show Runs`
3. `GraphFlow: Plan & Brainstorm`
4. `GraphFlow: Graph Snapshot`
5. `GraphFlow: Skill Insights`

## 方式 B：开发模式联调（推荐）

在本目录执行：

```bash
npm install
npm run build
```

在 VS Code 中按 `F5` 启动 Extension Development Host，之后在新窗口命令面板测试：

1. `GraphFlow: Run Task`
2. `GraphFlow: Show Runs`
3. `GraphFlow: Plan & Brainstorm`
4. `GraphFlow: Graph Snapshot`
5. `GraphFlow: Skill Insights`

## 打包扩展

在本目录执行：

```bash
npm run package
```

默认输出：

`../artifacts/graphflow-vscode-0.6.0.vsix`

## 扩展图标

当前扩展图标路径：

1. `media/graphflow.png`（Marketplace / 扩展清单使用）
2. `media/graphflow.ico`（Windows 兼容资产）

如需重新生成图标，可在本目录执行：

```bash
npm run icon:generate
```

该命令会执行：`scripts/generate-icon.ps1`，并覆盖 `media/graphflow.png` 与 `media/graphflow.ico`。

## 验收标准

满足以下条件即可判定扩展本地可用：

1. 命令面板可看到 `GraphFlow: Run Task`、`GraphFlow: Show Runs`、`GraphFlow: Plan & Brainstorm`、`GraphFlow: Graph Snapshot`、`GraphFlow: Skill Insights`
2. `Run Task` 可触发并返回任务执行结果
3. `Show Runs` 可查看本次会话运行记录
4. `Plan & Brainstorm` 可展示 `mode`、`ideas`、`plan` 三段输出
5. Agent 对话框中 `@graphflow /run`、`/plan`、`/history`、`/diagnose`、`/learn`、`/graph`、`/skills` 可正常返回
6. 控制台无阻断级错误

## 最小环境要求（仅安装插件使用）

1. VS Code 版本满足扩展引擎要求（`^1.99.0`）
2. 本地可打开任意文件夹作为工作区
3. 无需额外安装 GraphFlow 仓库依赖

可选：若需要真实模型调用，请在工作区 `graphflow.config.json` 中配置 provider apiKey。

## 常见问题

1. 命令执行失败或无输出
- 确认仓库根目录 `npm run build` 已通过
- 确认根目录 CLI 可执行：`npm run start -- run "health check"`

2. VSIX 安装后命令不可见
- 重启 VS Code
- 在扩展列表确认 GraphFlow 已启用

3. 打包时报输出路径不存在
- 先创建根目录 `artifacts/` 目录后再执行 `npm run package`
