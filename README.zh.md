# GraphFlow

[English](README.md) | 中文

[![npm version](https://img.shields.io/badge/npm-1.9.16-blue)](https://www.npmjs.com/package/@roarpeng/graphflow)

> **给编程 Agent 用的记忆与上下文 harness。** 本地优先的代码知识图谱 · 有界上下文压缩（约 98% token 节省） · 跨会话学习飞轮。

GraphFlow 把 **记忆 + hooks + skills** 做成可移植的 MCP 表面（Cursor、Claude Code、DeepSeek Harness、15+ Agent），让无状态模型变成可长期工作的编码助手。纯 TypeScript/Node，CLI + MCP + VS Code 扩展，完全离线，无需 API Key。

## 快速开始

```bash
npx @roarpeng/graphflow graph index .
npx @roarpeng/graphflow context preview "orchestrator" --json
npx @roarpeng/graphflow install    # 自动接入已检测到的 Agent（含 dsh）
```

MCP 入口：

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

Agent 应先调 `graphflow_context` 拿压缩上下文，再视需要调用 `graphflow_plan`。没有 LLM API Key 时会桥接到宿主 Agent（agent-delegated）。

## 工作台脉络（v1.9.14）

日常 Chat 仍是单线。复杂任务用 `graphflow_plan` 播种**功能主题容器**（画布上是计划步骤，不是一轮一节点）。点击节点，把 `topicId` 传给 `graphflow_context` 即可在该功能上继续或回到主线。问法跑偏会 Fork 孤立旁支，主线不被刷脏。答完再调 `graphflow_context({ assistantReply })` 回填原文。树上的标题只用于显示；下一轮必读是 Goal + 祖先标题 + 该节点原文 Q/A。

按需唤醒（仍是 10 个 MCP 工具，不新增）：

```bash
graphflow workbench tree --json
# VS Code / Cursor：GraphFlow: Workbench Tree（活动栏默认收起）或 Chat /tree
# MCP：graphflow_diagnose → graph.workbenchOutline
graphflow context preview --topic-id "<topic:...>" "在此节点继续"
graphflow context preview --reply "助手原文回答"
```

## DeepSeek Harness 插件

GraphFlow 本身就是一个 **dsh 插件包**（topic：`dsh-plugin`）。`package.json` 声明 `dsh.bundle`，根目录 `cordis.patch.yml` 把 GraphFlow MCP 与 ESM glue 插入 Harness 的插件树。

### 能力

| 能力 | 说明 | dsh 工具名 |
| --- | --- | --- |
| 压缩上下文 | 查询 → 锚点 + 摘要；按 `anchorId` 展开 | `mcp__graphflow__graphflow_context` |
| 任务规划 | simple / insight；无 LLM 时桥接宿主 | `mcp__graphflow__graphflow_plan` |
| 桥接执行包 | 规划 + 压缩上下文，不代跑代码 | `mcp__graphflow__graphflow_run` |
| 结果回填 | 关闭技能飞轮 | `mcp__graphflow__graphflow_report_outcome` |
| ATP Insight | submit / merge | `mcp__graphflow__graphflow_insight` |
| 建图 | 增量 / 单文件 / 全量重建 | `mcp__graphflow__graphflow_index` |
| 技能洞察 | 历史任务沉淀的 skill | `mcp__graphflow__graphflow_skill_insights` |
| 诊断 | 图谱、路由、token 节省、飞轮健康 | `mcp__graphflow__graphflow_diagnose` |
| 产物 | 图谱 import / export | `mcp__graphflow__graphflow_artifact` |
| 技能指南 | 给已连接 Agent 的用法说明 | `mcp__graphflow__graphflow_skill_guide` |

| 在 dsh 上 | 状态 |
| --- | --- |
| 上述 10 个 MCP 工具（stdio `cwd` = 会话工作区） | 支持 |
| Skill（bundle glue 注册；`dsh plugin add` 即可） | 支持 |
| 会话结束飞轮（仅 `agent/disposed` → `outcome report`；不是 live `session/flush`） | 支持 |
| VS Code/Cursor 图谱面板、Settings、Workbench Tree、`@graphflow` chat | **不移植** |
| Cursor Agent Plugins 发现 / Claude Code Session* **文件** hooks | **不移植**（dsh 用 bundle + glue） |

核心价值：本地 AST 知识图谱、L1–L3 分层压缩（实测约 98% token 节省）、跨会话 Episodic / Skill 飞轮。GraphFlow **不执行代码**，只给宿主 Agent 压缩上下文和计划。Workbench 数据走 MCP `graphflow_context` / `graphflow_diagnose` 即可。

### 安装

**方式 A：装进某个 profile（推荐）**

```bash
dsh plugin --profile web add @roarpeng/graphflow
npx @deepseek-ai/dsh web
```

**方式 B：home 级 overlay（所有 profile 生效）**

先有 `$DSH_HOME`（默认 `~/.dsh`），再执行：

```bash
npx @roarpeng/graphflow install
```

会写入：

| 路径 | 作用 |
| --- | --- |
| `$DSH_HOME/cordis.patch.yml` | 插入 `mcp-graphflow`（`cwd: process.cwd()`）与 `graphflow-dsh` glue |
| `$DSH_HOME/skills/graphflow/SKILL.md` | Skill 目录（`graphflow install`）；bundle glue 也会在运行时 `ctx.skills.register` |

开发态也可：

```bash
dsh plugin --profile web add /absolute/path/to/GraphFlow
```

### 用法

1. 任何读代码、改代码、排错之前，先调 `mcp__graphflow__graphflow_context`，并传入当前仓库绝对路径 `rootDir`。
2. 用返回的 `summary` / `anchors` / `tokenBudget` 当第一上下文；不够再按 `anchorId` 展开。
3. 跨多文件或范围不清时，再调 `graphflow_plan`；结果里的 `workbench.topics` 是功能节点。之后可用 `topicId` 细化，或 `graphflow_diagnose.graph.workbenchOutline` / `graphflow workbench tree` 唤醒脉络树。
4. 改完文件后调 `graphflow_index`（单文件可传 `filePath`）。
5. 若走了 `graphflow_run`，结束后必须 `graphflow_report_outcome`（`episodeId` + `success`）。
6. 回答用户后应再调 `graphflow_context({ assistantReply })` 回填原文。
7. 中文问题请同时传 `englishQuery`（英文文件名 / 符号名），不要只用泛化中文词检索。

不要在 `cordis.patch.yml` 里写死 `GRAPHFLOW_WORKSPACE_ROOT`。

### 卸载

```bash
npx @roarpeng/graphflow uninstall
# 若只从某个 profile 移除 bundle：
dsh plugin --profile web remove @roarpeng/graphflow
```

## 其它安装路径

| 路径 | 适用 |
| --- | --- |
| [Agent Plugins 1.0](https://agent-plugins.org)（`plugin.json` + `mcp.json` + `skills/`） | Cursor 等支持插件清单的宿主 |
| `npx @roarpeng/graphflow install` | Rules / 多 Agent / 非插件宿主（含 dsh overlay） |
| VS Code / Cursor 扩展 | Open VSX：`roarpeng.graphflow` |

## 更多

完整英文文档、基准与协议：[README.md](README.md) · [ATP/IR](docs/atp-ir-spec-v1.md) · [上下文合同](docs/context-contract.md) · [经验记忆](docs/experience-memory.md)
