# GraphFlow 3.0 Token-First Rule

Use GraphFlow 3.0's 4 surgical MCP tools (`gf_read`, `gf_edit`, `gf_exec`, `gf_macro`) to cut token usage:

1. **Precise Context (`gf_read`)**: Call `gf_read({ targets: ["path/file.ts"] })` for an AST skeleton folded view, `gf_read({ targets: ["path/file.ts#symbol"] })` for symbol body + referenced types + `[Blast Radius]` call sites, or `gf_read({ q: "keyword" })`.
2. **Surgical Edit (`gf_edit`)**: Update symbols in-place via `gf_edit({ file, symbol, newCode })` and update affected `[Blast Radius]` call sites in the same turn.
3. **Dehydrated Execution (`gf_exec`)**: Run `gf_exec({ cmd: "affected-tests" })` or `gf_exec({ cmd: "..." })` for 1-line `PASS` or focused failure snippets.
4. **Auto-Macros (`gf_macro`)**: Repeated reads and command pipelines auto-compile into `.graphflow/macros/*.mjs` after 2 uses. Run them directly with `gf_macro({ action: "run", id })`.

Never call any tool to echo `assistantReply` after answering.
