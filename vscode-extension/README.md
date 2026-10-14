# GraphFlow Token-First Surgical Engine (v3.1.0)

Token-First Surgical Code Engine for AI Coding Agents across **TypeScript/JS, Python, Go, Rust, C/C++, and C#**:

- **`gf_read`**: AST Skeleton Folding (93% fewer tokens than raw file reads), exact symbol slicing, automatic Cross-File Type Closure, and 3-line `[Blast Radius]` call-site micro-snippets.
- **`gf_edit`**: Bottom-up batch atomic edits, zero-LLM cross-repo symbol rename (`renameTo`), and instant AST syntax, caller-arity, and struct-field deletion guards.
- **`gf_exec`**: 2-hop reverse import Diff-to-Test router and terminal output dehydrator (99% fewer test log tokens) with 3-strike edit-test loop circuit breaker.
- **`gf_macro`**: Zero-cold-start Git co-change miner (`mine-git`) and trajectory auto-compiler (`.graphflow/macros/*.mjs` & isomorphic auto-codemods).

## Commands

- **GraphFlow: Install MCP, Skills & Hooks to Agents** (`graphflow.installMcp`)
- **GraphFlow: Mine Git Co-Change History** (`graphflow.mineGit`)
- **GraphFlow: Show Detected Agents Status** (`graphflow.status`)
