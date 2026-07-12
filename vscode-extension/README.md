# GraphFlow VS Code Extension

GraphFlow 编辑器扩展：在 VS Code / Cursor 内建图、压缩上下文、任务规划、知识图谱可视化，并一键安装 GraphFlow MCP。

扩展**内置 GraphFlow runtime**（v1.4+），安装 VSIX 后**不需要**工作区存在 GraphFlow 源码，也**不需要**运行 `npm run start`。

## 当前版本

- Extension / runtime：**1.7.1**
- 对应 VSIX：`../artifacts/graphflow-vscode-1.7.1.vsix`（CI 构建）或 [GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases)

### v1.7.1 要点

- **Embedding 韧性**：扩展 vendor 不捆绑 `@xenova/transformers`；缺失或 HF 不可达时自动降级到 `fnv1a-384` hash，不再刷 `ERR_MODULE_NOT_FOUND`
- **检索降噪**：架构类查询降低 `vscode-extension` / `vendor` / `node_modules` 权重，优先 `src/graph`、`src/core` 等
- **可选全图向量召回**：`embeddingPolicy.enableFullGraphVectorRecall: true`（默认关闭）
- **离线模型缓存**：`embeddingPolicy.modelCacheDir` 或环境变量 `GRAPHFLOW_EMBEDDING_CACHE_DIR`
- **飞轮**：`report_outcome` 成功路径写入 Skill 节点
- **Installer 面冻结**：不再扩展新的 IDE 自动安装目标

## 安装 VSIX（最终用户）

### 方式 A：图形界面（推荐）

1. 打开 [GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases)
2. 下载最新 `graphflow-vscode-<version>.vsix`
3. **VS Code**：扩展侧边栏 → `…` → **从 VSIX 安装…**
4. **Cursor**：扩展侧边栏 → `…` → **Install from VSIX**
5. 重启编辑器

### 方式 B：命令行

```bash
code --install-extension graphflow-vscode-1.7.1.vsix
# Cursor CLI（若已安装）：
cursor --install-extension graphflow-vscode-1.7.1.vsix
```

### 安装后推荐流程

1. 重启 VS Code / Cursor，等待提示 **GraphFlow MCP 已安装到: …**（扩展会自动写入本机 Agent MCP 配置）
2. 打开任意项目文件夹作为工作区
3. 命令面板 → **GraphFlow: Show Settings**
4. 确认 Graph Store Path（默认 `graphflow-out/graphflow-graph.json`）→ **Save Settings**
5. 点击 **建立图谱（无需 LLM）** — 纯 AST 结构索引，无需 API Key
6. （可选）配置 Provider / Smart·Economy 模型 → **测试路由**
7. 命令面板 → **GraphFlow: Preview Context** 或 **GraphFlow: Show Graph** 验证

> **无需 LLM** 即可使用：结构建图、Context Preview（hash embedding 兜底向量召回）、知识图谱可视化、MCP 工具。
>
> **关于语义模型**：VSIX **不**捆绑 `@xenova/transformers`（体积约 100MB+）。默认 hash 可用；若需本地 MiniLM，请预置缓存并设置 `GRAPHFLOW_EMBEDDING_CACHE_DIR`（或配置 `embeddingPolicy.modelCacheDir`）。

## 功能命令

| 命令 | 说明 |
| --- | --- |
| GraphFlow: Show Settings | 配置、建图、路由测试 |
| GraphFlow: Show Graph | 知识图谱可视化 |
| GraphFlow: Preview Context | 上下文压缩与 Token Budget |
| GraphFlow: Plan & Brainstorm | 任务规划 |
| GraphFlow: Run Task | 执行任务 |
| GraphFlow: Skill Insights | 技能学习面板 |
| GraphFlow: Install MCP to Agents | 手动重试 MCP 自动安装 |
| GraphFlow: Model Setup Guide | 模型配置说明 |

Chat Agent（`@graphflow`）：`/run`、`/plan`、`/graph`、`/skills`、`/diagnose`、`/learn`、`/history`

## Agent 对话框

在 Chat / Agent 中选择 `@graphflow`：

| 命令 | 示例 |
| --- | --- |
| `/run <task>` | `/run update readme and add tests` |
| `/plan <task>` | `/plan refactor architecture and add tests` |
| `/graph` | 输出图谱快照统计 |
| `/skills` | 技能飞轮 Top 洞察 |
| `/diagnose` | 路由健康诊断 |
| `/learn` | 触发 nightly 学习 |
| `/history` | 本次会话运行记录 |

## 给同事分发

直接发送 VSIX 文件即可，同事**无需** clone GraphFlow 仓库：

1. 从 Releases 下载 `graphflow-vscode-1.7.1.vsix`
2. 按上文「安装 VSIX」步骤安装
3. 打开项目 → Settings → 建立图谱

## 开发模式（贡献者）

在仓库根目录：

```bash
npm install
npm run build
npm run build:extension
```

在本目录：

```bash
npm install
npm run build
```

VS Code 中按 `F5` 启动 Extension Development Host。

## 打包 VSIX

在仓库根目录：

```bash
npm run package:extension
```

输出：`artifacts/graphflow-vscode-<version>.vsix`

## 最小环境要求

1. VS Code / Cursor 版本满足扩展引擎要求（`^1.99.0`）
2. 可打开任意文件夹作为工作区
3. **无需**额外安装 GraphFlow npm 包或 clone 仓库

可选：需要 LLM 规划增强时，在工作区或 `~/.graphflow.config.json` 配置 provider API Key。

## 常见问题

**VSIX 安装后命令不可见**

- 重启 VS Code / Cursor
- 扩展列表确认 GraphFlow 已启用

**MCP 未自动安装**

- 命令面板 → **GraphFlow: Install MCP to Agents**
- 或终端：`npx @roarpeng/graphflow install`

**图谱为空 / Preview 0 anchors**

- Settings → **建立图谱（无需 LLM）**
- 或 MCP：`graphflow_index`（传入 `rootDir` 为项目绝对路径）

**MCP 日志出现 No safe workspace root**

- 正常保护提示：启动 cwd 不是用户项目时会跳过自动 file watcher
- 工具调用请传 `rootDir`，或设置 `GRAPHFLOW_WORKSPACE_ROOT`

**命令执行失败（开发模式）**

- 确认根目录 `npm run build && npm run build:extension` 已通过
