---
name: graphflow
version: 3.9.2
display_name: GraphFlow 外科手术级代码引擎
display_name_en: GraphFlow Surgical Code Engine
author: roarpeng
description: Use GraphFlow's four MCP tools to inspect, edit, test, and automate code in an indexed workspace.
description_zh: 使用 GraphFlow 四个 MCP 工具定位、修改、测试代码并管理本地宏。
description_en: Use GraphFlow's four MCP tools to inspect, edit, test, and automate code in an indexed workspace.
allowed-tools:
  - "gf_read"
  - "gf_edit"
  - "gf_exec"
  - "gf_macro"
examples_zh:
  - "定位函数和调用方"
  - "预览并安全提交跨文件修改"
  - "运行受影响的测试"
examples_en:
  - "Locate a function and its callers"
  - "Prepare and commit a guarded edit"
  - "Run affected tests"
---

# GraphFlow

Use the four GraphFlow MCP tools for supported code exploration, edits and targeted tests. Pass the absolute workspace path as `rootDir` when workspace resolution is uncertain.

- `gf_read`: use `targets` for `file#symbol` or `q` for keywords. Optional `detail`, `maxOutputTokens`, `sinceReceipt` and `cursor` control output and continuation. A receipt is tied to the branch and source hashes.
- `gf_edit`: use `mode: "prepare"` to review the diff and diagnostics, then `mode: "commit"` with `proposalId`. Stale snapshots are rejected. Contract errors block by default; `policy: "warn"` is an explicit compatibility override. Multi-file rollback uses a recovery journal.
- `gf_exec`: use `cmd: "affected-tests"` to select relevant tests; `planOnly` previews selection and `run: true` executes. Treat `NO_TESTS`, `UNKNOWN` and `TIMEOUT` separately from `PASS`. Repeated identical failures stop execution until a reasoned override or new evidence.
- `gf_macro`: inspect and explicitly approve and activate effectful macros before running them. Command parameters are passed as argv; verified recipes recheck their verification command.

MCP requires a running GraphFlow server. Install a matching GraphFlow runtime and register `graphflow-mcp` in WorkBuddy's MCP configuration; a skill package alone does not install the server. The v4 development behavior requires the accompanying runtime build. Token counts are estimates unless the host supplies usage.
