# GraphFlow

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/@roarpeng/graphflow)](https://www.npmjs.com/package/@roarpeng/graphflow)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4D6BFE?labelColor=1f2430)](https://github.com/topics/dsh-plugin)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20HTTP-6E56CF)](https://modelcontextprotocol.io)

> **The Token-First Surgical Code Engine for AI Coding Agents.**
> First-class AST slicing across **TypeScript/JS, Python, C/C++, C#, Rust, and Go** · AST Skeleton Folding (93% fewer tokens than raw file reads) · Cross-repo Blast-Radius call-site micro-snippets, batch atomic edits & zero-LLM symbol rename · Terminal output dehydrator (99% fewer test log tokens) · Host `PreToolUse` / `PostToolUse` transparent token-guard interceptor · Habit memory & trajectory auto-macros.

GraphFlow is designed around **Four Token-First Principles**:

1. **Precise Context Feeding (`gf_read`)**: First-class AST skeleton folding across **TS/JS, Python, C/C++, C#, Rust, and Go** (collapses non-target function bodies with exact 1-based line numbers) + verbatim target symbol declaration + automatic cross-file Type Closure + Co-Edit habit hints.
2. **Surgical Modification (`gf_edit`)**: Automatically attaches 3-line cross-repo call-site micro-snippets (`[Blast Radius]`) so agents can update definitions and callers in 1 turn; supports single or **batch atomic edits** (`edits: [...]` applied bottom-up with zero line drift), **zero-LLM cross-repo symbol rename** (`renameTo`), and instant AST syntax & caller-arity verification.
3. **Deterministic Tool Execution (`gf_exec`)**: Multi-language 2-hop Diff-to-Test router detects affected test files from `git diff` in <15ms (`vitest`, `pytest`, `go test`, `cargo test`, `dotnet test`); output dehydrator compresses passing suites to a 1-line `PASS` receipt (28 tokens) and isolates exact assertion failures with inlined source context.
4. **Habit Memory & Auto-Macros (`gf_macro` + Host Interceptor)**: Records action trajectories to learn **parameterized command templates** (`{{arg1}}`), **co-edit file pairs**, **directory auto-verify hooks**, and standalone `.graphflow/macros/*.mjs` scripts. Includes `PreToolUse` / `PostToolUse` host hooks that automatically fold raw `Read` calls on large files (>250 lines) and dehydrate verbose `Bash` outputs.

## Real Repository Benchmark Results

Measured across 5 real engineering tasks on this repository (see `benchmarks/run-v3-token-comparison.ts`):

| Metric | Legacy / Raw Approach | GraphFlow 3.0 | Tokens Saved | Reduction |
| :--- | ---: | ---: | ---: | ---: |
| **Per-Turn MCP Tool Schema Tax** | 5,897 Tokens / turn (10 tools) | **444 Tokens** / turn (4 surgical tools) | -5,453 Tokens | **-92%** |
| **Cursor Rule / Instruction Prefix** | 1,899 Tokens (152 lines) | **349 Tokens** (22 lines) | -1,550 Tokens | **-82%** |
| **SKILL.md Documentation** | 7,470 Tokens (717 lines) | **671 Tokens** (42 lines) | -6,799 Tokens | **-91%** |
| **5 Real Task Code Contexts** | 132,294 Tokens (raw file reads) | **9,474 Tokens** (`gf_read` surgical slices) | -122,820 Tokens | **-93%** |
| **Full Test Suite Passing Output** | 2,114 Tokens (8.8KB log) | **28 Tokens** (1-line `PASS` receipt) | -2,086 Tokens | **-99%** |

## Supported Languages (First-Class AST Slicing & Static Guard)

| Language | Extensions | AST Capabilities |
| :--- | :--- | :--- |
| **TypeScript / JavaScript** | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` | `@babel/parser` AST, interfaces/types/enums, imports, call sites, syntax & arity guard |
| **Python** | `.py`, `.pyi` | Indentation-scoped `def`/`async def`/`class`, `@dataclass`/`TypedDict` closure, `# [lines X-Y folded]` |
| **C / C++** | `.c`, `.h`, `.cc`, `.cpp`, `.hpp`, `.cxx`, `.hxx` | Functions, `class`/`struct`/`enum`, `#include` header type closure, call sites, brace balance guard |
| **C#** | `.cs` | `namespace`, `class`/`interface`/`struct`/`record`/`enum`, methods, `using`, call sites |
| **Rust** | `.rs` | `pub fn`, `impl` methods, `struct`/`enum`/`trait`, `use crate::...` type closure, call sites |
| **Go** | `.go` | `func` & receiver methods, `type ... struct/interface`, same-package & imported type closure |

## Four Surgical MCP Tools

| Tool | Purpose | Key Arguments | Example |
| :--- | :--- | :--- | :--- |
| `gf_read` | Surgical code reading, AST skeleton view, or symbol search | `targets?: string[]`, `q?: string`, `topK?: number`, `skeleton?: boolean` | `gf_read({ targets: ["src/config/resolve.ts#resolveEfficiencyPolicy"] })` |
| `gf_edit` | Single/batch symbol or line edit, or cross-repo rename | `file: string`, `symbol?: string`, `newCode?: string`, `edits?: [...]`, `renameTo?: string` | `gf_edit({ file: "src/foo.ts", symbol: "oldFn", renameTo: "newFn" })` |
| `gf_exec` | Run affected tests or commands with output dehydration | `cmd?: string`, `changedFiles?: string[]`, `handle?: string` | `gf_exec({ cmd: "affected-tests" })` |
| `gf_macro` | List, run, save, or mine auto-compiled macros & habits | `action: "list" \| "run" \| "save" \| "mine"`, `id?: string`, `args?: string[]` | `gf_macro({ action: "run", id: "tpl_91ab2c", args: ["src/foo.ts"] })` |

## Quick Start

### 1. Global Installation
```bash
npm install -g @roarpeng/graphflow
```

### 2. Auto-Register with Connected Agents
```bash
npx @roarpeng/graphflow install
```
Automatically registers MCP, rules, skills, and `PreToolUse`/`PostToolUse` hooks for Cursor, Claude Code, DeepSeek Harness (DSH), Trae, Kimi Code, VS Code, and 15+ coding agents. Registered configs set `GRAPHFLOW_MCP_PROFILE=v3` so agents get the 4 surgical tools out of the box (remove that env line to restore the 10-tool legacy surface).

### 3. Launch MCP Server (manual)
```bash
GRAPHFLOW_MCP_PROFILE=v3 npx @roarpeng/graphflow-mcp
```

### 4. Run Test Suite and Token Benchmark
```bash
npm run test:v3        # Run 9-part automated test suite (4 pillars + 6 languages + host hooks)
npm run benchmark:v3   # Run real-repository token comparison benchmark
```

## Documentation

* [Token-First Architecture & Design Principles (docs/v3-architecture.md)](docs/v3-architecture.md)
* [GraphFlow + Serena: better together (docs/graphflow-serena.md)](docs/graphflow-serena.md)
* [Changelog & Release Notes (CHANGELOG.md)](CHANGELOG.md)
