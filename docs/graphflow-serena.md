# GraphFlow + Serena: better together

> Complementary pairing guide. GraphFlow is the **memory & context harness**;
> Serena is the **symbol-precise editor**. They are not competitors.

[中文](graphflow-serena.zh.md) · Honest comparison: [docs/comparison.md](comparison.md) · Example config: [`examples/graphflow-serena.mcp.json`](../examples/graphflow-serena.mcp.json)

GraphFlow compresses what the agent should *see* and remembers what it *learned*.
Serena locates and edits symbols through LSP (40+ languages). Run both as
side-by-side MCP servers. GraphFlow does not depend on Serena at runtime —
this pairing is configuration and workflow only.

---

## Who does what

| Stage | Owner | What happens |
| --- | --- | --- |
| **See** | **GraphFlow** | `graphflow_context` — compressed anchors + summaries under a token budget, plus similar episodes / skill hints |
| **Plan** | **GraphFlow** | `graphflow_plan` — task DAG (and optional `graphflow_run` bridge descriptor). GraphFlow does **not** execute edits |
| **Edit** | **Serena** | LSP find / rename / replace / refactor at symbol granularity |
| **Remember** | **GraphFlow** | After edits: `graphflow_index` (graph freshness), then `graphflow_report_outcome` if you used `graphflow_run` |

One-line split: **GraphFlow = memory; Serena = hands.**

---

## Install both MCP servers

### 1. GraphFlow

No API key. Offline AST index + MCP:

```bash
npx @roarpeng/graphflow graph index .
```

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

Or `npx @roarpeng/graphflow install` to wire MCP + Skill + Rules into detected hosts.

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
      "args": ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"]
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

Both are local-first. Tool names do not overlap (`graphflow_*` vs Serena's
symbol tools). This repository does **not** add Serena to `package.json`.

---

## Workflow

```
query
  │
  ▼
graphflow_context     →  summary + anchors + tokenBudget  (see)
  │
  ▼
graphflow_plan        →  DAG / workbench topics           (plan; skip if the edit is obvious)
  │
  ▼
Serena symbol tools   →  find / rename / replace body     (edit)
  │
  ▼
graphflow_index       →  incremental / file refresh       (graph matches the tree)
  │
  ▼
graphflow_report_outcome  (required after graphflow_run)  (remember)
```

**1. Context first.** Call `graphflow_context` with the task. Use `summary`,
`anchors`, and `tokenBudget` as the first context. Expand an `anchorId` only
when the compressed package is not enough. Do not dump the repo.

**2. Plan when the work is multi-step.** `graphflow_plan` seeds a DAG. If you
take `graphflow_run`, keep the returned `episodeId` — you must close it later.

**3. Edit with Serena.** Ask the host agent to use Serena for symbol location
and precise edits (rename across 40+ languages, replace a function body,
targeted refactor). GraphFlow's anchors are *pointers*, not a license to
rewrite files from a compressed summary.

**4. Close the loop.** After file changes, `graphflow_index` (pass `filePath`
for a single file). If you used `graphflow_run`, call
`graphflow_report_outcome` with that `episodeId`, a `success` boolean, and
optional `lessons`. Auto-capture hooks can close pending episodes at session
end, but an explicit report is the honest close — see
[flywheel-autocapture.md](flywheel-autocapture.md).

After answering, `graphflow_context({ assistantReply })` stores the original
reply on the workbench turn.

---

## Pitfalls

| Pitfall | What to do instead |
| --- | --- |
| Treating GraphFlow and Serena as alternatives | Compose them. Pick one only when you truly need a single tool (see [comparison.md](comparison.md)) |
| Editing from a compressed GraphFlow summary | Summaries are pointers. Expand a File/Symbol anchor, or let Serena read the symbol, before changing code |
| Using GraphFlow to "precisely rename a symbol" | That is Serena's job (LSP). GraphFlow will not give you language-server rename |
| Using Serena as your context budget / session memory | Serena does not compress to a token budget or run the Episodic / Skill / Decision flywheel |
| Skipping `graphflow_report_outcome` after `graphflow_run` | The flywheel stays pending. Report success/failure (or rely on installed auto-capture hooks) |
| Forgetting `graphflow_index` after Serena edits | Next `graphflow_context` can rank stale symbols. Index the touched files |
| Copy-pasting a year-old Serena `uvx git+https://…` snippet | Prefer `uv tool install` + `serena start-mcp-server`. Confirm `--context` against current Serena docs |
| Client cannot find the `serena` binary | Put the full path to the `serena` executable in `command` (common MCP-client PATH issue) |
| First-session Serena timeout | LSP cold start is slow. Raise the client's MCP timeout; `serena project index` helps large repos |
| Adding Serena as an npm dependency of GraphFlow | Do not. Pairing is MCP config only — no shared runtime, no `package.json` coupling |
| Assuming auto-capture means you can skip outcomes | Auto-capture writes *pending* episodes; hooks may close them later. Prefer an explicit report after `graphflow_run` |

---

## Related

- [README](../README.md) — GraphFlow harness overview
- [comparison.md](comparison.md) — when to choose GraphFlow, Serena, or neither
- [context-contract.md](context-contract.md) — compressed context is a pointer
- [experience-memory.md](experience-memory.md) — Storage → Reflection → Experience
- [flywheel-autocapture.md](flywheel-autocapture.md) — automatic outcome close
- [Serena](https://github.com/oraios/serena) — official install and MCP client notes
