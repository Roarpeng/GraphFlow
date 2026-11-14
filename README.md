# GraphFlow

**English** | [简体中文](./README.zh.md)

[![npm](https://img.shields.io/npm/v/@roarpeng/graphflow)](https://www.npmjs.com/package/@roarpeng/graphflow)
[![CI](https://github.com/Roarpeng/GraphFlow/actions/workflows/ci.yml/badge.svg)](./.github/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-roarpeng.graphflow-blue)](https://marketplace.visualstudio.com/items?itemName=roarpeng.graphflow)

**Token-first surgical code engine for coding agents.** The package is currently v3.9.2; this checkout includes the v4 local safety and evidence upgrade. The engine exposes four deterministic MCP tools and runs locally.

## The Four Surgical Tools

| Tool | Capability |
| :--- | :--- |
| `gf_read` | Slice exact symbols (`file.ts#fn`) with cross-file type closure + blast-radius call sites; bilingual keyword search (`q: "启动 / launch"`); AST skeleton fold (−93% tokens). |
| `gf_edit` | Symbol/line edits and cross-repo rename with write-before checks, optional prepare/commit proposals, SHA conflict checks and recoverable multi-file commits. |
| `gf_exec` | `affected-tests` routing (up to 6 reverse-import hops) or any command with dehydrated output: 1-line `PASS` receipt, 5-line failure source window, 3-strike circuit breaker. `run:true` executes; otherwise preview. |
| `gf_macro` | Local habit macros and verified recipes. Effectful macros require propose → approve → activate; command templates use argv execution and codemods use the edit transaction. |

## Prompt Reflex

A prompt matching a command macro receives a hint until that macro is explicitly authorized. Command and file-writing macros do not auto-run from the prompt hook. Kill switch: `GRAPHFLOW_PROMPT_REFLEX=0`.

- **Tier 1 — prompt hook** (auto-registered): ZCode, Claude Code, Codex CLI, Gemini CLI, Cursor, Windsurf, Trae, Qoder, Kimi Code, Continue CLI.
- **Tier 2 — inject/rewrite**: OpenCode, Kilo Code, Cline (Unix), DeepSeek Harness.
- **Tier 3 — fallback** (`gf_macro` MCP): VS Code Copilot, Zed, Claude Desktop, PearAI, Antigravity, Roo Code (archived).

Details, per-host config and security notes: [docs/prompt-reflex.md](./docs/prompt-reflex.md).

## Quick Start

```bash
npm install -g @roarpeng/graphflow   # Node 18+
graphflow install                     # register MCP + Skill + Rules + Hooks into detected agents
graphflow status                      # per-agent registration state
graphflow-mcp                         # stdio MCP server
```

Skill-only entry: `npx skills add Roarpeng/GraphFlow`. Manual MCP block for hosts that read `mcpServers` JSON: `{ "mcpServers": { "graphflow": { "command": "graphflow-mcp" } } }`.

## Supported Languages

| Language | Backend |
| :--- | :--- |
| TypeScript / JavaScript | True AST (`@babel/parser`) |
| Python / Go / Rust / C / C++ / C# | True AST via optional `tree-sitter-*` grammars (structural fallback when absent; `GRAPHFLOW_TREE_SITTER=0` disables) |

Runtime deps: `@babel/parser`, `@modelcontextprotocol/sdk`, `tree-sitter` + optional grammars. tree-sitter is syntax-only; cross-file type inference stays heuristic with documented limits.

## 22-Agent Auto-Installer

`graphflow install` detects agents and registers MCP + Skill + Rules + Hooks — hook merges are idempotent and preserve user entries; `graphflow uninstall` removes only GraphFlow-owned registrations. Scope with `--agents <id1,id2>` / `--all` / `--workspace`.

Covers: Cursor, VS Code, Windsurf, Trae, Zed, Claude Code, Codex, Gemini CLI, Antigravity, Kimi Code, DeepSeek Harness, OpenCode, ZCode, Cline, Roo Code, Kilo Code, Continue, PearAI, Qoder, Claude Desktop, Amazon Q, WorkBuddy.

## DeepSeek Harness (DSH)

DSH reads Cordis patches, not `mcp.json`. `graphflow install` writes a managed block (`# GRAPHFLOW-DSH-BEGIN/END`) into `~/.dsh/cordis.patch.yml` with `cwd` pinned to your workspace — run it **from the workspace** so relative targets resolve. Alternative: the configuration-only `@roarpeng/graphflow-dsh` bundle (use one or the other; both = duplicate row).

## VS Code Extension

Marketplace / Open VSX: search "GraphFlow" (`roarpeng.graphflow`) — prebuilt launcher with Install / Mine-git / Status commands. Manual VSIX steps: [VSIX-INSTALL.md](./VSIX-INSTALL.md).

## CLI Reference

| Command | Purpose |
| :--- | :--- |
| `graphflow install [--workspace] [--agents <id1,id2>]` | Register MCP + Skill + Rules + Hooks in detected agents (merges host hooks; user hooks preserved) |
| `graphflow uninstall [--agents <id1,id2>] [--all]` | Remove GraphFlow registrations (owned entries only); default detected agents, `--all` cleans every profile |
| `graphflow status [--agents <id1,id2>] [--all]` | Per-agent registration state (`[MCP ✓] [Skill ✓] [Rule -] [Hook ✓]`) |
| `graphflow read [targets...] [-q <query>] [--detail locate\|summary\|code\|closure] [--max-output-tokens N]` | Surgical read, receipt and cursor pagination |
| `graphflow edit <file> [--symbol <sym>] [--new <code>] [--prepare]` / `graphflow edit --proposal-id <id>` | Prepare or commit a guarded edit; add `--policy warn` only for a deliberate compatibility override |
| `graphflow exec [cmd] [--run] [--plan-only] [--verify-level fast\|safe\|full]` | Affected-test plan or command with structured test evidence |
| `graphflow macro <list\|propose\|approve\|activate\|revoke\|run\|verify\|recipe-run> [id]` | Macro trust and verified recipes |
| `graphflow task <list\|show\|record\|run\|log\|harvest>` | Local task reflection: record, promote repeated instructions, replay offline |
| `graphflow reflect "<instruction>" [args...]` | Run the recorded/near-match task for an instruction locally (MISS when unknown) |
| `graphflow flywheel [--prune] [--ttl-days N]` | Session-journal health check: pending-episode backlog, status split, oldest age, over-TTL count; `--prune` removes pending episodes older than TTL days (default 30), other kinds kept |
| `graphflow hook <pre-tool\|post-tool\|user-prompt> [--protocol generic\|cursor\|gemini]` | Host hook interceptor entry (internal) |
| `graphflow graph` / `graphflow brief` | Knowledge-graph HTML export / cross-agent handoff brief |
| `graphflow doctor parsers [--strict]` / `graphflow parsers` | Tree-sitter engine diagnostics (`--strict` exits non-zero without true AST) |
| `graphflow version \| help` | Version / usage |

## Environment & Tuning

| Variable | Default | Effect |
| :--- | :--- | :--- |
| `GRAPHFLOW_EXEC_TIMEOUT_MS` | `600000` | Wall-clock budget for one `gf_exec` command. A run stopped by it returns `TIMEOUT` (exit 124) with the last output lines and a handle — never a plain `FAIL`. |
| `GRAPHFLOW_MAX_FILES` | `20000` | Workspace scan cap. Earlier builds hard-coded 5 000 and silently truncated larger trees. |
| `GRAPHFLOW_SEMANTIC_CACHE` | on | Persist the L0 semantic index (`semantic-index.json` plus a `semantic-index-delta.json` overlay). `=0` disables. |
| `GRAPHFLOW_SEMANTIC_FRESH_MS` | `50` | Staleness re-check window for the semantic index; `0` re-checks on every query. |
| `GRAPHFLOW_NAME_INDEX` | on | Persisted per-file identifier set used to pre-filter blast-radius candidates without reading sources. `=0` falls back to byte scans. |
| `GRAPHFLOW_AST_CACHE` | on | AST shard persistence under `.graphflow/ast-cache/`. |
| `GRAPHFLOW_GRAPH_DEBUG` | off | Print per-stage timings for the knowledge-graph build. |

Measured on a synthetic 9 902-file workspace: single-symbol read with blast radius **0.62–0.69 s**, knowledge graph rebuild with no changes **0.17–0.28 s**, with one file changed **~1.7 s**, full cold build **~30 s**.

## Development

```bash
npm install && npm test        # full test suite (incl. MCP stdio e2e)
npm run build                  # tsc → dist/
npm run bench                  # local benchmark → benchmarks/latest.md
npm run verify:parsers         # true-AST vs structural matrix
npm run preflight              # static release checks
node scripts/v4-ab-report.mjs --check-corpus  # validate the 30-task v4 A/B corpus
```

## Docs

- [v4 development upgrade and A/B protocol](./docs/v4-upgrade.md)
- [Prompt Reflex — host matrix & config](./docs/prompt-reflex.md)
- [VSIX install](./VSIX-INSTALL.md)
