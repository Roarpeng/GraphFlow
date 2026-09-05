# GraphFlow + Serena: better together（联合方案）

> 互补配对指南。GraphFlow 是**记忆与上下文 harness**；Serena 是**符号级精确编辑器**。两者不是竞品。

[English](graphflow-serena.md) · 诚实对比：[docs/comparison.md](comparison.md) · 配置示例：[`examples/graphflow-serena.mcp.json`](../examples/graphflow-serena.mcp.json)

GraphFlow 负责压缩 agent **该看见什么**，并记住它**学到了什么**。
Serena 通过 LSP 定位并编辑符号（40+ 语言）。两个 MCP server 并列运行。
GraphFlow 运行时不依赖 Serena——这套配对只是配置与工作流，不是代码耦合。

---

## 谁做什么

| 阶段 | 负责方 | 做什么 |
| --- | --- | --- |
| **看清** | **GraphFlow** | `graphflow_context` — 带 token 预算的压缩锚点 + 摘要，以及相似 episode / 技能提示 |
| **规划** | **GraphFlow** | `graphflow_plan` — 任务 DAG（可选 `graphflow_run` 桥接描述符）。GraphFlow **不执行**改代码 |
| **动手** | **Serena** | LSP 查找 / 改名 / 替换 / 重构，符号粒度 |
| **记住** | **GraphFlow** | 改完后：`graphflow_index`（图谱保鲜），若走了 `graphflow_run` 再 `graphflow_report_outcome` |

一句话：**GraphFlow = memory；Serena = hands。**

---

## 同时安装两个 MCP server

### 1. GraphFlow

无需 API Key。离线 AST 建图 + MCP：

```bash
npx @roarpeng/graphflow graph index .
```

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

或 `npx @roarpeng/graphflow install`，把 MCP + Skill + Rules 写入已检测到的宿主。

### 2. Serena

Serena 的安装以**它自己的文档**为准，不要从本仓库推断。当前推荐路径
（[oraios/serena](https://github.com/oraios/serena)）：

```bash
# 需要 uv（https://docs.astral.sh/uv）
uv tool install -p 3.13 serena-agent
serena init
```

再用适合宿主的 `--context` 启动 MCP：

| 宿主 | 典型启动 |
| --- | --- |
| Cursor / Cline / Windsurf / Roo | `serena start-mcp-server --context ide --project <path>` |
| Claude Code | `serena setup claude-code` 或 `serena start-mcp-server --context claude-code --project-from-cwd` |
| VS Code | `serena start-mcp-server --context vscode --project ${workspaceFolder}` |

启动命令、context 名称、以及 `uvx --from git+…` 兜底会随 Serena 版本变化。
以 [Serena 运行 / 客户端文档](https://oraios.github.io/serena/) 为权威来源。
`ide-assistant` 是旧别名——请改用 `ide` 或 `claude-code`。

### 3. 并列挂载

把 [`examples/graphflow-serena.mcp.json`](../examples/graphflow-serena.mcp.json)
拷进宿主的 MCP 配置（Cursor `mcp.json`、Claude Desktop 等），并替换
`<your-project-path>`：

```json
{
  "mcpServers": {
    "graphflow": {
      "command": "npx",
      "args": ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"]
    },
    "serena": {
      "command": "serena",
      "args": [
        "start-mcp-server",
        "--context",
        "ide",
        "--project",
        "<your-project-path>"
      ]
    }
  }
}
```

两者都是 local-first。工具名不重叠（`graphflow_*` vs Serena 的符号工具）。
本仓库**不会**把 Serena 写进 `package.json`。

---

## 工作流

```
提问
  │
  ▼
graphflow_context     →  summary + anchors + tokenBudget  （看清）
  │
  ▼
graphflow_plan        →  DAG / 工作台主题                  （规划；改动显而易见时可跳过）
  │
  ▼
Serena 符号工具        →  查找 / 改名 / 替换函数体          （动手）
  │
  ▼
graphflow_index       →  增量 / 单文件刷新                  （图谱跟上工作树）
  │
  ▼
graphflow_report_outcome  （走了 graphflow_run 后必须）     （记住）
```

**1. 先拿上下文。** 用任务调用 `graphflow_context`。把 `summary`、`anchors`、
`tokenBudget` 当第一上下文。压缩包不够时再按 `anchorId` 展开。不要整仓倾倒。

**2. 多步任务再规划。** `graphflow_plan` 播种 DAG。若走了 `graphflow_run`，
留住返回的 `episodeId`——稍后必须关闭。

**3. 用 Serena 改代码。** 让宿主 agent 用 Serena 做符号定位和精确编辑
（跨 40+ 语言改名、替换函数体、定向重构）。GraphFlow 的锚点是**指针**，
不是根据压缩摘要改写文件的许可。

**4. 闭环。** 文件变更后调用 `graphflow_index`（单文件可传 `filePath`）。
若走了 `graphflow_run`，用该 `episodeId`、`success` 布尔值和可选 `lessons`
调用 `graphflow_report_outcome`。会话结束的 auto-capture hooks 可以关掉
pending episode，但显式回填才是诚实闭环——见
[flywheel-autocapture.md](flywheel-autocapture.md)。

回答用户后应再调 `graphflow_context({ assistantReply })`，把原文存进工作台。

---

## 坑

| 坑 | 正确做法 |
| --- | --- |
| 把 GraphFlow 和 Serena 当成二选一 | 叠加使用。只有你确实只要单点工具时才单选（见 [comparison.md](comparison.md)） |
| 对着 GraphFlow 压缩摘要直接改代码 | 摘要是指针。先展开 File/Symbol 锚点，或让 Serena 读符号，再动手 |
| 用 GraphFlow「精确重命名符号」 | 那是 Serena 的活（LSP）。GraphFlow 不会给你语言服务器式 rename |
| 把 Serena 当上下文预算 / 会话记忆 | Serena 不做 token 预算压缩，也不跑 Episodic / Skill / Decision 飞轮 |
| 走了 `graphflow_run` 却不调 `graphflow_report_outcome` | 飞轮停在 pending。回填成败（或依赖已安装的 auto-capture hooks） |
| Serena 改完文件却忘了 `graphflow_index` | 下次 `graphflow_context` 可能排到过期符号。给改过的文件建索引 |
| 复制一年前的 Serena `uvx git+https://…` 片段 | 优先 `uv tool install` + `serena start-mcp-server`。`--context` 以 Serena 当前文档为准 |
| 客户端找不到 `serena` 命令 | 把 `serena` 可执行文件的绝对路径写进 `command`（常见 MCP PATH 问题） |
| 首次会话 Serena 超时 | LSP 冷启动慢。提高客户端 MCP 超时；大仓可先 `serena project index` |
| 把 Serena 加进 GraphFlow 的 npm 依赖 | 不要。配对只是 MCP 配置——无共享运行时、无 `package.json` 耦合 |
| 以为有 auto-capture 就可以不回填 | Auto-capture 写的是 *pending* episode；hooks 可能稍后关闭。`graphflow_run` 后仍应显式 report |

---

## 相关

- [README.zh.md](../README.zh.md) — GraphFlow 中文概览
- [comparison.md](comparison.md) — 什么时候该选 GraphFlow、Serena，或都不选
- [context-contract.md](context-contract.md) — 压缩上下文是指针
- [experience-memory.md](experience-memory.md) — Storage → Reflection → Experience
- [flywheel-autocapture.md](flywheel-autocapture.md) — 自动闭环
- [Serena](https://github.com/oraios/serena) — 官方安装与 MCP 客户端说明
