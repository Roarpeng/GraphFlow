# GraphFlow + Serena: better together

> Complementary pairing guide. GraphFlow 3.0 is the **token-first surgical
> engine**; Serena is the **LSP symbol editor for the long tail of languages**.
> They are not competitors.

[中文](graphflow-serena.zh.md) · Honest comparison: [docs/comparison.md](comparison.md) · Example config: [`examples/graphflow-serena.mcp.json`](../examples/graphflow-serena.mcp.json)

GraphFlow 3.0 slices code with its own AST engine (TS/JS, Python, Go, Rust,
C/C++, C#), edits surgically with an instant static guard, and dehydrates test
output to one line. Serena reaches 40+ languages through LSP. Run both as
side-by-side MCP servers. GraphFlow does not depend on Serena at runtime —
this pairing is configuration and workflow only.

---

## Who does what

| Stage | Owner | What happens |
| --- | --- | --- |
| **See** | **GraphFlow** | `gf_read` — AST skeleton views, symbol bodies + referenced types + `[Blast Radius]` call sites, or `q` keyword search. Never a raw file dump |
| **Edit** | **GraphFlow first** | `gf_edit` — in-place symbol/line edits, batch atomic multi-edits, zero-LLM cross-repo rename, with AST syntax + caller-arity guard. Serena for languages outside the 6, or LSP-heavy refactors |
| **Verify** | **GraphFlow** | `gf_exec` — `cmd: "affected-tests"` routes git diff → affected tests; passing runs collapse to one `PASS` line |
| **Remember** | **GraphFlow** | `gf_read({ q, topicId / resumeFromTurnId })` resumes workbench/dialogue memory; hooks close the outcome flywheel automatically |
| **Long-tail symbols** | **Serena** | LSP find / rename / replace / refactor across 40+ languages |

One-line split: **GraphFlow = the 4 surgical tools; Serena = the language long tail.**

---

## Install both MCP servers

### 1. GraphFlow

No API key. `npx @roarpeng/graphflow install` wires MCP + Skill + Rules +
hooks into detected hosts; registered configs set `GRAPHFLOW_MCP_PROFILE=v3`
so agents get the 4 surgical tools out of the box.

```json
{
  "mcpServers": {
    "graphflow": {
      "command": "npx",
      "args": ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
      "env": { "GRAPHFLOW_MCP_PROFILE": "v3" }
    }
  }
}
```

### 2. Serena

Install Serena from **its** docs, not from this repo. Current recommended path
([oraios/serena](https://github.com/oraios/serena)):

```bash
# requires uv (https://docs.astral.sh/uv)
uv tool install -p 3.13 serena-agent
serena init
```

Then start the MCP server with a host-appropriate `--context`:

| Host | Typical launch |
| --- | --- |
| Cursor / Cline / Windsurf / Roo | `serena start-mcp-server --context ide --project <path>` |
| Claude Code | `serena setup claude-code` or `serena start-mcp-server --context claude-code --project-from-cwd` |
| VS Code | `serena start-mcp-server --context vscode --project ${workspaceFolder}` |

Flags, contexts, and the `uvx --from git+…` fallback change over time. Treat
[Serena's running / client docs](https://oraios.github.io/serena/) as source of
truth. `ide-assistant` is a legacy alias — prefer `ide` or `claude-code`.

### 3. Compose (both at once)

Copy [`examples/graphflow-serena.mcp.json`](../examples/graphflow-serena.mcp.json)
into your client's MCP config (Cursor `mcp.json`, Claude Desktop, …) and replace
`<your-project-path>`:

```json
{
  "mcpServers": {
    "graphflow": {
      "command": "npx",
      "args": ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"],
      "env": { "GRAPHFLOW_MCP_PROFILE": "v3" }
    },
    "serena": {
      "command": "serena",
      "args": [
        "start-mcp-server",
        "--context",
        "ide",
        "--project",
        "<your-project-path>"
      ]
    }
  }
}
```

Both are local-first. Tool names do not overlap (`gf_*` vs Serena's symbol
tools). This repository does **not** add Serena to `package.json`.

---

## Workflow

```
task
  │
  ▼
gf_read               →  symbol body + types + [Blast Radius]     (see)
  │
  ▼
gf_edit               →  definition + affected call sites,        (edit)
  │                      one turn, static-guarded; renameTo for
  │                      zero-LLM cross-repo renames
  ▼
gf_exec               →  cmd: "affected-tests"                    (verify)
  │
  ▼
gf_macro              →  repeated patterns auto-compiled          (remember)
```

**1. Read surgically.** `gf_read({ targets: ["src/foo.ts#bar"] })` returns the
symbol body, its referenced types, and the cross-repo `[Blast Radius]` call
sites. For an overview use the skeleton view (`targets: ["src/foo.ts"]`). Do
not dump whole files.

**2. Edit in the same turn.** `gf_edit` updates the definition and every
affected call site listed in the blast radius; the AST guard rolls back syntax
errors and warns on caller-arity drift. For symbols in languages outside the
six native families, hand the edit to Serena.

**3. Verify dehydrated.** `gf_exec({ cmd: "affected-tests" })` runs only the
tests touched by your diff; passing output collapses to one `PASS` line and
failures inline the 5-line source window.

**4. Let memory happen.** Repeated read/command patterns auto-compile into
`.graphflow/macros/*.mjs` (`gf_macro({ action: "run", id })`); workbench /
dialogue context resumes via `gf_read({ q, topicId })`. Outcome capture runs
through the installed hooks — no manual index step: the v3 AST index
invalidates by mtime on every read.

---

## Pitfalls

| Pitfall | What to do instead |
| --- | --- |
| Treating GraphFlow and Serena as alternatives | Compose them: `gf_*` for the six native languages, Serena for the long tail (see [comparison.md](comparison.md)) |
| Editing from a folded skeleton view | Skeletons are maps. `gf_read({ targets: ["file#symbol"] })` first, then `gf_edit` |
| Using Serena for everything in TS/JS/Python/Go/Rust/C/C++/C# | `gf_edit` is instant, static-guarded, and costs zero LLM round-trips; Serena adds value where its LSP sees languages GraphFlow's AST does not |
| Using Serena as your token budget or session memory | Serena does not fold skeletons, dehydrate test output, or compile habit macros |
| Re-reading raw files because "the index might be stale" | The v3 workspace AST cache invalidates by mtime; `gf_read` sees the current tree |
| Copy-pasting a year-old Serena `uvx git+https://…` snippet | Prefer `uv tool install` + `serena start-mcp-server`. Confirm `--context` against current Serena docs |
| Client cannot find the `serena` binary | Put the full path to the `serena` executable in `command` (common MCP-client PATH issue) |
| First-session Serena timeout | LSP cold start is slow. Raise the client's MCP timeout; `serena project index` helps large repos |
| Adding Serena as an npm dependency of GraphFlow | Do not. Pairing is MCP config only — no shared runtime, no `package.json` coupling |
| Dropping `GRAPHFLOW_MCP_PROFILE=v3` from the graphflow env | The server falls back to the 10-tool legacy surface and the `gf_*` calls stop resolving |

---

## Related

- [README](../README.md) — GraphFlow 3.0 overview
- [comparison.md](comparison.md) — when to choose GraphFlow, Serena, or neither
- [v3-architecture.md](v3-architecture.md) — the four pillars behind the gf_* tools
- [experience-memory.md](experience-memory.md) — Storage → Reflection → Experience
- [flywheel-autocapture.md](flywheel-autocapture.md) — automatic outcome close
- [Serena](https://github.com/oraios/serena) — official install and MCP client notes
