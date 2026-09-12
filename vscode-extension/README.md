# GraphFlow VS Code Extension

GraphFlow 编辑器扩展：在 VS Code / Cursor 内建图、压缩上下文、任务规划、知识图谱可视化、**跨会话记忆审计**，并一键安装 GraphFlow MCP。

扩展**内置 GraphFlow runtime**，安装 VSIX 后**不需要**工作区存在 GraphFlow 源码，也**不需要**运行 `npm run start`。

## 当前版本

- Extension / runtime：**1.18.1**
- 市场身份：`roarpeng.graphflow`（displayName **GraphFlow Context & Memory**）
- 对应 VSIX：`../artifacts/graphflow-1.18.1.vsix`（本地打包）或 [GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases)

## Office/PDF 文档转换（anydoc）

在 **GraphFlow: Settings** 的「图谱」区块勾选 **Office / PDF**，需要时点 **安装解析器**。扩展会把 `@firecrawl/anydoc` 下到 `~/.graphflow/optional-deps`。关掉该项会跳过 Office/PDF，源码建图不受影响。

## v1.18.x 要点

- **跨宿主 workspace root 加固（v1.18.1）**：dsh / opencode 插件改用真实会话工作区；MCP 对 home/AppData 等 unsafe `rootDir` 返回**可恢复的错误 + 修复指引**（不再整次调用失败，安全策略不变）；新增 `CLAUDE_PROJECT_DIR` 工作区发现；规则/技能与托管指令块写入 `rootDir` 契约
- **效率机制（SoL-Pi 借鉴，默认全开）**：**GraphFlow: Settings → 效率机制** 可逐项开关——大输出归档为句柄（ObservationPack）、日志压缩为逐字核验收据（Evidence-Preserving Reducer）、按观测压力自适应预算 + 压缩建议（Online Context Compact）、编辑+验证融合（Action Fusion）
- **dsh 自动投影**：DeepSeek Harness 上把超阈值工具结果归档为句柄并替换模型可见内容；`GRAPHFLOW_D_DSH_PROJECTION=0` 关闭
- **效率/能力门禁**：`governance release-gate` 新增 `--min-efficiency-qualifying` / `--max-capability-regressions` / `--min-anchor-recall-percent` / `--min-body-coverage-percent`
- **宿主 hooks 扩展**：Cursor / Gemini / Codex 原生 hooks + opencode 插件安装切片；HostAdapter 的 doctor 覆盖 hooks

## v1.17.x 要点

- **证据诚实性（v1.17.0）**：token 节省改为**双口径**并列——对现实 top-K 文件读取 **95.6%**，对朴素 grep 基线 98.5%。两者回答不同问题，不可互换；现实中口径无法自我膨胀。打包后追加的载荷（对话召回行、工作台提示行）现计入 token 预算，`dialogueHits` 单独报为 `unbudgetedTokens`
- **对话图真正接入上下文引擎（v1.17.0）**：修复 v1.14 声称的「L3 对话打包」在生产路径上的死代码。对话内容现在**在所有代码锚点阶段之后**注入，纯增量，可证明不会挤掉 Symbol / File 锚点
- **对话写入边界密钥脱敏（v1.17.0）**：`userQuery` / `assistantReply` / 会话名等在落盘前清洗 API Key、Bearer/JWT、含凭据连接串与 PEM 私钥；`GRAPHFLOW_DIALOGUE_REDACT=0` 可关闭
- **技能准入（v1.17.0）**：新增 `provisional` 冷启动层（可用作提示、绝不当作 proven 呈现或同步）；`proven` 仍严格要求 ≥2 个去重成功 episode
- **安全审计修复（v1.17.0）**：`scripts/security-audit.cjs` 缺 `node:path` 导入导致每周安全审计连续 3 周静默失败，已修复并加入回归测试

## v1.16.x 要点

- **HostAdapter 覆盖全部 19 个宿主（v1.16.0）**：install / uninstall / doctor 统一走注册表——4 个手写切片（Cursor / Claude Code / DeepSeek Harness / Kimi Code）+ 通用 profile 切片（Trae、VS Code、Windsurf、Cline、Roo Code、Kilo Code、PearAI、Gemini、Codex、Antigravity、Amazon Q、Zed、Continue、Qoder、Opencode）。新增宿主不再需要改 CLI
- **编排层拆分（v1.16.0）**：`runOrchestration` 拆为四个具名阶段（simple / plan / bridge / llm-DAG），行为逐字保持
- **修复（v1.16.0）**：临时目录残留图谱不再劫持工作区发现；上游 README UTF-8 损坏修复并加入编码守卫

## v1.15.x 要点（历史）

- **团队记忆 diagnose（v1.15.0）**：`graphflow team serve` 提供 tenant 隔离 + viewer/contributor/admin RBAC；`graphflow diagnose` / `graphflow_diagnose` 报告 team 连通、authMode、tenant、RBAC、是否降级到本地。安全模型见 [docs/team-memory-security.md](../docs/team-memory-security.md)
- **飞轮公开复现（v1.15.2）**：仓库根目录 `npm run proof:flywheel`（离线、无需 API Key）；指南 [docs/flywheel-reproduction.md](../docs/flywheel-reproduction.md)。Serena 双 MCP：[docs/graphflow-serena.md](../docs/graphflow-serena.md)
- **R4 打包去重（v1.15.3）**：共享 `context-package-core`；对外 MCP/CLI `context preview` 行为不变

对话图 2.0（v1.14：时间边、召回、fork/回放）与 v1.13 治理平面仍在 runtime 中。

## v1.9.x 要点（历史）

- **工作台脉络（v1.9.14）**：复杂任务先 `graphflow_plan`，画布上是功能节点。活动栏 **工作台脉络** 默认收起；**GraphFlow: Workbench Tree** / Chat `/tree` 唤醒。偏离自动 Fork 旁支。
- **DeepSeek Harness 插件（v1.9.14）**：`dsh plugin --profile web add @roarpeng/graphflow`
- **记忆透明化**：`graphflow memory list|search|forget`；Skill Insights 的 memoryAttribution 区块；记忆 ROI 基准见仓库 `benchmarks/`（不在此复述数字）
- **技能四分类 + skill sync 双向 MERGE**；检索 golden set 回归门禁；扩展改名为 `graphflow`

更早：Goal 对齐（v1.8）、词干匹配 / PageRank LRU / HNSW / `transport: auto`、agent-delegated plan bridge、`doctor --json`。

## 安装 VSIX（最终用户）

### 方式 A：图形界面（推荐）

1. 打开 [GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases)
2. 下载最新 `graphflow-<version>.vsix`
3. **VS Code**：扩展侧边栏 → `…` → **从 VSIX 安装…**
4. **Cursor**：扩展侧边栏 → `…` → **Install from VSIX**
5. 重启编辑器

### 方式 B：命令行

```bash
code --install-extension graphflow-1.18.1.vsix
# Cursor CLI（若已安装）：
cursor --install-extension graphflow-1.18.1.vsix
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

1. 从 Releases 或本地 `artifacts/` 取得 `graphflow-1.18.1.vsix`
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
- 或终端：`npx @roarpeng/graphflow@1.18.1 install`

**图谱为空 / Preview 0 anchors**

- Settings → **建立图谱**
- 或 MCP：`graphflow_index`（传入 `rootDir` 为项目绝对路径）

**MCP 报错 `unsafe workspace root from discovery: /home/...`**

- 升级到 **1.18.1+**，然后 Settings → **安装 / 更新 MCP**，Reload Window
- 工具调用务必传 `rootDir`（项目绝对路径）
- CLI：`graphflow doctor --json` 查看 MCP/Skill 注册状态

**MCP 日志出现 No safe workspace root**

- 正常保护提示：启动 cwd 不是用户项目时会跳过自动 file watcher
- 工具调用请传 `rootDir`，或设置 `GRAPHFLOW_WORKSPACE_ROOT`

**命令执行失败（开发模式）**

- 确认根目录 `npm run build && npm run build:extension` 已通过
