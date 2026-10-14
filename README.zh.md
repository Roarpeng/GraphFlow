# GraphFlow

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/@roarpeng/graphflow)](https://www.npmjs.com/package/@roarpeng/graphflow)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4D6BFE?labelColor=1f2430)](https://github.com/topics/dsh-plugin)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20HTTP-6E56CF)](https://modelcontextprotocol.io)

> **给编程 Agent 用的 Token-First 外科手术式代码引擎。**
> 原生支持 **TypeScript/JS、Python、C/C++、C#、Rust、Go** 六大语言体系的 AST 骨骼折叠切片（比整读文件少 **93%** Tokens）· 跨仓库调用点微切片、多点原子修改与零 LLM 全库重命名 · 终端日志脱水（单测输出压缩 **99%**）· 宿主 `PreToolUse` / `PostToolUse` 透明省流拦截器 · 个人习惯记忆与参数化工具宏。

GraphFlow 围绕 **4 条省 Token 第一性原理** 彻底重构：
1. **喂的精准 (`gf_read`)**：覆盖 **TS/JS、Python、C/C++、C#、Rust、Go** 的 AST 骨骼折叠（折叠无关函数体并保留真实 1-based 行号）+ 目标符号完整声明体 + 跨文件类型自动闭合（`interface`/`struct`/`dataclass`/`record`/`trait`/`enum`）+ 协同修改习惯提示。
2. **执行精准 (`gf_edit`)**：读取时自动挂载全库调用点 3 行微切片（`[Blast Radius]`），修改时支持单点或**跨文件多点原子修改**（`edits: [...]` 自底向上倒序应用，彻底消除行号漂移），内置 Zero-LLM AST 语法校验与调用方参数个数（Arity）防漂移守卫。
3. **重复任务走 Tool (`gf_exec` + `renameTo`)**：`gf_edit(renameTo="...")` 提供零 LLM 全库符号重命名；`gf_exec` 基于反向 Import 图从 `git diff` 毫秒级推导受影响单测（支持 `vitest` / `pytest` / `go test` / `cargo test` / `dotnet test`），并将通过日志压缩为 1 行 `PASS`（28 Tokens）。
4. **根据用户习惯来记忆生成工具 (`gf_macro` + 宿主拦截器)**：自动从轨迹中提炼**带参数槽位的命令模板**（`{{arg1}}`）、**高频协同修改文件对（Co-Edit Pairs）**、**目录级自动校验钩子（Auto-Verify Hooks）**以及独立 `.graphflow/macros/*.mjs` 脚本；同时提供 `PreToolUse` / `PostToolUse` 宿主拦截器，即使 Agent 误调原生 `Read` 读大文件（>250 行）或调原生 `Bash` 跑测试，也会被自动拦截并折叠为 AST 骨骼视图或脱水回执。

## 真实仓库基准测试对账 (Token 对比)

以下数据基于本仓库 5 个真实工程任务评测（详见 `benchmarks/run-v3-token-comparison.ts`）：

| 评测维度 | 旧版 / 原始方式 | GraphFlow 3.0 | 节省量 | 降幅 |
| :--- | ---: | ---: | ---: | ---: |
| **每轮固定 MCP Schema 税** | 5,897 Tokens / 轮 (10 工具) | **444 Tokens** / 轮 (4 极简工具) | -5,453 Tokens | **-92%** |
| **Cursor Rule / 规则文件前缀** | 1,899 Tokens (152 行) | **349 Tokens** (22 行) | -1,550 Tokens | **-82%** |
| **SKILL.md 技能说明文档** | 7,470 Tokens (717 行) | **671 Tokens** (42 行) | -6,799 Tokens | **-91%** |
| **5 个真实任务代码阅读上下文** | 132,294 Tokens (全文件读取) | **9,474 Tokens** (`gf_read` 精准切片) | -122,820 Tokens | **-93%** |
| **全量单测通过日志** | 2,114 Tokens (8.8KB 刷屏) | **28 Tokens** (1 行 `PASS` 回执) | -2,086 Tokens | **-99%** |

## 六大语言一等公民 AST 支持

| 语言体系 | 支持后缀 | AST 外科手术能力 |
| :--- | :--- | :--- |
| **TypeScript / JavaScript** | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` | `@babel/parser` 完整 AST、`interface`/`type`/`enum` 跨文件闭合、调用点切片、语法与参数个数守卫 |
| **Python** | `.py`, `.pyi` | 缩进感知 `def`/`async def`/`class`、`@dataclass`/`TypedDict` 闭合、`... # [lines X-Y folded]` 缩进折叠 |
| **C / C++** | `.c`, `.h`, `.cc`, `.cpp`, `.hpp`, `.cxx`, `.hxx` | 函数/`class`/`struct`/`enum` 提取、`#include` 头文件类型自动闭合、调用点切片、括号平衡守卫 |
| **C#** | `.cs` | `namespace`、`class`/`interface`/`struct`/`record`/`enum`、方法提取、`using` 闭合、调用点切片 |
| **Rust** | `.rs` | `pub fn`、`impl` 方法、`struct`/`enum`/`trait`、`use crate::...` 跨模块类型闭合、调用点切片 |
| **Go** | `.go` | `func` 与 Receiver 方法、`type ... struct/interface`、同包与跨包类型闭合、调用点切片 |

## 4 个核心 MCP 工具

| 工具 | 用途 | 输入参数 | 示例 |
| :--- | :--- | :--- | :--- |
| `gf_read` | 精准读取符号、浏览骨骼视图或搜索代码 | `targets?: string[]`, `q?: string`, `topK?: number`, `skeleton?: boolean` | `gf_read({ targets: ["src/config/resolve.ts#resolveEfficiencyPolicy"] })` |
| `gf_edit` | 单点/多点原子修改或零 LLM 全库重命名 | `file: string`, `symbol?: string`, `newCode?: string`, `edits?: [...]`, `renameTo?: string` | `gf_edit({ file: "src/foo.ts", symbol: "oldFn", renameTo: "newFn" })` |
| `gf_exec` | 执行受影响单测或命令并脱水日志输出 | `cmd?: string`, `changedFiles?: string[]`, `handle?: string` | `gf_exec({ cmd: "affected-tests" })` |
| `gf_macro` | 列表、执行或挖掘参数化宏与习惯工具 | `action: "list" \| "run" \| "save" \| "mine"`, `id?: string`, `args?: string[]` | `gf_macro({ action: "run", id: "tpl_91ab2c", args: ["src/foo.ts"] })` |

## 快速开始

### 1. 全局安装
```bash
npm install -g @roarpeng/graphflow
```

### 2. 向当前编程 Agent 自动注册
```bash
npx @roarpeng/graphflow install
```
支持自动检测并接入 Cursor、Claude Code、DeepSeek Harness (DSH)、Trae、Kimi Code、VS Code 等 20+ 款编程工具。注册配置自动写入 `GRAPHFLOW_MCP_PROFILE=v3`，Agent 开箱即得 4 个外科手术工具（删除该 env 行即可回退 10 工具 legacy 面）。

### 3. 本地启动 MCP 服务（手动）
```bash
GRAPHFLOW_MCP_PROFILE=v3 npx @roarpeng/graphflow-mcp
```

### 4. 运行验证与基准测试
```bash
npm run test:v3        # 运行 9 项全链路自动化测试（四大支柱 + 六大语言 + 宿主 Hook 拦截器）
npm run benchmark:v3   # 运行真实代码库 Token 对账基准测试
```

## 架构与深入文档

* [Token-First 架构设计与第一性原理 (docs/v3-architecture.md)](docs/v3-architecture.md)
* [GraphFlow + Serena 组合使用指南 (docs/graphflow-serena.zh.md)](docs/graphflow-serena.zh.md)
* [版本更新日志 (CHANGELOG.md)](CHANGELOG.md)
