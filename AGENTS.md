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
      "args": ["-y", "graphflow-mcp"]
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
- Use `graphflow_run` when you want GraphFlow to execute its own orchestration loop.
- Use `graphflow_index` after workspace changes if graph freshness matters.
- Use `graphflow_inspect_graph` and `graphflow_skill_insights` for observability.
- Use `graphflow_diagnose` when model/provider routing looks wrong.

## CLI fallback

Examples:

```bash
npx graphflow plan "refactor planner and add tests" --json
npx graphflow context preview "orchestrator" --json
npx graphflow route diagnose --json
```

Always pass `--json` when another agent or script is parsing the output.
