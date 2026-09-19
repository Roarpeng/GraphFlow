# GraphFlow VS Code Extension

GraphFlow 编辑器扩展：在 VS Code / Cursor 内建图、压缩上下文、任务规划、知识图谱可视化、**跨会话记忆审计**，并一键安装 GraphFlow MCP。

扩展**内置 GraphFlow runtime**，安装 VSIX 后**不需要**工作区存在 GraphFlow 源码，也**不需要**运行 `npm run start`。

## 版本与获取

- 市场身份：`roarpeng.graphflow`（displayName **GraphFlow Context & Memory**）
- VSIX：[GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases) 的最新 `graphflow-<version>.vsix`，或本地 `npm run package:extension` 产物
- 各版本变更历史见仓库 [CHANGELOG.md](../CHANGELOG.md)

## Office/PDF 文档转换（anydoc）

在 **GraphFlow: Settings** 的「图谱」区块勾选 **Office / PDF**，需要时点 **安装解析器**。扩展会把 `@firecrawl/anydoc` 下到 `~/.graphflow/optional-deps`。关掉该项会跳过 Office/PDF，源码建图不受影响。

## 核心能力

- **大型项目索引性能**：reference 边停用词预算 + 每文件上限；解析用 worker 池；索引尊重 `.gitignore` 并跳过生成/锁文件；增量保存为追加式 delta 段（大库单文件保存只追加几 KB）
- **一键安装 + 条目永不悬空**：VSIX 激活自动同步运行时到稳定目录 `~/.graphflow/runtime/`，MCP 条目指向稳定路径；npm 全局安装 = 安装 + 注册 + 检测 + 修复
- **MCP 安装不因大图失败**：安装路径只读不自动索引；图存储紧凑 + 分块读写（超大图不触发 `Invalid string length`）
- **跨宿主 workspace root 加固**：MCP 对 home/AppData 等 unsafe `rootDir` 返回可恢复错误 + 修复指引；支持 `CLAUDE_PROJECT_DIR` 工作区发现
- **效率机制（默认全开，Settings 可逐项关）**：大输出归档为句柄（ObservationPack）、日志压缩为逐字核验收据（Evidence-Preserving Reducer）、按观测压力自适应预算 + 压缩建议（Online Context Compact）、编辑+验证融合（Action Fusion）；dsh 侧自动投影大结果（`GRAPHFLOW_D_DSH_PROJECTION=0` 关）
- **证据诚实性**：token 节省双口径并列——对现实 top-K 文件读取 / 对朴素 grep 基线；打包后追加的载荷计入 token 预算
- **对话图**：对话内容在所有代码锚点阶段之后注入（纯增量，不挤掉 Symbol/File 锚点）；落盘前密钥脱敏（`GRAPHFLOW_DIALOGUE_REDACT=0` 可关）
- **技能飞轮 + 准入**：`provisional` 冷启动层可用作提示、绝不当作 proven 呈现；`proven` 严格要求 ≥2 个去重成功 episode
- **HostAdapter 注册表**：全部 20 个宿主的 install / uninstall / doctor 统一走注册表，新增宿主不需要改 CLI
- **团队记忆**：`graphflow team serve` 提供 tenant 隔离 + viewer/contributor/admin RBAC；`diagnose` 报告连通与 RBAC
- **飞轮公开复现**：仓库根目录 `npm run proof:flywheel`（离线、无需 API Key）
- **工作台脉络**：复杂任务 `graphflow_plan` 播种功能主题容器，活动栏 **工作台脉络** 树（默认收起），偏离自动 Fork 旁支
- **Serena 双 MCP**：context/plan → Serena 编辑 → `report_outcome`，见 [docs/graphflow-serena.md](../docs/graphflow-serena.md)

## 安装 VSIX（最终用户）

### 方式 A：图形界面（推荐）

1. 打开 [GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases)
2. 下载最新 `graphflow-<version>.vsix`
3. **VS Code**：扩展侧边栏 → `…` → **从 VSIX 安装…**
4. **Cursor**：扩展侧边栏 → `…` → **Install from VSIX**
5. 重启编辑器

### 方式 B：命令行

```bash
# <version> 替换为你下载的版本号
code --install-extension graphflow-<version>.vsix
# Cursor CLI（若已安装）：
cursor --install-extension graphflow-<version>.vsix
```

### 安装后推荐流程

1. 重启 VS Code / Cursor，等待提示 **GraphFlow MCP 已安装到: …**（扩展会自动写入本机 Agent MCP 配置）
2. 打开任意项目文件夹作为工作区
3. 命令面板 → **GraphFlow: Settings**
4. 在同一页完成：勾选 Markdown / Office·PDF → **建立图谱** →（可选）安装 MCP、填模型
5. 顶部芯片可打开图谱、上下文、技能、规划、运行；需要跳转主线时打开 **GraphFlow: Workbench Tree**（默认收起）
6. （可选）配置 Provider / Smart·Economy 模型 → **测试路由**；存储与召回里可改 `embeddingProvider`
7. 命令面板 → **GraphFlow: Preview Context** 或 **GraphFlow: Show Graph** 验证
8. 使用一段时间后打开 **GraphFlow: Skill Insights** 查看飞轮贡献与记忆归因

> **无需 LLM** 即可使用：结构建图、Context Preview（FNV-1a hash 向量召回兜底）、知识图谱可视化、记忆审计、MCP 工具。
>
> **关于语义模型**：VSIX **不**捆绑 `@huggingface/transformers` 模型（约 100MB+）。默认 `transformers`（resilient local：优先本地语义，失败自动降级 FNV-1a）；选 `fnv` 可强制纯离线 hash。模型懒加载，无缓存/失败会告警并自动降级回 FNV。
>
> **关于 anydoc**：在 **GraphFlow: Settings** 勾选 Office / PDF；解析器下载到 `~/.graphflow/optional-deps`。

## 功能命令

| 命令 | 说明 |
| --- | --- |
| GraphFlow: Show Settings | 全部配置与功能：图谱、文档解析、MCP、模型、快捷入口 |
| GraphFlow: Show Graph | 知识图谱可视化 |
| GraphFlow: Workbench Tree | 按需唤醒工作台脉络（主线 DAG + 旁支，默认收起） |
| GraphFlow: Continue From Workbench Topic | 复制「在此节点继续」的 topicId 提示词 |
| GraphFlow: Preview Context | 上下文压缩与 Token Budget |
| GraphFlow: Plan & Brainstorm | 任务规划 |
| GraphFlow: Plan Insight (Six Hats) | 六顶思考帽深度规划 |
| GraphFlow: Run Task | 执行任务 |
| GraphFlow: Skill Insights | 技能飞轮 + **记忆归因面板** |
| GraphFlow: Install MCP to Agents | 手动重试 MCP 自动安装 |

Chat Agent（`@graphflow`）：`/run`、`/plan`、`/graph`、`/tree`、`/workbench`、`/skills`、`/diagnose`、`/learn`、`/history`

## Agent 对话框

在 Chat / Agent 中选择 `@graphflow`：

| 命令 | 示例 |
| --- | --- |
| `/run <task>` | `/run update readme and add tests` |
| `/plan <task>` | `/plan refactor architecture and add tests` |
| `/graph` | 输出图谱快照统计 |
| `/tree` / `/workbench` | 唤醒工作台脉络（主线 + 旁支 + 当前 topicId） |
| `/skills` | 技能飞轮 Top 洞察 + 记忆归因 |
| `/diagnose` | 路由健康诊断 |
| `/learn` | 触发 nightly 学习 |
| `/history` | 本次会话运行记录 |

## 记忆审计（CLI，扩展同 runtime）

```bash
graphflow memory list --outcome fail          # 失败的 episode 证据记录
graphflow memory search "embedding fallback"  # 相似记忆检索（排序 + 分数）
graphflow memory forget <episodeId>           # 删除单条记忆
```

## 给同事分发

直接发送 VSIX 文件即可，同事**无需** clone GraphFlow 仓库：

1. 从 Releases 或本地 `artifacts/` 取得最新 `graphflow-<version>.vsix`
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

输出：`artifacts/graphflow-<version>.vsix`

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

- Settings → **建立图谱**
- 或 MCP：`graphflow_index`（传入 `rootDir` 为项目绝对路径）

**MCP 报错 `unsafe workspace root from discovery: /home/...`**

- 升级到最新版，然后 Settings → **安装 / 更新 MCP**，Reload Window
- 工具调用务必传 `rootDir`（项目绝对路径）
- CLI：`graphflow doctor --json` 查看 MCP/Skill 注册状态

**MCP 日志出现 No safe workspace root**

- 正常保护提示：启动 cwd 不是用户项目时会跳过自动 file watcher
- 工具调用请传 `rootDir`，或设置 `GRAPHFLOW_WORKSPACE_ROOT`

**命令执行失败（开发模式）**

- 确认根目录 `npm run build && npm run build:extension` 已通过
