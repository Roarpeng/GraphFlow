# GraphFlow

**English** | [简体中文](./README.zh.md)

[![npm](https://img.shields.io/npm/v/@roarpeng/graphflow)](https://www.npmjs.com/package/@roarpeng/graphflow)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![CI](https://github.com/Roarpeng/GraphFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Roarpeng/GraphFlow/actions/workflows/ci.yml)
[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-roarpeng.graphflow-blue)](https://marketplace.visualstudio.com/items?itemName=roarpeng.graphflow)

> **The Token-First Surgical Code Engine for AI Coding Agents (v3.2.1)**
> An MCP server exposing exactly 4 surgical tools — `gf_read`, `gf_edit`, `gf_exec`, `gf_macro` — with first-class AST support for **TS/JS, Python, Go, Rust, C/C++, C#** and only two runtime dependencies (`@babel/parser` + `@modelcontextprotocol/sdk`).

---

## GraphFlow 3.0 — The Radical Rewrite

Version 3.0 **replaced the entire 2.x architecture**. The 10-tool knowledge-graph / context-compression MCP surface (`graphflow_context`, `graphflow_plan`, `graphflow_run`, `graphflow_index`, `graphflow_insight`, `graphflow_skill_*`, `graphflow_diagnose`, `graphflow_artifact`), the episodic-skill flywheel, the VS Code graph-memory extension, and LLM routing were **all removed**. In their place: 4 deterministic surgical tools over a plain AST pipeline. MCP schema tax dropped **92%** (5897 → ~460 tokens per turn).

| 2.x (removed) | 3.x replacement |
| :--- | :--- |
| `graphflow_context(...)` | `gf_read({ targets, q, skeleton: true })` |
| `graphflow_plan` / `graphflow_run` | Removed — deterministic pipeline, no LLM routing |
| `graphflow_index` | Removed — AST index is built on demand |
| `graphflow_insight` / `graphflow_skill_*` | `gf_macro({ action: "mine" \| "mine-git" })` |
| `graphflow_diagnose` | `graphflow status` (CLI) |
| `graphflow_artifact` | `gf_macro({ action: "visualize" })` → `.graphflow/knowledge-graph.html` |
| `GRAPHFLOW_MCP_PROFILE` env | Removed — the 4 `gf_*` tools are the only surface |
| VS Code graph-memory extension | Thin prebuilt launcher (see [VSIX-INSTALL.md](./VSIX-INSTALL.md)) |
| Dialogue / workbench memory features | Removed with the flywheel; `gf_read({ targets: ["@brief"] })` covers cross-session handoff |

**2.x users must switch tool calls `graphflow_*` → `gf_*`.** There is no compatibility layer.

| Version | Notes |
| :--- | :--- |
| 2.3.0 | Last legacy release (10-tool knowledge-graph MCP) |
| 3.0.0 | Radical rewrite — breaking, 4 surgical tools |
| 3.1.0 | 21-agent installer, 3-strike circuit breaker, git co-change miner, struct-field contract guard |
| 3.1.1 | Thin prebuilt VS Code extension, VSIX on GitHub Releases |
| 3.2.0 | Doc-graph (cross-agent brief, doc↔code linking, HTML knowledge graph) + bilingual tokenizer |
| **3.2.1** | **Fix pack: affected-tests honors `package.json` `scripts.test`, `gf_exec` `run:true` execute-vs-preview gating, brief hub in-degree for extension-ful imports** |

## The Four Surgical Tools

| Tool | Purpose | Key arguments |
| :--- | :--- | :--- |
| `gf_read` | Symbol slices with cross-file type closure + `[Blast Radius]` call sites, AST skeleton folding, bilingual search, `@brief` cross-agent handoff | `targets`, `q`, `topK`, `skeleton`, `dedup` |
| `gf_edit` | In-place / batch atomic edits, zero-LLM cross-repo rename, struct-field contract guard | `file`, `symbol`, `newCode`, `edits`, `renameTo` |
| `gf_exec` | Diff-to-test routing (honors `package.json` `scripts.test`) + output dehydrator: passing suites → 1-line `PASS`; `run: true` executes, otherwise preview | `cmd`, `changedFiles`, `handle`, `run` |
| `gf_macro` | Habit macros, git co-change mining, knowledge-graph HTML export | `action: "list" \| "run" \| "save" \| "mine" \| "mine-git" \| "visualize" \| "brief"` |

Session read dedup skips unchanged files; 3 consecutive edit-test failures trigger a deterministic rescue packet (blast-radius contracts + recent git diffs).

## What's New in 3.2.0

### Doc-Graph (`src/doc-graph.ts`)

- **Cross-agent onboarding brief** — persisted in `.graphflow/cross-agent-brief.json`, served as a ~300-token `@brief` target:
  - `gf_read({})` in a fresh session automatically includes architecture hubs, the last agent's modified symbols and test status.
  - `gf_read({ targets: ["@brief"] })` returns the full handoff brief: hubs + modified symbols + test status + linked design docs + compiled macros.
- **Multi-format doc↔code linking** — `.md`, `.html`, `.xml`, `.docx`, `.pdf`, with zero-dependency native zlib parsers:
  - `.docx` parsed via native ZIP Central Directory + `zlib.inflateRawSync` on `word/document.xml` — link a Word design spec section to the symbols it names.
  - `.pdf` parsed via `zlib.inflateSync` on `/FlateDecode` streams + `BT..ET` text extraction — link a PDF interface protocol to the implementing function.
  - PLCopen / config XML sections link to the parser symbols they describe.
- **Interactive knowledge graph** — `graphflow graph` exports `.graphflow/knowledge-graph.html`, a single-file force-directed canvas with search, node filtering, and a click inspector (files, symbols, docs, macros).

### Bilingual Tokenizer (`src/tokenizer.ts`)

One query engine for Chinese and English code search:

- **Pinyin bidirectional index** — `gf_read({ q: "dingdan chaoshi" })` resolves to `订单超时`; `q: "订单支付"` also emits `dingdan`/`zhifu` to match legacy pinyin-named identifiers such as `handleDingDanZhiFu`.
- **Chinese synonym clusters** — `q: "取消订单"` also matches `作废/撤单/撤销`; `支付 ↔ 付款/收款/结账`, `用户 ↔ 客户/买家/会员/账号`, `校验 ↔ 验证/验签/核对/检查`.
- **Homophone typo correction** — IME typos auto-corrected: `定单钞时取销 → 订单超时取消`, `回掉验千 → 回调验签`, `事物回滚 → 事务回滚`, `登陆帐号 → 登录账号`.
- **English fuzzy matching** — camelCase/snake_case splitting (`resolveEfficiencyPolicy → resolve/efficiency/policy`), stemming, and edit-distance-1 tolerance (`cancle → cancel`, `expried → expired`).

## Benchmarks

| Metric | Baseline | GraphFlow 3.x | Saving |
| :--- | :--- | :--- | :--- |
| MCP tool schema tax / turn | 5897 tokens (2.x, 10 tools) | 444 tokens (4 tools) | **−92%** |
| Large-file read | raw file read | AST skeleton folding | **−93%** |
| Passing test suite output | full log | 1-line `PASS` receipt | **−99%** |

## Supported Languages

| Language | First-class AST |
| :--- | :--- |
| TypeScript / JavaScript | Yes (`@babel/parser`) |
| Python | Yes |
| Go | Yes |
| Rust | Yes |
| C / C++ | Yes |
| C# | Yes |

Runtime dependencies: `@babel/parser` + `@modelcontextprotocol/sdk`. Nothing else.

## Quick Start

```bash
# 1) Install globally (Node 18+)
npm install -g @roarpeng/graphflow@3.2.1

# 2) One-click registration into detected agents (MCP + Skill + Rules + Hooks)
graphflow install            # equivalent: npx @roarpeng/graphflow install

# 3) Launch the MCP server (stdio)
graphflow-mcp
```

Skill-only entry via the [skills.sh](https://skills.sh) ecosystem (installs the agent skill; it then bootstraps the MCP server with `npx @roarpeng/graphflow@latest install`):

```bash
npx skills add Roarpeng/GraphFlow
```

Manual MCP registration (any agent):

```json
{ "mcpServers": { "graphflow": { "command": "graphflow-mcp" } } }
```

Run the test suite from source:

```bash
git clone https://github.com/Roarpeng/GraphFlow && cd GraphFlow
npm install && npm test      # tsx tests/graphflow.test.ts
```

## VS Code Extension

A thin prebuilt launcher (`roarpeng.graphflow`) with three commands: **Install MCP, Skills & Hooks to Agents**, **Mine Git Co-Change History**, **Show Detected Agents Status**.

- Marketplace: search "GraphFlow" — https://marketplace.visualstudio.com/items?itemName=roarpeng.graphflow
- Open VSX: https://open-vsx.org/extension/roarpeng/graphflow
- Manual VSIX: download `graphflow-<version>.vsix` from https://github.com/Roarpeng/GraphFlow/releases → `code --install-extension graphflow-<version>.vsix`

Full steps: [VSIX-INSTALL.md](./VSIX-INSTALL.md).

## 21-Agent Auto-Installer

`graphflow install` auto-detects installed agents and registers MCP + Skill + Rules + PreToolUse/PostToolUse hooks; `graphflow uninstall` removes everything cleanly.

| Group | Agents |
| :--- | :--- |
| IDE / editors | Cursor, VS Code (GitHub Copilot), Windsurf, Trae / Trae CN, Zed |
| Terminal agents | Claude Code, OpenAI Codex, Gemini CLI, Antigravity, Kimi Code, DeepSeek Harness (DSH), OpenCode, ZCode |
| Extension-hosted | Cline, Roo Code, Kilo Code, Continue, PearAI, Qoder / Qoder CN |
| Desktop / cloud | Claude Desktop, Amazon Q |

Scope an install with `graphflow install --agents cursor,claude-code --workspace`.

## CLI Reference

| Command | Purpose |
| :--- | :--- |
| `graphflow install [--workspace] [--agents <id1,id2>]` | Register MCP + Skill + Rules + Hooks in detected agents |
| `graphflow uninstall` | Cleanly remove all GraphFlow registrations |
| `graphflow status` | List detected agents and registration state |
| `graphflow read [targets...] [-q <query>] [--skeleton] [--dedup]` | Surgical read from the terminal |
| `graphflow edit <file> [--symbol <sym>] [--new <code>] [--rename <name>]` | Surgical edit / rename |
| `graphflow exec [cmd] [--run]` | Run `affected-tests` or any command with dehydration (`--run` executes, otherwise preview) |
| `graphflow macro <list\|run\|save\|mine\|mine-git> [id] [args...]` | Macros and git co-change mining |
| `graphflow graph` | Export `.graphflow/knowledge-graph.html` |
| `graphflow brief` | Print the cross-agent handoff brief |
| `graphflow hook <pre-tool\|post-tool>` | Host hook interceptor entry (internal) |
| `graphflow version \| help` | Version / usage |

## Docs

- [README.zh.md](./README.zh.md) — Chinese documentation
- [VSIX-INSTALL.md](./VSIX-INSTALL.md) — VS Code extension install guide (EN + 中文)
- [skills/graphflow/SKILL.md](./skills/graphflow/SKILL.md) — agent-facing skill definition
- [Releases](https://github.com/Roarpeng/GraphFlow/releases) · [Issues](https://github.com/Roarpeng/GraphFlow/issues) · [License: Apache-2.0](./LICENSE)
