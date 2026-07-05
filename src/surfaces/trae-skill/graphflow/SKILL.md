---
name: "graphflow"
description: "Graph-based code context compression, task planning, and knowledge graph orchestration. Backed by GraphFlow MCP server with 18 tools. Invoke before multi-step edits, large refactors, codebase-wide questions, or when you need to understand project structure efficiently to save tokens."
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
│  18 tools: preview, expand, plan, plan_insight,  │
│  run, report_outcome, submit_insight, merge_insight,│
│  index, index_file, rebuild, inspect, skill_insights,│
│  skill_guide, diagnose, export_artifact, import_artifact,│
│  stats                                              │
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
- Use grep for codebase exploration before `graphflow_preview_context`

---

## Tool Inventory (18 MCP Tools)

### Core Context Tools (Highest Frequency)

| Tool | Purpose | Call Frequency |
|------|---------|---------------|
| `graphflow_preview_context` | Compress task context with token budget | **Highest** - default first step |
| `graphflow_expand_anchor` | Expand a single anchor to full content | **High** - dive deeper into specific items |

### Planning Tools (High Frequency)

| Tool | Purpose | Call Frequency |
|------|---------|---------------|
| `graphflow_plan` | Multi-step task decomposition & DAG | High - before complex work |
| `graphflow_plan_insight` | Six Thinking Hats + 5-Why deep analysis | Medium - ambiguous/high-stakes tasks |
| `graphflow_run` | Plan + context package (bridge mode) | Medium - full task packaging |
| `graphflow_report_outcome` | Report bridge-mode execution outcome back | Medium - close the learning loop |
| `graphflow_submit_insight` | Submit agent answers to Six Hats / plan prompts | Medium - no external LLM API |
| `graphflow_merge_insight` | Merge submitted insights into unified plan | Medium - after submit_insight |

### Graph Management Tools (Medium Frequency)

| Tool | Purpose | Call Frequency |
|------|---------|---------------|
| `graphflow_index` | Incremental workspace re-index | Medium - after file changes |
| `graphflow_index_file` | Single file incremental index | Medium-High - after saving a file |
| `graphflow_rebuild` | Clear cache + full re-index | Low - when graph is stale/corrupted |
| `graphflow_inspect_graph` | Graph stats & sample nodes/edges | Low - check graph health |

### Collaboration & Insights Tools (Low Frequency)

| Tool | Purpose | Call Frequency |
|------|---------|---------------|
| `graphflow_export_artifact` | Export graph to portable artifact | Low - team sharing |
| `graphflow_import_artifact` | Import graph artifact | Low - skip full index on new machine |
| `graphflow_skill_insights` | Learned skill patterns | Low - leverage prior learning |
| `graphflow_skill_guide` | Skill usage guide for connected agents | Low - onboarding |
| `graphflow_stats` | Cumulative token savings stats | Low - ROI tracking |
| `graphflow_diagnose` | Provider health & model routing | Rare - config issues |

---

## Standard Workflows

### Workflow 1: Context First (90% of tasks)

**Use when:** Answering code questions, exploring codebase, understanding modules

```
Step 1: graphflow_preview_context(query: "<your question>")
Step 2: Read summary + anchors as primary context
Step 3: Expand specific anchors with graphflow_expand_anchor when needed
Step 4: Read full files only when exact edits required
```

**Input - preview_context:**
```typescript
{
  query: string;           // Required - your search/understanding query
  configPath?: string;     // Optional - path to graphflow.config.json
  rootDir?: string;        // Optional - workspace root override
}
```

**Input - expand_anchor:**
```typescript
{
  anchorId: string;        // Required - anchor id from preview_context
  configPath?: string;     // Optional - path to graphflow.config.json
  rootDir?: string;        // Optional - workspace root override
}
```

**Output structure (preview_context):**
```typescript
{
  summary: string[];           // Compressed context lines
  anchors: Array<{             // File/symbol anchors you can expand
    id: string;
    type: "Module" | "File" | "Symbol";
    layer: "L1" | "L2" | "L3";
  }>;
  tokenBudget: {
    maxContextTokens: number;     // Configured budget
    estimatedRawTokens: number;   // What full files would cost
    compressedTokens: number;     // What this returns
    estimatedSavingsPercent: number; // 0-100
    budgetUsedPercent: number;    // 0-100
  };
  refillPreview: string[];     // Hints for getting more context
}
```

**Always report to user:**
- Token savings percentage
- Number of anchors found
- Key findings from summary

---

### Workflow 2: Plan Before Coding (complex tasks)

**Use when:** Multi-step changes, refactors, features with unclear scope

```
Step 1: graphflow_preview_context(query: "<task>")
Step 2: graphflow_plan(task: "<task description>")
Step 3: Review plan steps and dependencies
Step 4: Execute step by step, using GraphFlow context for each step
Step 5: graphflow_index() after major changes
```

**Input:**
```typescript
{
  task: string;   // Required - task description to plan
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
Step 1: graphflow_preview_context(query: "<task>")
Step 2: graphflow_plan_insight(task: "<task description>")
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
graphflow_index_file(filePath: string, configPath?: string)
```
- Index just one file
- Perfect for onSave hooks
- Skips unchanged files automatically

#### Full Rebuild (slow but clean)
```
graphflow_rebuild(rootDir?: string, configPath?: string)
```
- Clears ALL cached data
- Full re-index from scratch
- Use only when graph is corrupted or very stale

#### Inspect Graph State
```
graphflow_inspect_graph(nodeLimit?, edgeLimit?, rootDir?)
```
- Check graph size, file count, symbol count
- Verify indexing worked correctly
- Sample nodes to verify quality

---

### Workflow 6: Team Collaboration

**Use when:** Sharing graph state with teammates

#### Export Artifact
```
graphflow_export_artifact(outputPath?, compression?)
```
- Export graph to portable gzip artifact
- Share with team to skip full indexing
- Can be committed to git

#### Import Artifact
```
graphflow_import_artifact(inputPath?)
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
graphflow_stats(configPath?, rootDir?)
```
- Cumulative token savings across all runs
- ROI tracking
- See how much GraphFlow has saved

#### Diagnostics
```
graphflow_diagnose(configPath?)
```
- Check provider health
- Verify model routing
- Debug configuration issues

---

## Tool Selection Decision Tree

```
Start
  │
  ├─ Is this a codebase question/exploration?
  │   └─ YES → graphflow_preview_context ← START HERE
  │        │
  │        └─ Need more detail on specific item?
  │             └─ YES → graphflow_expand_anchor
  │
  ├─ Is this a multi-step coding task?
  │   ├─ Simple (2-3 files) → preview_context + implement
  │   ├─ Complex → preview_context → graphflow_plan → implement
  │   └─ Ambiguous/high-stakes → preview_context → graphflow_plan_insight → implement
  │
  ├─ Do you need a complete packaged task?
  │   └─ YES → graphflow_run (bridge mode) → execute → report_outcome
  │
  ├─ Did you just make file changes?
  │   ├─ Single file → graphflow_index_file
  │   └─ Multiple files → graphflow_index (incremental)
  │
  ├─ Is the graph giving bad results?
  │   ├─ First → graphflow_inspect_graph (check state)
  │   ├─ Then → graphflow_index (try incremental)
  │   └─ Last resort → graphflow_rebuild (full rebuild)
  │
  ├─ Sharing with teammates?
  │   ├─ Export → graphflow_export_artifact
  │   └─ Import → graphflow_import_artifact
  │
  ├─ Do you want to leverage prior learning?
  │   └─ YES → graphflow_skill_insights
  │
  ├─ Tracking ROI?
  │   └─ graphflow_stats
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
- Start EVERY coding task with `graphflow_preview_context`
- Only read full files when compressed context is insufficient
- Never grep the whole repo before trying GraphFlow

### 2. Plan Before Complex Work
- Use `graphflow_plan` for anything beyond 2-3 files
- Use `graphflow_plan_insight` for ambiguous tasks
- Follow the DAG order (respect dependencies)
- Use context from GraphFlow at each step

### 3. Keep Graph Fresh
- Call `graphflow_index_file` after saving individual files
- Call `graphflow_index` after significant changes
- Prefer incremental index over full rebuild
- Check `graphflow_inspect_graph` if results seem off

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
1. Check if graph exists: `graphflow_inspect_graph`
2. If empty: run `graphflow_index`
3. If still empty: verify `rootDir` points to correct project

### Results seem stale
1. Run `graphflow_index` (incremental, fast)
2. If still stale: `graphflow_rebuild` (full, slow)

### Context quality is poor
1. Try more specific query terms
2. Check if symbols are indexed (inspect graph)
3. Run `graphflow_rebuild` if the graph may be stale

### Tool errors / configuration issues
1. Run `graphflow_diagnose` to check provider health
2. Verify config file exists at specified path
3. Check workspace root is correct

### Want to share graph with teammates
1. Export: `graphflow_export_artifact`
2. Send the artifact file
3. Teammate imports: `graphflow_import_artifact`

---

## Quick Reference Cheat Sheet

```typescript
// 90% of the time - start here
await graphflow_preview_context({ query: "what you're looking for" });

// Need more detail on a specific anchor?
await graphflow_expand_anchor({ anchorId: "symbol:src/foo.ts:abc123" });

// Before complex tasks
await graphflow_plan({ task: "describe the task" });

// Deep analysis with Six Thinking Hats + 5-Why
await graphflow_plan_insight({ task: "complex ambiguous task" });

// Full packaged task (bridge mode)
const result = await graphflow_run({ task: "full task description" });
// ... execute the task ...
await graphflow_report_outcome({
  episodeId: result.episodeId,
  success: true,
  lessons: ["lesson 1", "lesson 2"]
});

// After making changes - single file
await graphflow_index_file({ filePath: "src/foo.ts" });

// After making changes - workspace
await graphflow_index({ rootDir: "/path/to/project" });

// Check graph health
await graphflow_inspect_graph({ nodeLimit: 20 });

// When graph is broken
await graphflow_rebuild({ rootDir: "/path/to/project" });

// Team collaboration
await graphflow_export_artifact({ outputPath: "graph-artifact.gz" });
await graphflow_import_artifact({ inputPath: "graph-artifact.gz" });

// Leverage prior learning
await graphflow_skill_insights({ limit: 5 });

// Token savings stats
await graphflow_stats();

// Diagnose issues
await graphflow_diagnose();
```
