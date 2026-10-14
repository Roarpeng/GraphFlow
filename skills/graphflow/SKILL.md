---
name: graphflow
description: Token-First Surgical Code Engine (gf_read, gf_edit, gf_exec, gf_macro) across TS/JS, Python, Go, Rust, C/C++, and C#.
---

# GraphFlow 3.1 — Token-First Surgical Engine

Always prefer the 4 surgical `gf_*` MCP tools over raw full-file reads or verbose test runs:

1. **`gf_read`** (`targets`, `q`, `skeleton`, `dedup`):
   - Read exact symbols (`"src/file.ts#symbol"`) with automatic **Cross-File Type Closure** and 3-line **`[Blast Radius]`** caller micro-snippets.
   - Fold large files into AST skeletons (`"src/file.ts"`, `skeleton: true`) cutting token cost by 93%.
   - Pass `dedup: true` in long sessions to skip re-reading unchanged files (SHA-256 cache).
2. **`gf_edit`** (`file`, `symbol`, `newCode`, `edits`, `renameTo`):
   - Edit symbols or line ranges in-place, apply multi-file atomic batch `edits` bottom-up with zero line drift, or run zero-LLM cross-repo symbol rename (`renameTo`).
   - Enforces instant AST syntax rollback, caller-arity checks, and struct/interface field deletion guards.
3. **`gf_exec`** (`cmd`, `changedFiles`, `handle`, `run`):
   - Run `cmd: "affected-tests"` (2-hop reverse import router) or any command with output dehydration (passing runs = 1-line `PASS` receipt; failures inline exact 5-line source context; 3 consecutive failures trigger the loop circuit breaker).
4. **`gf_macro`** (`action: "list" | "run" | "save" | "mine" | "mine-git"`):
   - Mine git history co-change coupling (`action: "mine-git"`) or run auto-compiled `.graphflow/macros/*.mjs` scripts and isomorphic codemods with zero LLM turns.
