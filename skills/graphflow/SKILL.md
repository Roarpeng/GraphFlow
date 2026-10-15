---
name: graphflow
description: Token-First Surgical Code Engine (gf_read, gf_edit, gf_exec, gf_macro) for TS/JS, Python, Go, Rust, C/C++, C# — AST symbol slicing with blast-radius guards, dehydrated test logs (1-line PASS), bilingual 中文/pinyin code search, git co-change habit macros. 外科手术级省 Token 代码引擎：符号切片、爆炸半径守卫、测试日志脱水、双语检索、习惯宏。
---

# GraphFlow — Token-First Surgical Engine (外科手术级省 Token 引擎)

Always prefer the 4 surgical `gf_*` MCP tools over raw full-file reads or verbose test runs (请优先使用以下 4 个 `gf_*` 工具代替整文件读取与全量测试):

1. **`gf_read`** (`targets`, `q`, `topK`, `skeleton`, `dedup`):
   - Read exact symbols (`"src/file.ts#symbol"`, `"src/file.ts:L1-L2"`) with automatic **Cross-File Type Closure** and `[Blast Radius]` caller snippets (精准读取目标函数/类，自动附带跨文件类型定义与调用点爆炸半径).
   - Bilingual keyword search (`q: "keyword / 中文关键词 / pinyin"`) across symbol names, docstrings and comments.
   - Fold large files into AST skeletons (`"src/file.ts"`, `skeleton: true`) and pass `dedup: true` to skip unchanged files.
2. **`gf_edit`** (`file`, `symbol`, `newCode`, `edits`, `renameTo`):
   - Edit symbols or line ranges in-place, apply multi-file atomic batch `edits` bottom-up with zero line drift, or run zero-LLM cross-repo symbol rename (`renameTo`).
   - Enforces instant AST syntax rollback, caller-arity checks, and struct/interface field deletion guards (语法错误自动回滚、调用方参数个数校验、结构体字段删除引用守卫).
3. **`gf_exec`** (`cmd`, `changedFiles`, `handle`, `run`):
   - Run `cmd: "affected-tests"` (2-hop reverse import router, honors `package.json` `scripts.test`) or any command with output dehydration.
   - **`run: true` is required to execute — without it the call is a preview only** (必须传 `run: true` 才执行，否则仅返回预览；测试通过仅回 1 行 `PASS`；报错内联 5 行源码上下文；连续 3 次失败触发死循环熔断急救包).
   - Recall full archived output any time via the returned `handle` + `range`.
4. **`gf_macro`** (`action: "list" | "run" | "save" | "mine" | "mine-git" | "visualize" | "brief"`):
   - Mine git history co-change coupling (`mine-git`), run auto-compiled `.graphflow/macros/*.mjs` scripts with zero LLM turns, or export the interactive knowledge-graph HTML.

## Setup — register the MCP server (安装 MCP 服务器)

This skill is the usage layer; the `gf_*` tools live in the GraphFlow MCP server. If they are not registered yet, run:

```bash
npx @roarpeng/graphflow@latest install
```

That auto-detects your agents and registers MCP + Skills + Rules + Hooks. Or register manually (any agent):

```json
{ "mcpServers": { "graphflow": { "command": "npx", "args": ["-y", "@roarpeng/graphflow@latest", "graphflow-mcp"] } } }
```

Verify with `graphflow status`, then call `gf_read({ targets: ["src/some-file.ts"], skeleton: true })` for a ~300-token project orientation (`@brief` target returns the cross-agent handoff brief).
