# GraphFlow + Serena: better together（联合方案）

> 互补配对指南。GraphFlow 3.0 是 **Token-First 外科手术引擎**；Serena 是**长尾语言的 LSP 符号编辑器**。两者不是竞品。

[English](graphflow-serena.md) · 诚实对比：[docs/comparison.md](comparison.md) · 配置示例：[`examples/graphflow-serena.mcp.json`](../examples/graphflow-serena.mcp.json)

GraphFlow 3.0 用自研 AST 引擎切片代码（TS/JS、Python、Go、Rust、C/C++、C#），
带静态守卫地外科手术式修改，并把测试输出脱水成一行。Serena 通过 LSP 覆盖
40+ 语言。两个 MCP server 并列运行。GraphFlow 运行时不依赖 Serena——这套
配对只是配置与工作流，不是代码耦合。

---

## 谁做什么

| 阶段 | 负责方 | 做什么 |
| --- | --- | --- |
| **看清** | **GraphFlow** | `gf_read` — AST 骨骼视图、符号体 + 依赖类型 + `[Blast Radius]` 调用点、`q` 关键词检索。绝不盲读全文件 |
| **动手** | **优先 GraphFlow** | `gf_edit` — 按符号/行号原地改、批量原子多编辑、零 LLM 跨仓改名，带 AST 语法 + 调用方参数守卫。六族之外的语言或重度 LSP 重构交给 Serena |
| **验证** | **GraphFlow** | `gf_exec` — `cmd: "affected-tests"` 从 git diff 路由受影响测试；通过时只回一行 `PASS` |
| **记住** | **GraphFlow** | `gf_read({ q, topicId / resumeFromTurnId })` 恢复工作台/对话记忆；outcome 飞轮由 hooks 自动闭环 |
| **长尾符号** | **Serena** | LSP 查找 / 改名 / 替换 / 重构，覆盖 40+ 语言 |

一句话：**GraphFlow = 4 个外科手术工具；Serena = 语言长尾。**

---

## 同时安装两个 MCP server

### 1. GraphFlow

无需 API Key。`npx @roarpeng/graphflow install` 会把 MCP + Skill + Rules +
hooks 写入已检测到的宿主；注册配置自带 `GRAPHFLOW_MCP_PROFILE=v3`，
Agent 开箱即得 4 个外科手术工具。

```json
{
  "mcpServers": {
    "graphflow": {
      "command": "npx",
      "args": ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
      "env": { "GRAPHFLOW_MCP_PROFILE": "v3" }
    }
  }
}
```

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
      "args": ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
      "env": { "GRAPHFLOW_MCP_PROFILE": "v3" }
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

两者都是 local-first。工具名不重叠（`gf_*` vs Serena 的符号工具）。
本仓库**不会**把 Serena 写进 `package.json`。

---

## 工作流

```
任务
  │
  ▼
gf_read               →  符号体 + 类型 + [Blast Radius]          （看清）
  │
  ▼
gf_edit               →  定义 + 受影响调用点，一个回合改完；       （动手）
  │                      renameTo 零 LLM 跨仓改名
  ▼
gf_exec               →  cmd: "affected-tests"                    （验证）
  │
  ▼
gf_macro              →  重复模式自动编译成宏                      （记住）
```

**1. 外科手术式读取。** `gf_read({ targets: ["src/foo.ts#bar"] })` 返回
符号体、它引用的类型、以及全库 `[Blast Radius]` 调用点。要总览就用骨骼
视图（`targets: ["src/foo.ts"]`）。不要整文件倾倒。

**2. 同一回合修改。** `gf_edit` 把定义和 Blast Radius 里列出的受影响调用点
一起改掉；AST 守卫会回滚语法错误、对调用方参数漂移告警。六族原生语言之外
的符号，交给 Serena 编辑。

**3. 脱水验证。** `gf_exec({ cmd: "affected-tests" })` 只跑被 diff 触到的
测试；通过时输出折叠成一行 `PASS`，失败时内联报错处 5 行源码窗口。

**4. 让记忆自动发生。** 重复的读取/命令模式自动编译成
`.graphflow/macros/*.mjs`（`gf_macro({ action: "run", id })`）；工作台/对话
上下文用 `gf_read({ q, topicId })` 恢复。outcome 采集走已安装的 hooks——
无需手动建索引：v3 的 AST 缓存按 mtime 失效，`gf_read` 看到的永远是当前树。

---

## 坑

| 坑 | 正确做法 |
| --- | --- |
| 把 GraphFlow 和 Serena 当成二选一 | 叠加使用：六族原生语言用 `gf_*`，长尾交给 Serena（见 [comparison.md](comparison.md)） |
| 对着骨骼折叠视图直接改代码 | 骨骼是地图。先 `gf_read({ targets: ["file#symbol"] })`，再 `gf_edit` |
| 在 TS/JS/Python/Go/Rust/C/C++/C# 里凡事都用 Serena | `gf_edit` 即时、带静态守卫、零 LLM 折返；Serena 的价值在 GraphFlow AST 覆盖不到的语言 |
| 把 Serena 当 token 预算 / 会话记忆 | Serena 不折叠骨骼、不脱水测试输出、不编译习惯宏 |
| 因为「索引可能过期」而回退整文件裸读 | v3 工作区 AST 缓存按 mtime 失效；`gf_read` 看到的就是当前树 |
| 复制一年前的 Serena `uvx git+https://…` 片段 | 优先 `uv tool install` + `serena start-mcp-server`。`--context` 以 Serena 当前文档为准 |
| 客户端找不到 `serena` 命令 | 把 `serena` 可执行文件的绝对路径写进 `command`（常见 MCP PATH 问题） |
| 首次会话 Serena 超时 | LSP 冷启动慢。提高客户端 MCP 超时；大仓可先 `serena project index` |
| 把 Serena 加进 GraphFlow 的 npm 依赖 | 不要。配对只是 MCP 配置——无共享运行时、无 `package.json` 耦合 |
| 把 graphflow env 里的 `GRAPHFLOW_MCP_PROFILE=v3` 删掉 | 服务器会退回 10 工具 legacy 面，`gf_*` 调用将无法解析 |

---

## 相关

- [README.zh.md](../README.zh.md) — GraphFlow 3.0 中文概览
- [comparison.md](comparison.md) — 什么时候该选 GraphFlow、Serena，或都不选
- [v3-architecture.md](v3-architecture.md) — gf_* 背后的四大支柱
- [experience-memory.md](experience-memory.md) — Storage → Reflection → Experience
- [flywheel-autocapture.md](flywheel-autocapture.md) — 自动闭环
- [Serena](https://github.com/oraios/serena) — 官方安装与 MCP 客户端说明
