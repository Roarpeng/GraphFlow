# GraphFlow

[![npm version](https://img.shields.io/badge/npm-1.9.12-blue)](https://www.npmjs.com/package/@roarpeng/graphflow)

> **The memory & context harness for coding agents.** Local-first code knowledge graph · bounded context compression (~98% token savings) · cross-session learning flywheel.

The community is converging on an "agent harness" vocabulary: **memory + hooks + skills** are the harness primitives that turn a stateless model into a reliable long-running agent. GraphFlow implements all three for coding agents and ships them through a portable MCP surface (Cursor, Claude Code, 15+ agents):

| Harness primitive | GraphFlow implementation |
| --- | --- |
| **Memory** | 12-language AST code graph + Episodic / Skill / Decision nodes — project knowledge *and* project experience persist across sessions |
| **Hooks** | Outcome auto-capture (on by default) + Claude Code `SessionEnd` / `Stop` hooks close the learning loop automatically — no manual outcome reporting required |
| **Skills** | A four-class flywheel (`proven` / `correctable` / `anti-pattern` / `noise`) with canary validation — skills are promoted by evidence, not by assertion |

Pure TypeScript/Node. CLI + MCP + VS Code extension. Fully offline, no API key required.

## Why a harness, not another RAG

Most "memory" products are either **static injection** (load `CLAUDE.md` / rules files in full on every session) or **plain RAG** (retrieve chunks, no learning). Both fail in long-lived projects:

- Static injection pays the same token cost every session regardless of the task, and grows until it is truncated or ignored.
- Plain RAG retrieves text but never accumulates *experience* — the thousandth task pays the same cost as the first.

GraphFlow is a harness: **memory is dynamic and typed**. Each request retrieves only what the current decision needs — graph anchors, compressed summaries, similar past episodes, applicable skills — under an explicit token budget (L0–L3 layered compression, ~98% savings measured). What the agent learns (outcomes, lessons, skills) is written back through hooks, so the harness gets better with use.

It is also **local-first and portable**: everything runs offline with no API key, and the whole surface is exposed over MCP, so the same memory travels across agents instead of being locked into one vendor's format.

## Proof, not promises

All headline numbers come from a **public, reproducible benchmark suite** ([benchmarks/README.md](benchmarks/README.md)) with published methodology ([docs/benchmark-standards.md](docs/benchmark-standards.md)) and machine-readable JSON dumps pinned to commits:

- **~98% token savings** (8-query suite, 262,926 → 2,843 tokens; independently re-counted with `gpt-tokenizer`)
- **132-query golden retrieval set** in CI (Hit@5 = 100%, MRR = 0.836, NDCG@5 = 0.601); downloadable open dataset: [`benchmarks/datasets/retrieval-golden-v1.json`](benchmarks/datasets/retrieval-golden-v1.json) — run `npm run bench:retrieval`
- **Skill A/B: 100% vs 61.5%** task success with the flywheel on vs off (26 tasks)
- **Memory ROI: 100% vs 56.5%** with episodic memory on vs off (62 tasks, with attribution chains)

Results are commit-anchored so any number above can be checked out and re-run. Third-party reproduction is actively welcomed — see [ROADMAP.md](ROADMAP.md) for the open invitation.

## Memory poisoning protection

Shared and synced memory is only useful if it cannot be silently corrupted. Skills merged from external sources (e.g. `skill sync` imports) are **treated as unproven until validated locally**: imported skills carry provenance markers, never enter the `proven` class directly, must pass canary validation on real tasks before promotion, and `anti-pattern` skills are isolated rather than deleted so they can be audited. Promotion is gated by the four-class lifecycle, not by trust in the source. See [docs/team-memory-security.md](docs/team-memory-security.md).

## Quick start

No API key needed (offline AST indexing + graph compression):

```bash
# 1. Build the graph offline (AST indexing, no LLM)
npx @roarpeng/graphflow graph index .

# 2. Preview compressed context (anchors + summaries, 90%+ token savings)
npx @roarpeng/graphflow context preview "orchestrator" --json
```

Connect via MCP (Cursor / Claude Code / …):

```json
{
  "mcpServers": {
    "graphflow": {
      "command": "npx",
      "args": ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"]
    }
  }
}
```

The agent calls `graphflow_context` for compressed context, then `graphflow_plan` to plan; without a provider API key GraphFlow automatically bridges the ATP thinking protocol to the host agent (agent-delegated mode).

## Why GraphFlow

Single-purpose tools each do one thing well; GraphFlow combines graph + compression + planning protocol + learning memory in one place:

| Capability | **GraphFlow** | CodeGraph | Serena | Repomix |
| --- | --- | --- | --- | --- |
| Code graph | 12-language AST index | more mature | LSP symbols | — |
| Context compression | layered + graph compression + vector recall | partial | partial | whole-repo dump |
| Planning protocol | ATP IR + DAG + agent bridge | — | — | — |
| **Learning memory** | Episodic / Skill / Decision flywheel | — | — | — |
| Local-first | ✅ | ✅ | ✅ | ✅ |
| Open protocol | [ATP/IR public spec](docs/atp-ir-spec-v1.md) | — | — | — |

> The differentiator is the **learning flywheel**: graph indexing and token compression are replicable; project-private experience (skills, lessons, decisions) accumulated across sessions is not — it compounds with use. Serena is a complement, not a competitor — see [GraphFlow + Serena: better together](docs/comparison.md#graphflow--serena-better-together联合方案).

## Core capabilities (v1.7.15+)

| Module | Capability |
| --- | --- |
| **Planning protocol** | ATP v1.1 (Intent / Requirement / Six Hats / 5-Why / First Principles / Decision Matrix / Planning / Reflection); simple / complex / insight modes; agent-delegated bridge without an LLM; **skill-conditioned DAG** (`skillRefs` / `avoidPatterns` on plan nodes); [ATP/IR public spec v1.1](docs/atp-ir-spec-v1.md) |
| **Goal alignment** | Goal anchor nodes (intent five-tuple as first-class citizen, original requirement auto-injected); low-confidence clarification gate (no plan below 0.6); runtime alignment-check; deviation classification (misread-requirement / scope-creep / tech-drift); goal version chain + diffs |
| **Knowledge graph** | 12-language AST indexing; File / Module / Symbol + **Concept / Requirement**; cross-layer edges `documents` / `implements` / `derived_from`; Office/PDF → Markdown via optional **`@firecrawl/anydoc`** (MIT). **CLI/npm**: optionalDependency. **VSIX**: not bundled; on activate the extension **auto-downloads the current-OS binary** into `~/.graphflow/optional-deps` when `graphflow.downloadAnydoc` is true (default). Disable the setting to skip network; source indexing still works. |
| **Context compression** | L1/L2/L3 layered anchors; graph compression (edge weights + PageRank, LRU cache); stem-matching recall (orchestrate ↔ orchestration); vector recall + RRF; RepoMap overview; adaptive budget |
| **Retrieval quality** | Golden-set regression gate (132 queries, Hit@5=100%, MRR=0.836, NDCG@5=0.601) |
| **Vector index** | In-process memoization + disk persistence (fingerprint-checked, seconds to restore after MCP restart) |
| **Storage backends** | `file` / `memory` / `sqlite` (FTS5, tokenizer-enhanced `searchtext`, camelCase searchable) / **`auto` (sqlite-first with fallback)** / `mcp-http` |
| **Learning flywheel** | Episodic memory, reflection, skill nodes (score ±1, bounded [-20,20]), nightly training, skill decay/pruning, **auto-capture + Claude Code hooks (on by default)**, **SkillOpt-lite** bounded guidance edits, four-class lifecycle + **canary gate for synced skills**, `npm run backfill:episodes`, contribution reports (`skill report` / `graphflow_diagnose` / `route diagnose`) |
| **Team sharing** | `skill sync`: export/import skill packs to a committable `.graphflow/skills/team-skills.json`; imports are a **bidirectional MERGE** (per-skill-id union, newer `updatedAt` wins, ties keep local, local-only skills preserved; `--force` to overwrite); golden retrieval queries round-trip via `.graphflow/team-golden.json`; [security model](docs/team-memory-security.md) |
| **Benchmarks** | [Comprehensive 92.9%](benchmarks/COMPREHENSIVE-RESULTS.md) · [Independent-style 96.2%](benchmarks/INDEPENDENT-RESULTS.md) · [context-readiness eval](benchmarks/SWE-BENCH-RESULTS.md) · [98.2% token savings](benchmarks/RESULTS.md) |
| **Model routing** | Smart / Economy tiers; multi-provider health probes and fallback (DeepSeek, OpenAI, Anthropic, Bailian, Doubao) |
| **Observability** | `graphflow_diagnose` / `route diagnose`: provider health + graph stats + token savings + **flywheel health** (auto-capture, episodes, skills by class, session journal) |
| **Agent surfaces** | CLI `--json`; MCP stdio (10 tools); auto-install into 15+ agents (incl. **Codex Windows NODE/NPX_CLI short-path MCP**) |
| **Engineering quality** | TypeScript strict; vitest suite; `npm run ci` includes extension packaging and smoke tests |

### Positioning

> GraphFlow is **not an orchestrating executor** — it is the **memory & context harness** for coding agents. Task execution is delegated to the host coding agent via bridge mode (honest semantics, no faked COMPLETED); GraphFlow's job is to make the agent see clearly and remember.

## MCP tools (10)

| Tool | Function |
| --- | --- |
| `graphflow_context` | Compressed context package (query → anchors + summaries; anchorId → expand) |
| `graphflow_plan` | Task planning (mode='simple' or 'insight'; agent-delegated without an LLM) |
| `graphflow_run` | Orchestration + bridge execution descriptor |
| `graphflow_report_outcome` | Outcome backfill (incl. deviation classification), closes the learning flywheel |
| `graphflow_insight` | ATP insight submit / merge (agent bridge protocol) |
| `graphflow_index` | Incremental / full indexing |
| `graphflow_skill_insights` | Skill insights |
| `graphflow_diagnose` | Diagnostics (provider + graph + token savings + flywheel) |
| `graphflow_artifact` | Graph artifact import / export |
| `graphflow_skill_guide` | GraphFlow skill usage guide |

**MCP workspace resolution**: the workspace is discovered automatically from the MCP client `cwd`; override with `GRAPHFLOW_WORKSPACE_ROOT`.

## CLI quick reference

```bash
graphflow graph index .                    # build the graph
graphflow context preview "orchestrator"   # preview compressed context
graphflow plan "refactor planner" --json   # plan
graphflow run "update readme"              # orchestrate (bridge)
graphflow skill insights                   # skill insights
graphflow skill report                     # flywheel contribution report
graphflow skill sync export                # export team skill pack + golden queries (share via git)
graphflow skill sync import                # import team skill pack (MERGE; --force to overwrite) + golden merge into .graphflow/team-golden.json
graphflow route diagnose                   # routing diagnostics
graphflow learn nightly                    # nightly learning
graphflow doctor                           # install self-check
```

## Configuration

Three-layer merge: global `~/.graphflow.config.json` → project `graphflow.config.json` → project `.graphflow/config.json`. Copy [graphflow.config.example.json](graphflow.config.example.json) to get started.

Key options:

| Option | Description |
| --- | --- |
| `graphPolicy.transport` | `file` / `memory` / `sqlite` / **`auto` (recommended: sqlite-first, falls back to file)** / `mcp-http` |
| `graphPolicy.maxContextTokens` | Context budget (default 1500) |
| `graphPolicy.autoIndexOnSave` | Auto incremental index on save (default true) |
| `embeddingPolicy.provider` | `transformers` (local default) / `openai` / `hash` |
| `embeddingPolicy.vectorStorePath` | Vector index persistence path (`.hnsw` derived automatically) |
| `skillPolicy.enableSkillFlywheel` | Learning flywheel switch |

## Team backend pilot

Set `graphPolicy.transport` to `mcp-http` to host the graph on a remote Graphify service (shared by the team); requires `graphPolicy.mcpEndpoint` (http(s) URL, optional `mcpApiKey` bearer token):

```json
{ "graphPolicy": { "transport": "mcp-http", "mcpEndpoint": "http://graphify.team.internal:8080" } }
```

A missing/malformed endpoint fails at config validation; connection or runtime request failures degrade transparently to local JSON storage (`graphPolicy.graphStorePath`, default `graphflow-out/graphflow-graph.json`) with a `logger.warn`, consistent with the sqlite→file fallback, never interrupting the agent. The pilot protocol does not yet support full snapshots: `readSnapshot` returns the local mirror file (possibly stale). For the team-sharing security model, see [docs/team-memory-security.md](docs/team-memory-security.md).

## Benchmarks

- **Comprehensive**: [COMPREHENSIVE-RESULTS.md](benchmarks/COMPREHENSIVE-RESULTS.md) — P1–P6 six-dimension evaluation, overall **92.9%** (indexing 100% / compression 64.9% / planning 100% / learning 100% / bridge 100% / performance 99.7%)
- **Independent-style**: [INDEPENDENT-RESULTS.md](benchmarks/INDEPENDENT-RESULTS.md) — CodeGraph-style 5-domain evaluation, Hit@5 **96%**, token savings **96.6%**, overall **96.2%**
- **SWE-bench-style**: [SWE-BENCH-RESULTS.md](benchmarks/SWE-BENCH-RESULTS.md) — self-built 12-instance context-readiness eval; [SWE-BENCH-REAL-RESULTS.md](benchmarks/SWE-BENCH-REAL-RESULTS.md) — Flask real-project 10-instance file-recall eval (48.3%)
- **Token savings**: [RESULTS.md](benchmarks/RESULTS.md) — 8 representative queries, **98.2%** savings, re-counted with independent gpt-tokenizer
- **Retrieval quality**: [RETRIEVAL-EVAL-RESULTS.md](benchmarks/RETRIEVAL-EVAL-RESULTS.md) — 132 queries, Hit@5=100%, MRR=0.836, NDCG@5=0.601
- **Skill flywheel A/B**: [SKILL-AB-RESULTS.md](benchmarks/SKILL-AB-RESULTS.md) — injection rate 100%, recall 100%, overhead 25.6 tok/task

## VS Code / Cursor extension

Download `graphflow-<version>.vsix` from [GitHub Releases](https://github.com/Roarpeng/GraphFlow/releases) (or Open VSX: `roarpeng.graphflow`).

Commands: Settings / Show Graph (graph visualization) / Preview Context / Plan & Brainstorm / Run Task / Skill Insights / Install MCP; chat agent `@graphflow` (`/run` `/plan` `/graph` `/skills` `/diagnose` `/learn` `/history`).

## Agent Plugins 1.0

**Primary install path** for hosts that support [Agent Plugins](https://agent-plugins.org). GraphFlow ships as a portable package at the repository root:

```text
plugin.json              # Agent Plugins 1.0 manifest
mcp.json                 # stdio MCP (type required by the spec)
skills/graphflow/SKILL.md
```

**Install in Cursor (local):**

```bash
mkdir -p ~/.cursor/plugins/local
ln -s /absolute/path/to/GraphFlow ~/.cursor/plugins/local/graphflow
# then Restart Cursor / Developer: Reload Window
```

**Install via Team Marketplace / Git:** import this repository; clients discover `plugin.json`, then load `skills/` and `mcp.json`.

Docs: [Context Engineering contract](docs/context-contract.md) · [Experience memory](docs/experience-memory.md)

**Uninstall:** Removing the Agent Plugin in Cursor only drops the plugin package. Skills/Rules/MCP written by `graphflow install` remain and will keep steering the agent — run:

```bash
npx @roarpeng/graphflow uninstall
```

That removes user + workspace MCP entries, `skills/graphflow` folders, GraphFlow rules/instruction blocks, and Claude Code hooks. Also delete any local symlink under `~/.cursor/plugins/local/graphflow` if you used one.

## Agent integrations

Use **`npx @roarpeng/graphflow install` as the fallback** when you need Rules, multi-agent wiring, or a host that does not load Agent Plugins:

```bash
npx @roarpeng/graphflow doctor     # detect installed agents
npx @roarpeng/graphflow install    # auto-install MCP + Skill + Rules
npx @roarpeng/graphflow uninstall  # remove MCP + Skill + Rules + hooks
npx @roarpeng/graphflow init       # write a minimal project config
```

Supported: Cursor, VS Code, Trae (incl. CN), Claude Code, Windsurf, Cline, Roo Code, Kilo Code, Gemini CLI, Codex, Antigravity, Opencode, Qoder, Amazon Q, Zed, Continue, and more (15+).

| Path | When to use |
| --- | --- |
| **Agent Plugins** | Preferred single-host Skill + MCP discovery |
| **`graphflow install`** | Rules / multi-agent / non-plugin hosts |
| **`graphflow uninstall`** | After removing a plugin (or anytime) — clears leftover Skill/MCP/Rules |

## Protocol

[ATP/IR — Agent Thinking Protocol public specification v1.0](docs/atp-ir-spec-v1.md): work-item registry, submit/merge contract, compatibility rules. Third-party tools can implement compatible producers / consumers. Minimal Producer example: [`examples/atp-minimal-producer/`](examples/atp-minimal-producer/).

## Community

GraphFlow is a single-maintainer project (bus factor = 1); community collaboration is the key to reducing single-point risk. Contributions welcome:

- [Contributing guide](CONTRIBUTING.md): dev environment, code style, test requirements and PR checklist
- [Roadmap](ROADMAP.md): completed milestones and next steps (P0–P2)
- [Issues](https://github.com/Roarpeng/GraphFlow/issues): bug reports and feature requests (please use the built-in templates)
- [Discussions](https://github.com/Roarpeng/GraphFlow/discussions): questions and ideas

## Development

```bash
npm install
npm run ci        # lint + build + tests + extension packaging + smoke
```

Requires Node.js ≥ 20, npm ≥ 10. Expected: lint clean, build succeeds, 692 tests pass.

## Project structure

```text
GraphFlow/
├── plugin.json         # Agent Plugins 1.0 manifest
├── mcp.json            # Agent Plugins MCP (stdio)
├── skills/graphflow/   # portable Agent Skill (canonical SKILL.md)
├── src/
│   ├── core/           # orchestration core: orchestrator, triage, dag-engine, agent-delegation
│   ├── graph/          # indexing, context slicing, graph compression, sqlite/auto storage, snapshot
│   ├── routing/        # model routing and health probes (5 providers)
│   ├── learning/       # embeddings, episodic, skill-flywheel, hnsw, nightly
│   ├── agents/         # ATP schema, planner, insight, brainstormer
│   └── surfaces/
│       ├── cli/        # CLI + runtime
│       └── mcp/        # MCP server (10 tools)
├── tests/              # 99 files / 692 tests (incl. retrieval golden set, bridge+DAG)
├── benchmarks/         # comprehensive + independent + SWE-bench + token savings + skill A/B (reproducible)
├── docs/               # ATP spec + context contract + experience memory + comparisons
├── vscode-extension/   # VS Code panel and commands
└── CHANGELOG.md
```

## Changelog

Full history in [CHANGELOG.md](CHANGELOG.md). License: Apache-2.0.
