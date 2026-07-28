---
name: "graphflow"
description: "Graph-based code context compression, task planning, and knowledge graph orchestration (10 MCP tools). Invoke before ANY code question, bug fix, debugging, file reading, Chinese/CJK query, refactor, or multi-step edit — ALWAYS call graphflow_context MCP first when GraphFlow is connected."
---

# GraphFlow Skill

GraphFlow is a graph-based context and planning service backed by a persistent MCP server. It turns codebases into queryable knowledge graphs, delivering token-efficient compressed context, task planning, and orchestration.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  GraphFlow Skill (this file)                     │
│  - Quick entry points & workflows                │
│  - Tool selection logic                          │
│  - Output interpretation guides                  │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  GraphFlow MCP Server (persistent backend)      │
│  10 tools: context, plan, index, insight, run,  │
│  report_outcome, skill_insights, diagnose,      │
│  artifact, skill_guide                          │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  GraphFlow Core Engine                          │
│  - Graph index & context compression            │
│  - Task planning & DAG                          │
│  - Skill learning flywheel                      │
│  - Artifact import/export                       │
└─────────────────────────────────────────────────┘
```

## When to Use

**ALWAYS invoke this skill BEFORE:**
- Multi-step edits, refactors, or architecture changes
- Large codebase-wide questions or exploration
- Debugging across multiple files
- Any task where you would otherwise read many files
- Token budget is a concern
- You need structured task planning

**DO NOT:**
- Scan the whole repository recursively before trying GraphFlow
- Read large files before checking GraphFlow anchors
- Skip GraphFlow for complex tasks
- Use grep for codebase exploration before `graphflow_context`

### Trae / Trae CN setup (Rules + Skill + MCP)

Trae loads **Rules every turn** and **Skills on demand**. GraphFlow `install` writes:

| Path | Role |
|------|------|
| `.trae/rules/graphflow.md` | `alwaysApply: true` — **must** call `graphflow_context` first |
| `.trae/skills/graphflow/SKILL.md` | Full workflows; trigger with `#graphflow` |
| `User/mcp.json` | GraphFlow MCP server |

If Rules are missing, type `#graphflow` at the start of a chat. Pass `rootDir` = current project absolute path on every context call.

### Antigravity IDE setup (Rules + Skill + MCP)

| Path | Role |
|------|------|
| `~/.gemini/antigravity/mcp_config.json` | Global MCP (`mcpServers.graphflow`) |
| `~/.gemini/antigravity/skills/graphflow/SKILL.md` | Global Skill |
| `.agent/rules/graphflow.md` | Project rules (always loaded in workspace) |
| `.agent/skills/graphflow/SKILL.md` | Project Skill |
| `GEMINI.md` (project root) | Managed token-first block |

Run `npx @roarpeng/graphflow install` from the project root. Do **not** hardcode `GRAPHFLOW_WORKSPACE_ROOT` in MCP env.

### Gemini CLI setup

| Path | Role |
|------|------|
| `~/.gemini/settings.json` | MCP (`mcpServers.graphflow`) |
| `~/.gemini/GEMINI.md` | Global managed instruction block |
| `GEMINI.md` (project root) | Project managed block (with `install --scope all`) |

### GitHub Copilot (VS Code) setup

| Path | Role |
|------|------|
| `~/.config/Code/User/mcp.json` | User MCP (`servers.graphflow`) |
| `.vscode/mcp.json` | Project MCP (optional, team-shared) |
| `.github/copilot-instructions.md` | Repo-level Copilot instructions |

---

## Tool Inventory (10 MCP Tools)

### Core Context Tools (Highest Frequency)

| Tool | Purpose | Call Frequency |
|------|---------|---------------|
| `graphflow_context` | Preview compressed context (query) or expand anchor (anchorId) | **Highest** - default first step |

### Planning Tools (High Frequency)

| Tool | Purpose | Call Frequency |
|------|---------|---------------|
| `graphflow_plan` | Multi-step task decomposition & DAG (mode='simple' or 'insight') | High - before complex work |
| `graphflow_run` | Plan + context package (bridge mode) | Medium - full task packaging |
| `graphflow_report_outcome` | Report bridge-mode execution outcome back | Medium - close the learning loop |
| `graphflow_insight` | Submit or merge agent insights | Medium - no external LLM API |

### Graph Management Tools (Medium Frequency)

| Tool | Purpose | Call Frequency |
|------|---------|---------------|
| `graphflow_index` | Incremental workspace re-index, single-file, or full rebuild | Medium - after file changes |

### Collaboration & Insights Tools (Low Frequency)

| Tool | Purpose | Call Frequency |
|------|---------|---------------|
| `graphflow_artifact` | Export or import graph artifact | Low - team sharing |
| `graphflow_skill_insights` | Learned skill patterns | Low - leverage prior learning |
| `graphflow_skill_guide` | Skill usage guide for connected agents | Low - onboarding |
| `graphflow_diagnose` | Provider health, graph stats, and token savings | Low - ROI tracking / config issues |

---

## Standard Workflows

### Workflow 1: Context First (90% of tasks)

**Use when:** Answering code questions, exploring codebase, understanding modules

```
Step 1: graphflow_context(query: "<your question>")
Step 2: Read summary + anchors as primary context
Step 3: Expand specific anchors with graphflow_context(anchorId: "...") when needed
Step 4: Read full files only when exact edits required
```

**Input - context (preview):**
```typescript
{
  query: string;           // Required for preview - user question (Chinese OK)
  englishQuery?: string;   // Agent-translated English code search terms (recommended for CJK)
  configPath?: string;
  rootDir?: string;
}
```

**Input - context (expand):**
```typescript
{
  anchorId: string;        // Required for expand - anchor id from preview
  configPath?: string;
  rootDir?: string;
}
```

**Output structure (preview):**
```typescript
{
  summary: string[];
  anchors: Array<{ id: string; type: string; layer: "L1" | "L2" | "L3" }>;
  tokenBudget: {
    maxContextTokens: number;
    estimatedRawTokens: number;
    compressedTokens: number;
    estimatedSavingsPercent: number;
    budgetUsedPercent: number;
  };
  agentWorkItems?: Array<{ id: string; kind: string; prompt: string }>; // CJK low-match delegation
  englishQuery?: string;
}
```

**Always report to user:** token savings %, anchor count, key summary findings

### Workflow 1b: Chinese / CJK queries (agent translates → English search)

**Use when:** User asks in Chinese but the codebase uses English symbols

GraphFlow tokenizes CJK and expands workspace path hints. When that is not enough, **YOU must translate** to English code keywords.

**Preferred (proactive):**
```
Step 1: Translate user intent to English file/symbol terms with YOUR model
Step 2: graphflow_context({ query: "<Chinese>", englishQuery: "PoseDetectionPage avatarMode BattlePage shieldEffect", rootDir })
Step 3: Use summary + anchors
```

Use **exact file/class/component names** (PascalCase stems). Avoid generic words like `exercise` when the user means camera/pose UI — that word often hits data/types layers instead of pages.

For **module families** (Zustand store + `slices/`): put file stems in `englishQuery` (`useGameStore companionSlice dailySlice inventorySlice`), not bare domain words like `monster` (often ranks `data/monsters` over `monsterSlice`).

**Fallback:** If `anchorCount < 3` and `agentWorkItems` includes `query-translate-en`, answer JSON prompt and retry with `englishQuery`.

---

### Workflow 2: Plan Before Coding (complex tasks)

**Use when:** Multi-step changes, refactors, features with unclear scope

```
Step 1: graphflow_context(query: "<task>")
Step 2: graphflow_plan(task: "<task description>")
  - Without GraphFlow LLM: returns mode=agent-delegated + agentWorkItems
    (simple-plan-intent, simple-plan-decomposition) and optional suggestedNodes.
    MUST submit/merge via graphflow_insight before treating the DAG as final.
  - Local suggestedNodes are heuristic hints only.
Step 3: Review plan steps and dependencies
Step 4: Execute step by step, using GraphFlow context for each step
Step 5: graphflow_index() after major changes
```

**Input:**
```typescript
{
  task: string;   // Required - task description to plan
  mode?: "simple" | "insight"; // 'simple' (default) for quick planning, 'insight' for Six Hats + 5-Why
  configPath?: string;
}
```

**Output structure:**
```typescript
{
  ideas: string[];          // Brainstorming ideas
  plan: {
    steps: Array<{
      id: string;
      title: string;
      description: string;
      dependsOn: string[];
      estimate: string;
    }>;
    dag: object;            // Task dependency graph
  };
}
```

---

### Workflow 3: Deep Analysis (complex/ambiguous tasks)

**Use when:** High-stakes changes, root-cause analysis, ambiguous requirements

```
Step 1: graphflow_context(query: "<task>")
Step 2: graphflow_plan(task: "<task description>", mode: "insight")
Step 3: Review Six Hats analysis and 5-Why chains
Step 4: Use insights to inform implementation plan
Step 5: Execute with regular context previews
```

---

### Workflow 4: Full Task Packaging (bridge mode)

**Use when:** You want a complete execution descriptor with context packaged

```
Step 1: graphflow_run(task: "<full task description>")
Step 2: Receive executionDescriptor with phases + compressed context
Step 3: Execute the plan (GraphFlow does NOT execute code)
Step 4: graphflow_report_outcome(episodeId, success, lessons)
```

**Input:**
```typescript
{
  task: string;             // Required - full task description
  configPath?: string;      // Optional - config path
}
```

**Input - report_outcome:**
```typescript
{
  episodeId: string;        // Required - from graphflow_run
  success: boolean;         // Required - whether task completed
  lessons?: string[];       // Optional - up to 4 lessons learned
  configPath?: string;      // Optional - config path
}
```

---

### Workflow 5: Graph Maintenance

**Use when:** Graph is stale, or after significant project changes

#### Incremental Index (fast)
```
graphflow_index(rootDir?: string, configPath?: string)
```
- Only indexes new/changed files
- Safe to call frequently
- Use after saving multiple files

#### Single File Index (fastest)
```
graphflow_index(filePath: string, configPath?: string)
```
- Index just one file
- Perfect for onSave hooks
- Skips unchanged files automatically

#### Full Rebuild (slow but clean)
```
graphflow_index(mode: "full", rootDir?: string, configPath?: string)
```
- Clears ALL cached data
- Full re-index from scratch
- Use only when graph is corrupted or very stale

#### Inspect Graph State
```
graphflow_diagnose(nodeLimit?, edgeLimit?, rootDir?)
```
- Check graph size, file count, symbol count
- Verify indexing worked correctly
- Sample nodes to verify quality
- Also shows provider health and token savings

---

### Workflow 6: Team Collaboration

**Use when:** Sharing graph state with teammates

#### Export Artifact
```
graphflow_artifact(mode: "export", outputPath?, compression?)
```
- Export graph to portable gzip artifact
- Share with team to skip full indexing
- Can be committed to git

#### Import Artifact
```
graphflow_artifact(mode: "import", inputPath?)
```
- Import teammate's graph artifact
- Skip initial full workspace index
- Great for onboarding new team members

---

### Workflow 7: Advanced Capabilities

#### Skill Insights (learning flywheel)
```
graphflow_skill_insights(limit?, rootDir?)
```
- Returns learned skill patterns from prior runs
- Can accelerate similar tasks
- Part of the skill evolution flywheel

#### Token Savings Stats
```
graphflow_diagnose(configPath?, rootDir?)
```
- Check the `stats` field for cumulative token savings across all runs
- ROI tracking
- See how much GraphFlow has saved

#### Diagnostics
```
graphflow_diagnose(configPath?)
```
- Check provider health
- Verify model routing
- Debug configuration issues
- Also returns graph stats and token savings

---

## Tool Selection Decision Tree

```
Start
  │
  ├─ Is this a codebase question/exploration?
  │   └─ YES → graphflow_context ← START HERE
  │        │
  │        └─ Need more detail on specific item?
  │             └─ YES → graphflow_context(anchorId)
  │
  ├─ Is this a multi-step coding task?
  │   ├─ Simple (2-3 files) → context + implement
  │   ├─ Complex → context → graphflow_plan → implement
  │   └─ Ambiguous/high-stakes → context → graphflow_plan(mode="insight") → implement
  │
  ├─ Do you need a complete packaged task?
  │   └─ YES → graphflow_run (bridge mode) → execute → report_outcome
  │
  ├─ Did you just make file changes?
  │   ├─ Single file → graphflow_index(filePath)
  │   └─ Multiple files → graphflow_index (incremental)
  │
  ├─ Is the graph giving bad results?
  │   ├─ First → graphflow_diagnose (check state)
  │   ├─ Then → graphflow_index (try incremental)
  │   └─ Last resort → graphflow_index(mode="full") (full rebuild)
  │
  ├─ Sharing with teammates?
  │   ├─ Export → graphflow_artifact(mode="export")
  │   └─ Import → graphflow_artifact(mode="import")
  │
  ├─ Do you want to leverage prior learning?
  │   └─ YES → graphflow_skill_insights
  │
  ├─ Tracking ROI?
  │   └─ graphflow_diagnose (check stats field)
  │
  └─ Is routing/models misbehaving?
      └─ YES → graphflow_diagnose
```

---

## Output Interpretation Guide

### Reading Compressed Context

The `summary` array contains compressed context lines. Each line is one of:

| Prefix | Meaning | Example |
|--------|---------|---------|
| `Module:` | Module-level summary | `Module: src/graph/context-slicer` |
| `File:` | File-level summary | `File: src/graph/context-slicer.ts # exports: buildLayeredContextPackage` |
| `Symbol:` | Function/class symbol | `Symbol: function buildLayeredContextPackage (exported) @src/graph/context-slicer.ts:42` |

**Priority order:** Symbols (L1) > Files (L1) > Modules (L2) > Overview (L3)

### Token Budget

Always pay attention to `tokenBudget`:

| Field | Meaning |
|-------|---------|
| `maxContextTokens` | The configured budget (default 1500) |
| `estimatedRawTokens` | What reading all relevant files raw would cost |
| `compressedTokens` | What GraphFlow's compressed output uses |
| `estimatedSavingsPercent` | Percentage saved (typically 70-95%) |
| `budgetUsedPercent` | How much of the budget is used |

**Rule of thumb:** If `budgetUsedPercent < 50%`, you can safely expand more anchors.

---

## Best Practices

### 1. Context First, Always
- Start EVERY coding task with `graphflow_context`
- Only read full files when compressed context is insufficient
- Never grep the whole repo before trying GraphFlow

### 2. Plan Before Complex Work
- Use `graphflow_plan` for anything beyond 2-3 files
- Use `graphflow_plan(mode="insight")` for ambiguous tasks
- Follow the DAG order (respect dependencies)
- Use context from GraphFlow at each step

### 3. Keep Graph Fresh
- Call `graphflow_index(filePath)` after saving individual files
- Call `graphflow_index` after significant changes
- Prefer incremental index over full rebuild
- Check `graphflow_diagnose` if results seem off

### 4. Close the Learning Loop
- After bridge-mode runs, call `graphflow_report_outcome`
- Include lessons learned to improve future planning
- This feeds the skill evolution flywheel

### 5. Report Token Savings
- Always mention `estimatedSavingsPercent` to the user
- This demonstrates the value of GraphFlow
- Include raw vs compressed token counts

### 6. Bridge Mode Mindset
- `graphflow_run` returns plans, it doesn't execute them
- YOU are the execution agent (bridge mode)
- Use the packaged context to accelerate your work

---

## Troubleshooting

### "0 anchors found" or empty results
1. **Chinese/CJK:** translate to English keywords; pass `englishQuery` or answer `agentWorkItems` id `query-translate-en`
2. Check if graph exists: `graphflow_diagnose`
3. If empty: run `graphflow_index`
4. If still empty: verify `rootDir` points to correct project

### Results seem stale
1. Run `graphflow_index` (incremental, fast)
2. If still stale: `graphflow_index(mode="full")` (full, slow)

### Context quality is poor
1. Try more specific query terms
2. Check if symbols are indexed (diagnose)
3. Run `graphflow_index(mode="full")` if the graph may be stale

### Tool errors / configuration issues
1. Run `graphflow_diagnose` to check provider health
2. Verify config file exists at specified path
3. Check workspace root is correct

### Want to share graph with teammates
1. Export: `graphflow_artifact(mode="export")`
2. Send the artifact file
3. Teammate imports: `graphflow_artifact(mode="import")`

---

## Quick Reference Cheat Sheet

```typescript
// 90% of the time - start here
await graphflow_context({ query: "what you're looking for" });

// Need more detail on a specific anchor?
await graphflow_context({ anchorId: "symbol:src/foo.ts:abc123" });

// Before complex tasks
await graphflow_plan({ task: "describe the task" });

// Deep analysis with Six Thinking Hats + 5-Why
await graphflow_plan({ task: "complex ambiguous task", mode: "insight" });

// Full packaged task (bridge mode)
const result = await graphflow_run({ task: "full task description" });
// ... execute the task ...
await graphflow_report_outcome({
  episodeId: result.episodeId,
  success: true,
  lessons: ["lesson 1", "lesson 2"]
});

// After making changes - single file
await graphflow_index({ filePath: "src/foo.ts" });

// After making changes - workspace
await graphflow_index({ rootDir: "/path/to/project" });

// Check graph health + stats + savings
await graphflow_diagnose({ nodeLimit: 20 });

// When graph is broken
await graphflow_index({ mode: "full", rootDir: "/path/to/project" });

// Team collaboration
await graphflow_artifact({ mode: "export", outputPath: "graph-artifact.gz" });
await graphflow_artifact({ mode: "import", inputPath: "graph-artifact.gz" });

// Leverage prior learning
await graphflow_skill_insights({ limit: 5 });

// Diagnose issues
await graphflow_diagnose();
```
