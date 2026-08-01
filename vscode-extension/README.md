# GraphFlow VS Code Extension

GraphFlow 编辑器扩展：在 VS Code / Cursor 内建图、压缩上下文、任务规划、知识图谱可视化，并一键安装 GraphFlow MCP。

扩展**内置 GraphFlow runtime**（v1.4+），安装 VSIX 后**不需要**工作区存在 GraphFlow 源码，也**不需要**运行 `npm run start`。

## 当前版本

- Extension / runtime：**1.9.0**
- 对应 VSIX：`../artifacts/graphflow-1.9.0.vsix`（本地打包）或 [GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases)

### v1.9.0 要点（目标对齐）

- **Goal 锚点**：intent 五元组（coreProblem / successDefinition / nonGoals）固化为图一等公民，每次打包自动注入原始需求——执行全程记得为什么出发
- **低置信度澄清门**：intent `confidence < 0.6` 时不出 plan，先澄清（`clarification` work item）
- **alignment-check 回检**：执行后对照目标锚点检查产出，附 drift 分类（`alignment-check` work item，不阻塞 merge）
- **deviation 偏离分类**：`report_outcome` / `outcome report --deviation` 记录 `misread-requirement / scope-creep / tech-drift`，飞轮报告聚合
- **Goal 版本链**：需求变更自动版本化 + `changedFields` diff，pending episodes 标记 `staleGoal`
- **ATP/IR v1.1**：公开规范增量升级，v1.0 兼容

### v1.7.15 要点（保留）

- **检索质量护栏**：26 条查询 golden set 回归测试 + 词干匹配（`routing` 命中 `route`），orchestrator 类查询不再漏召
- **性能**：PageRank 全图指纹 LRU 缓存（重复打包零重算）；HNSW 向量索引跨进程持久化（`embeddingPolicy.vectorStorePath` 派生 `.hnsw`）
- **存储 `transport: "auto"`**：sqlite 优先、JSON 文件透明降级；顺手修复 sqlite FTS 的 camelCase 检索盲区（schema v2）
- **Skill 飞轮可度量**：`npm run benchmark:skills` A/B 基准（注入率/召回率/开销）；`graphflow skill report` 飞轮贡献报告；`graphflow skill sync export/import` 技能包进 git 团队共享
- **ATP IR 公开规范**：`docs/atp-ir-spec-v1.md` 定义 `atp-ir/1.0` 委托载荷契约
- **README 重写**：修复中文乱码，新定位「编码 Agent 的上下文与记忆层」
- **测试环境隔离**：本机 ambient 配置不再让单测变成真实 LLM 网络调用；90 文件 / 443 tests 全绿

### v1.7.14 要点（保留）

- **Plan Agent Bridge**：无 GraphFlow LLM 时默认 `graphflow_plan` 也委托连接 Agent 拆任务，并附带本地 `suggestedNodes`
- **Plan 子句拆分修复**：分析类冒号列表（assumptions、failure modes、validation gates…）不再被启发式拆成伪并行 DAG
- **MCP home-cwd 修复**：Cursor 以用户 home 启动 MCP 时，不再把 `/home/<user>` 当作工作区（修复 `unsafe workspace root from discovery`）
- **工作区发现增强**：读取 Cursor `WORKSPACE_FOLDER_PATHS`；忽略未展开的 `${workspaceFolder}` 占位符
- **npx MCP 安装**：写入 `GRAPHFLOW_WORKSPACE_ROOT=${workspaceFolder}`，由 Cursor/VS Code 插值到真实项目根
- **安装自检**：`graphflow install --json` / `doctor --json` 输出结构化成功/缺失/remediation
- **Bridge CLI 飞轮**：`insight submit/merge` + `outcome report` 可在无 GraphFlow LLM 时关闭学习循环
- Settings 工具页同步展示本版亮点与 MCP 使用提示

### v1.7.9 要点（保留）

- Open VSX 自动发布、Opencode agent 支持、embedding 超时/HF 镜像、全面 diagnose、技能衰减、Episode 隐私

### v1.7.3 / 1.7.2 要点（保留）

- **无痛 MCP**：扩展激活时自动扫描并修复 Trae 等配置里含空格的 `command`
- Embedding 韧性 / 检索降噪 / 可选全图向量召回 / 离线模型缓存

## 安装 VSIX（最终用户）

### 方式 A：图形界面（推荐）

1. 打开 [GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases)
2. 下载最新 `graphflow-<version>.vsix`
3. **VS Code**：扩展侧边栏 → `…` → **从 VSIX 安装…**
4. **Cursor**：扩展侧边栏 → `…` → **Install from VSIX**
5. 重启编辑器

### 方式 B：命令行

```bash
code --install-extension graphflow-1.9.0.vsix
# Cursor CLI（若已安装）：
cursor --install-extension graphflow-1.9.0.vsix
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
| GraphFlow: Show Settings | 配置、建图、路由测试、本版亮点 |
| GraphFlow: Show Graph | 知识图谱可视化 |
| GraphFlow: Preview Context | 上下文压缩与 Token Budget |
| GraphFlow: Plan & Brainstorm | 任务规划 |
| GraphFlow: Plan Insight (Six Hats) | 六顶思考帽深度规划 |
| GraphFlow: Run Task | 执行任务 |
| GraphFlow: Skill Insights | 技能学习面板 |
| GraphFlow: Install MCP to Agents | 手动重试 MCP 自动安装 |

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

1. 从 Releases 或本地 `artifacts/` 取得 `graphflow-1.9.0.vsix`
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
- 或终端：`npx @roarpeng/graphflow@1.9.0 install`

**图谱为空 / Preview 0 anchors**

- Settings → **建立图谱（无需 LLM）**
- 或 MCP：`graphflow_index`（传入 `rootDir` 为项目绝对路径）

**MCP 报错 `unsafe workspace root from discovery: /home/...`**

- 升级到 **1.9.0+**，然后 Settings → **安装 / 更新 MCP**，Reload Window
- 工具调用务必传 `rootDir`（项目绝对路径）
- CLI：`graphflow doctor --json` 查看 MCP/Skill 注册状态

**MCP 日志出现 No safe workspace root**

- 正常保护提示：启动 cwd 不是用户项目时会跳过自动 file watcher
- 工具调用请传 `rootDir`，或设置 `GRAPHFLOW_WORKSPACE_ROOT`

**命令执行失败（开发模式）**

- 确认根目录 `npm run build && npm run build:extension` 已通过
