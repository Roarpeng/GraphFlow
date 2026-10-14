# GraphFlow

> **The Token-First Surgical Code Engine for AI Coding Agents (v3.1.0)**
> First-class AST slicing across **TypeScript/JS, Python, C/C++, C#, Rust, and Go** · AST Skeleton Folding (93% fewer tokens than raw file reads) · Cross-repo Blast-Radius call-site micro-snippets, batch atomic edits, zero-LLM symbol rename & struct-field contract guard · Terminal output dehydrator (99% fewer test log tokens) · Zero-cold-start Git history co-change miner · Session read dedup & 3-strike thrashing circuit breaker · Habit memory & auto-compiled `.mjs` macros.

## Project Structure

```text
graphflow/
├── src/
│   ├── ast-engine.ts        # 6-Language AST parser (TS/JS, Python, Go, Rust, C/C++, C#) & struct field extractor
│   ├── slicer.ts            # gf_read: AST skeleton folding, symbol slicing & cross-file type closure
│   ├── blast-radius.ts      # Cross-repo 3-line call-site micro-snippets ([Blast Radius])
│   ├── surgical-edit.ts     # gf_edit: Bottom-up atomic batch edit, zero-LLM rename & static/struct guard
│   ├── dehydrator.ts        # gf_exec: Multi-language diff-to-test router & terminal output dehydrator
│   ├── macro-engine.ts      # gf_macro: Trajectory recorder, .mjs macro compiler & isomorphic auto-codemod
│   ├── git-miner.ts         # Zero-cold-start git log temporal coupling & cross-language co-change miner
│   ├── circuit-breaker.ts   # Session SHA-256 read dedup cache & 3-strike edit-test loop circuit breaker
│   ├── host-interceptor.ts  # PreToolUse & PostToolUse host hook interceptor
│   ├── mcp-tools.ts         # 4 surgical MCP tool schemas (452 tokens total) & tool dispatcher
│   ├── mcp-server.ts        # MCP stdio/JSON-RPC server entry point (graphflow-mcp)
│   ├── cli.ts               # CLI entry point (graphflow)
│   └── index.ts             # Public library entry point
├── tests/
│   └── graphflow.test.ts    # End-to-end automated test suite (13 suites)
├── mcp.json
├── package.json
└── tsconfig.json
```

## Four Surgical MCP Tools

| Tool | Purpose | Key Arguments | Example |
| :--- | :--- | :--- | :--- |
| `gf_read` | Surgical code reading, AST skeleton view, symbol search & session dedup | `targets?: string[]`, `q?: string`, `topK?: number`, `skeleton?: boolean`, `dedup?: boolean` | `gf_read({ targets: ["src/slicer.ts#executeSurgicalRead"] })` |
| `gf_edit` | Single/batch symbol or line edit, cross-repo rename & struct-field guard | `file: string`, `symbol?: string`, `newCode?: string`, `edits?: [...]`, `renameTo?: string` | `gf_edit({ file: "src/foo.ts", symbol: "oldFn", renameTo: "newFn" })` |
| `gf_exec` | Run affected tests or commands with output dehydration & loop circuit breaker | `cmd?: string`, `changedFiles?: string[]`, `handle?: string`, `run?: boolean` | `gf_exec({ cmd: "affected-tests", run: true })` |
| `gf_macro` | List, run, save, or mine auto-compiled macros, codemods & Git co-changes | `action: "list" \| "run" \| "save" \| "mine" \| "mine-git"`, `id?: string`, `args?: string[]` | `gf_macro({ action: "mine-git" })` |

## Quick Start

```bash
npm install
npm run build
npm test
```

### Register MCP & Host Hooks (Claude Code / Cursor)
```bash
npx @roarpeng/graphflow install
```
