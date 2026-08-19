# GraphFlow VS Code Extension

GraphFlow 编辑器扩展：在 VS Code / Cursor 内建图、压缩上下文、任务规划、知识图谱可视化、**跨会话记忆审计**，并一键安装 GraphFlow MCP。

扩展**内置 GraphFlow runtime**，安装 VSIX 后**不需要**工作区存在 GraphFlow 源码，也**不需要**运行 `npm run start`。

## 当前版本

- Extension / runtime：**1.9.14**
- 市场身份：`roarpeng.graphflow`（displayName **GraphFlow Context & Memory**）
- 对应 VSIX：`../artifacts/graphflow-1.9.14.vsix`（本地打包）或 [GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases)

## Office/PDF 文档转换（anydoc）

在 **GraphFlow: Settings** 的「图谱」区块勾选 **Office / PDF**，需要时点 **安装解析器**。扩展会把 `@firecrawl/anydoc` 下到 `~/.graphflow/optional-deps`。关掉该项会跳过 Office/PDF，源码建图不受影响。

## v1.9.x 要点

- **工作台脉络（v1.9.14）**：复杂任务先 `graphflow_plan`，画布上是功能节点而不是一轮一节点。活动栏 **工作台脉络** 默认收起；**GraphFlow: Workbench Tree** / Chat `/tree` 唤醒。点击「在此继续」复制 `topicId`，下一轮 `graphflow_context` 带回该功能原文。偏离自动 Fork 旁支。
- **DeepSeek Harness 插件（v1.9.14）**：`dsh plugin --profile web add @roarpeng/graphflow`
- **记忆透明化（Memory Transparency）**：跨会话记忆可度量、可审计、可归因
  - **记忆审计**：`graphflow memory list|search|forget`（CLI / runtime 均可）——按结局过滤、相似度排序检索、单条记忆删除；每条记忆带来源任务、结局、lessons、staleGoal 标记
  - **记忆 ROI 基准**：`npm run benchmark:memory` 实测记忆开 100.0% vs 关 56.5%（62 任务，救回 27、0 受损），含「哪条记忆救了哪个任务」归因链
  - **飞轮归因面板**：Skill Insights 面板新增 memoryAttribution 区块（记忆命中数、stale 记忆数、成败置信分布、Top 贡献记忆证据链、偏离分类）
- **语义 embedding 可选后端**：`graphPolicy.embeddingProvider: "fnv" | "transformers"`（默认 `fnv` 离线安全；`transformers` 经 `@huggingface/transformers` 懒加载 all-MiniLM-L6-v2，失败自动降级 FNV）
- **技能质量分类**：`proven / correctable / anti-pattern / noise` 四类——噪声技能提取即拒、装载时清理；仅 anti-pattern 记负分
- **检索 golden set 132 查询**：10 域回归门禁 + 负样本 + Top-K 位置断言，防压缩/排序悄悄劣化召回
- **skill sync 双向 MERGE**：团队技能包导入按 per-skill 并集合并（updatedAt 较新者胜、`--force` 覆盖），golden 检索集随包同步
- **扩展改名**：`graphflow-tool` → `graphflow`（VSIX 产物 `graphflow-<version>.vsix`；Open VSX 新名待补发）

### v1.8 要点（目标对齐，历史）

- **Goal 锚点**：intent 五元组固化为图一等公民，每次打包自动注入原始需求
- **低置信度澄清门**：`confidence < 0.6` 不出 plan，先澄清
- **alignment-check 回检** + **deviation 偏离分类**（misread-requirement / scope-creep / tech-drift）
- **Goal 版本链**：需求变更自动版本化 + `changedFields` diff，pending episodes 标记 `staleGoal`
- **ATP/IR v1.1** 公开规范（v1.0 兼容）

### 更早要点（简）

- 检索词干匹配、PageRank LRU 缓存、HNSW 向量索引持久化、`transport: "auto"`（sqlite 优先降级 file）
- Plan Agent Bridge：无 GraphFlow LLM 时规划委托连接 Agent（agent-delegated + `suggestedNodes`）
- MCP home-cwd 修复、工作区发现增强、`install --json` / `doctor --json` 结构化自检
- Open VSX 自动发布、Opencode agent 支持、embedding 超时/HF 镜像

## 安装 VSIX（最终用户）

### 方式 A：图形界面（推荐）

1. 打开 [GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases)
2. 下载最新 `graphflow-<version>.vsix`
3. **VS Code**：扩展侧边栏 → `…` → **从 VSIX 安装…**
4. **Cursor**：扩展侧边栏 → `…` → **Install from VSIX**
5. 重启编辑器

### 方式 B：命令行

```bash
code --install-extension graphflow-1.9.5.vsix
# Cursor CLI（若已安装）：
cursor --install-extension graphflow-1.9.5.vsix
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
> **关于语义模型**：VSIX **不**捆绑 `@huggingface/transformers` 模型（约 100MB+）。默认 `fnv` 离线可用；启用 `transformers` 时模型懒加载，无缓存/失败会告警并自动降级回 FNV。
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

1. 从 Releases 或本地 `artifacts/` 取得 `graphflow-1.9.5.vsix`
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
- 或终端：`npx @roarpeng/graphflow@1.9.5 install`

**图谱为空 / Preview 0 anchors**

- Settings → **建立图谱**
- 或 MCP：`graphflow_index`（传入 `rootDir` 为项目绝对路径）

**MCP 报错 `unsafe workspace root from discovery: /home/...`**

- 升级到 **1.9.5+**，然后 Settings → **安装 / 更新 MCP**，Reload Window
- 工具调用务必传 `rootDir`（项目绝对路径）
- CLI：`graphflow doctor --json` 查看 MCP/Skill 注册状态

**MCP 日志出现 No safe workspace root**

- 正常保护提示：启动 cwd 不是用户项目时会跳过自动 file watcher
- 工具调用请传 `rootDir`，或设置 `GRAPHFLOW_WORKSPACE_ROOT`

**命令执行失败（开发模式）**

- 确认根目录 `npm run build && npm run build:extension` 已通过
