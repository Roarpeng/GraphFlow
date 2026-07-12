<!-- GRAPHFLOW:BEGIN managed block — edit outside these markers only -->
## GraphFlow Context-First Rule

GraphFlow is a local code knowledge-graph + context compression MCP server.
Before broad code exploration, implementation, debugging, review, or architecture
questions in this project:

1. Call `graphflow_preview_context` with the task/query first.
2. Use the returned `summary`, `anchors`, and `tokenBudget` as the primary context.
3. Read full files only when anchors point there or compressed context is insufficient.
4. For multi-step or ambiguous work, call `graphflow_plan` before implementing.
5. After project changes, call `graphflow_index` to keep the graph fresh.

Do not scan the whole repository or read many large files before trying GraphFlow
context. Treat GraphFlow output as structured, token-saving context.
<!-- GRAPHFLOW:END -->

