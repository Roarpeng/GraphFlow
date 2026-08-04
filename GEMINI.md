<!-- GRAPHFLOW:BEGIN managed block — edit outside these markers only -->
## GraphFlow Context-First Rule

GraphFlow is a local code knowledge-graph + context compression MCP server (10 tools).
Before broad code exploration, implementation, debugging, review, or architecture
questions in this project:

1. Call `graphflow_context` with the task/query first.
2. Use the returned `summary`, `anchors`, and `tokenBudget` as the primary context.
3. Read full files only when anchors point there or compressed context is insufficient.
4. For multi-step or ambiguous work, call `graphflow_plan` before implementing.
5. After project changes, call `graphflow_index` to keep the graph fresh.
6. The flywheel auto-closes: pending episodes are backfilled by Claude Code
   hooks (or `graphflow_report_outcome`) by default; set GRAPHFLOW_AUTO_CAPTURE=0 to opt out.

When using Cursor `CallMcpTool`, always pass `server` + `toolName` + `arguments`
(e.g. server `"graphflow"` / `"user-graphflow"`, toolName `"graphflow_context"`).

Tools: graphflow_context, graphflow_plan, graphflow_run, graphflow_report_outcome,
graphflow_insight, graphflow_index, graphflow_artifact, graphflow_skill_insights,
graphflow_skill_guide, graphflow_diagnose.

Do not scan the whole repository or read many large files before trying GraphFlow
context. Treat GraphFlow output as structured, token-saving context.
<!-- GRAPHFLOW:END -->

