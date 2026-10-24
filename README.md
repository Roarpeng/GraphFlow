# GraphFlow

**English** | [简体中文](./README.zh.md)

[![npm](https://img.shields.io/npm/v/@roarpeng/graphflow)](https://www.npmjs.com/package/@roarpeng/graphflow)
[![CI](https://github.com/Roarpeng/GraphFlow/actions/workflows/ci.yml/badge.svg)](./.github/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-roarpeng.graphflow-blue)](https://marketplace.visualstudio.com/items?itemName=roarpeng.graphflow)

**Token-first surgical code engine for coding agents (v3.7.1).** Four deterministic MCP tools plus a **0-LLM prompt reflex** — all local, no LLM in the engine loop.

## The Four Surgical Tools

| Tool | Capability |
| :--- | :--- |
| `gf_read` | Slice exact symbols (`file.ts#fn`) with cross-file type closure + blast-radius call sites; bilingual keyword search (`q: "启动 / launch"`); AST skeleton fold (−93% tokens). |
| `gf_edit` | In-place symbol/line edits, bottom-up atomic batches, cross-repo rename — with AST syntax rollback, caller-arity and struct-field guards. |
| `gf_exec` | `affected-tests` routing (2-hop reverse imports) or any command with dehydrated output: 1-line `PASS` receipt, 5-line failure source window, 3-strike circuit breaker. `run:true` executes; otherwise preview. |
| `gf_macro` | Habit-mined deterministic macros: repeated reads → context bundles, repeated commands → 1-step pipelines / parameterized templates, isomorphic edits → codemods. Zero LLM turns to replay. |

## Prompt Reflex (0-LLM Local Reaction)

A short command-like prompt (e.g. `启动项目`) that matches a macro trigger **executes the macro locally and blocks the prompt from reaching the model**; longer prompts get an injected hint; anything else passes through. Kill switch: `GRAPHFLOW_PROMPT_REFLEX=0`.

- **Tier 1 — full block** (auto-registered): ZCode, Claude Code, Codex CLI, Gemini CLI, Cursor, Windsurf, Trae, Qoder, Kimi Code, Continue CLI.
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
| `graphflow read [targets...] [-q <query>] [--skeleton] [--dedup]` | Surgical read from the terminal |
| `graphflow edit <file> [--symbol <sym>] [--new <code>] [--rename <name>]` | Surgical edit / rename |
| `graphflow exec [cmd] [--run] [--root <dir>]` | Affected-tests routing or any command with dehydration (`--run` executes, otherwise preview) |
| `graphflow macro <list\|run\|save\|mine\|mine-git> [id] [args...]` | Macros and git co-change mining |
| `graphflow task <list\|show\|record\|run\|log\|harvest>` | Local task reflection: record, promote repeated instructions, replay offline |
| `graphflow reflect "<instruction>" [args...]` | Run the recorded/near-match task for an instruction locally (MISS when unknown) |
| `graphflow hook <pre-tool\|post-tool\|user-prompt> [--protocol generic\|cursor\|gemini]` | Host hook interceptor entry (internal) |
| `graphflow graph` / `graphflow brief` | Knowledge-graph HTML export / cross-agent handoff brief |
| `graphflow doctor parsers [--strict]` / `graphflow parsers` | Tree-sitter engine diagnostics (`--strict` exits non-zero without true AST) |
| `graphflow version \| help` | Version / usage |

## Development

```bash
npm install && npm test        # 40 test files (incl. MCP stdio e2e)
npm run build                  # tsc → dist/
npm run bench                  # local benchmark → benchmarks/latest.md
npm run verify:parsers         # true-AST vs structural matrix
npm run preflight              # static release checks
```

## Docs

- [Prompt Reflex — host matrix & config](./docs/prompt-reflex.md)
- [VSIX install](./VSIX-INSTALL.md)
