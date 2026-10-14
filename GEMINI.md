<!-- GRAPHFLOW:BEGIN managed block — edit outside these markers only -->
# GraphFlow 3.0 for Gemini CLI (Token-First Surgical Mode)

Use GraphFlow 3.0's 4 surgical MCP tools to minimize token spend and round-trips:

1. **`gf_read` (Precise Context)**:
   - Never read large files raw. Pass `targets: ["path/file.ts"]` for an AST skeleton folded view, `targets: ["path/file.ts#symbolName"]` for the symbol body + referenced types + cross-repo `[Blast Radius]` call sites, or `q: "keyword"` to locate and slice.
2. **`gf_edit` (Surgical Edit + Instant Static Guard)**:
   - Update symbols in-place with `gf_edit({ file, symbol, newCode })` (or `startLine`/`endLine`) and update any affected call sites listed in `[Blast Radius]` in the same turn.
3. **`gf_exec` (Dehydrated Execution & Affected Tests)**:
   - Run `gf_exec({ cmd: "affected-tests" })` or `gf_exec({ cmd: "..." })`. Passing commands return 1 line (`PASS`); failures extract only the error assertion and inline 5 lines of workspace source context.
4. **`gf_macro` (Auto-Recorded Tools)**:
   - Repeated reads and command pipelines auto-compile into `.graphflow/macros/*.mjs` after 2 occurrences. Run them in 1 step via `gf_macro({ action: "run", id })`.

Do NOT call any tool to echo `assistantReply` after answering the user.
<!-- GRAPHFLOW:END -->
