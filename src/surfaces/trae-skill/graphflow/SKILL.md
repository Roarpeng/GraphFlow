---
name: "graphflow"
description: "Token-First 外科手术级代码切片、精准修改、脱水执行与自动宏工具引擎（4 个极简 MCP 工具：gf_read, gf_edit, gf_exec, gf_macro）。"
---

# GraphFlow 3.0 — Token-First Surgical Skill

GraphFlow 3.0 只围绕 **4 条第一性原理** 为 Coding Agent 节省 Token 费用：
1. **喂精准资料 (`gf_read`)**：AST 骨骼折叠 + 目标函数完整声明体 + 依赖类型自动闭合，绝不盲读全文件。
2. **让精准修改 (`gf_read` 调用点微切片 + `gf_edit`)**：读取符号自动附带全库调用点 3 行微切片；按符号或行号原地修改，改后毫秒级自动完成 AST 语法与调用方签名静态校验。
3. **能用工具绝不用 LLM (`gf_exec`)**：基于 `git diff` 与依赖图自动筛选受影响单测；测试/构建输出本地自动脱水（成功仅回 1 行 `PASS`，失败只提取报错断言 + 5 行源码上下文）。
4. **重复活动自动变工具 (`gf_macro`)**：自动录制高频读取组合与命令序列（$\ge 2$ 次自动编译为 `.graphflow/macros/*.mjs` 可执行宏），后续 1 步直接运行，0 LLM 折返。

## 4 个核心工具

| 工具 | 何时调用 | 核心参数 |
| :--- | :--- | :--- |
| `gf_read` | 查代码、看文件结构、看某函数及谁调了它 | `targets: ["src/a.ts#fn", "src/b.ts"]` 或 `q: "keyword"` |
| `gf_edit` | 按符号名、行号区间或片段精准改代码并即时静态校验 | `file`, `symbol` (或 `startLine`+`endLine` / `oldCode`), `newCode` |
| `gf_exec` | 跑受影响测试 (`cmd: "affected-tests"`) 或终端命令并脱水输出 | `cmd`, `changedFiles?`, `handle?` (按需回看原始日志) |
| `gf_macro` | 查看或一键运行已自动录制生成的组合工具/脚本 | `action: "list" \| "run" \| "save"`, `id?`, `steps?` |

## 极简工作流（严禁多余调用）

1. **先看是否有现成宏**：若已知高频任务，调 `gf_macro(action="run", id="...")` 一步到位。
2. **精准读取**：未知位置用 `gf_read(q="...")`；已知文件先用 `gf_read(targets=["path/to/file.ts"])` 获取 AST 骨骼折叠视图，或直接 `gf_read(targets=["path/to/file.ts#symbolName"])` 拿到函数体 + 类型定义 + 全库调用点。
3. **一次性精准修改**：根据 `gf_read` 附带的 `[Blast Radius]` 调用点微切片，用 `gf_edit` 在一个回合内把定义与受影响调用点改完。
4. **脱水验证**：调 `gf_exec(cmd="affected-tests")` 或 `gf_exec(cmd="...")`。
5. **绝对禁止**：
   - 禁止在回答用户后再次调用工具回填 `assistantReply`（零复读浪费）。
   - 禁止向用户长篇汇报 Token 节省百分比数字。
