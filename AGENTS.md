# GraphFlow Agent Playbook

GraphFlow exposes both a CLI and an MCP server so external coding agents can call planning, orchestration, graph inspection, and context compression directly.

## Preferred entrypoints

1. Use MCP when your client supports it.
2. Fall back to CLI with `--json` when MCP is unavailable.

## MCP startup

Installed package:

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

From this repository:

```json
{
  "mcpServers": {
    "graphflow": {
      "command": "npm",
      "args": ["run", "start:mcp"],
      "cwd": "."
    }
  }
}
```

## Tool selection

- Use `graphflow_plan` before multi-step edits.
- Use `graphflow_preview_context` before large refactors or codebase-wide questions.
- Use `graphflow_run` when you want GraphFlow to plan and package a task with compressed context, returning a structured execution descriptor (executionDescriptor) for you to execute. GraphFlow delegates execution to external coding agents by default (bridge mode).
- **Mandatory:** after executing work from a `graphflow_run` `executionDescriptor`, call `graphflow_report_outcome` with the `episodeId` from the run result, a `success` boolean, and optional `lessons`. This closes the skill flywheel loop.
- Use `graphflow_index` after workspace changes if graph freshness matters.
- Use `graphflow_inspect_graph` and `graphflow_skill_insights` for observability.
- Use `graphflow_diagnose` when model/provider routing looks wrong.

### No API key? Use agent-delegated LLM

When no GraphFlow provider API is configured, `graphflow_plan_insight` and complex `graphflow_run` return **`agentWorkItems`**: Six Hats + plan prompts for **you** (the connected coding agent) to answer with your own model. GraphFlow still supplies heuristic plans, compressed graph context, and DAG structure — no external GraphFlow API required.

After answering `agentWorkItems` prompts, call `graphflow_submit_insight` with `task`, `workItemId`, and your JSON `response` to persist each answer as a Decision node in the graph (optionally pass `episodeId` from `graphflow_run` for traceability). When all items are submitted, call `graphflow_merge_insight` to merge into a full Six Hats insight and refined DAG plan before execution.

## CLI fallback

Examples:

```bash
npx @roarpeng/graphflow plan "refactor planner and add tests" --json
npx @roarpeng/graphflow context preview "orchestrator" --json
npx @roarpeng/graphflow route diagnose --json
npx @roarpeng/graphflow outcome report <episodeId> <success> --json
```

Always pass `--json` when another agent or script is parsing the output.
