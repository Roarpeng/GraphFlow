# Experience Memory

> GraphFlow’s Experience layer turns **storage → reflection → experience**:
> raw episodes and graph facts are reflected into scored skills and lessons,
> then retrieved as organizational memory under the same context budget as code.

Related: [Context contract](context-contract.md) · [Team memory security](team-memory-security.md) · [Flywheel auto-capture](flywheel-autocapture.md)

## Framing: Storage → Reflection → Experience

| Stage | What lives here | How it advances |
| --- | --- | --- |
| **Storage** | Graph nodes (File/Symbol/Module), Decision episodes, Skill payloads, optional artifacts | Index, `report_outcome`, auto-capture hooks |
| **Reflection** | Score updates, outcome taxonomy (`proven` / `correctable` / `anti-pattern` / `noise`), SkillOpt-lite guidance edits, consolidation proposals | Flywheel after pass/fail; diagnose / skill report |
| **Experience** | What agents actually reuse: skill hints on plans, episode recall, L3 anchors in context packages | `graphflow_context` / `plan` / `skill_insights` under token budget |

Without reflection, storage is only a log. Without retrieval under a budget, reflection never becomes **experience**.

## Organizational memory building blocks

| Artifact | Role |
| --- | --- |
| **Episodes** | Task → outcome → lessons (and optional deviation). Feed recall and skill learning. |
| **Skills** | Distilled, scored patterns with optional guidance and provenance / canary gates. |
| **Graph artifacts** | Portable gzip/JSON snapshot of the knowledge graph (`graphflow artifact export/import`). |
| **Memory pack (Markdown)** | Human-readable skills + recent episodes for review and onboarding (`artifact export-memory`). |
| **Skill sync package** | Machine mergeable team skills (`.graphflow/skills/…`) with security gates. |

Together they form **engineering memory** that can move with the repo — reviewable like code, gated against poisoning (see [team-memory-security.md](team-memory-security.md)).

## Export / import

### Binary / JSON graph artifact

```bash
graphflow artifact export                      # → graphflow-out/graphflow-graph.artifact.gz
graphflow artifact export --include-episodes   # keep episode Decision nodes
graphflow artifact import [path]
```

MCP: `graphflow_artifact` with `mode: "export" | "import"`.

### Markdown experience memory pack

Human-readable companion (not a full graph restore):

```bash
graphflow artifact export-memory
# → graphflow-out/memory-pack/README.md
# → graphflow-out/memory-pack/skills.md
# → graphflow-out/memory-pack/episodes.md

graphflow artifact export-memory path/to/dir
graphflow --json artifact export-memory
```

Programmatic: `exportExperienceMemoryPack(config, outputDir?)` in `src/graph/memory-pack.ts`.

### Skill package (team MERGE)

```bash
graphflow skill sync export
graphflow skill sync import   # newer updatedAt wins; --force overwrites
```

## Agent Plugin vs `graphflow install`

| Path | Primary use | What you get |
| --- | --- | --- |
| **Agent Plugins 1.0** (`plugin.json` / `mcp.json` / `skills/`) | **Preferred** single-host install (e.g. Cursor local plugins / marketplace) | MCP + canonical Skill discovered together |
| **DeepSeek Harness bundle** (`dsh.bundle` + `cordis.patch.yml`) | `dsh plugin add @roarpeng/graphflow` | MCP via `@deepseek-ai/dsh-mcp-client` (`mcp__graphflow__*`) |
| **`npx @roarpeng/graphflow install`** | Fallback / multi-agent / Rules | MCP + Skill + Rules across 15+ detected agents (incl. `~/.dsh`) |
| **`graphflow doctor`** | Diagnostics | Which agents are installed / wired |

Rules and multi-agent wiring still use `install` when the host does not consume Agent Plugins. Context packaging itself is unchanged — always start with `graphflow_context` ([context-contract.md](context-contract.md)).
