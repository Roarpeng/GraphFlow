# GraphFlow

**English** | [简体中文](./README.zh.md)

[![npm](https://img.shields.io/npm/v/@roarpeng/graphflow)](https://www.npmjs.com/package/@roarpeng/graphflow)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![CI](https://github.com/Roarpeng/GraphFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/Roarpeng/GraphFlow/actions/workflows/ci.yml)
[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-roarpeng.graphflow-blue)](https://marketplace.visualstudio.com/items?itemName=roarpeng.graphflow)

> **The Token-First Surgical Code Engine for AI Coding Agents (v3.6.1)**
> An MCP server exposing exactly 4 surgical tools — `gf_read`, `gf_edit`, `gf_exec`, `gf_macro` — with **true AST parsing for all six language families**: TypeScript/JavaScript via `@babel/parser`, and Python, Go, Rust, C/C++, C# via optional tree-sitter grammars (the built-in structural analyzers remain the fallback). A **self-written semantic index** resolves call targets for blast radius/rename (no extra runtime deps), and **precision-tuned doc↔code linking** (BM25/IDF + PMI + caps + confidence) keeps the knowledge graph honest. **Six-language parity is regression-tested** (51-case matrix), bilingual retrieval scores **1.000 EN / 1.000 ZH** on the isolated + packed 30+30 pair corpus, and **local task reflection** replays recorded shell instructions — by explicit record or by auto-harvesting an external instruction log — with no LLM/network calls. Runtime dependencies: `@babel/parser`, `@modelcontextprotocol/sdk` and `tree-sitter`; the grammar packages are optional.

---

## GraphFlow 3.0 — The Radical Rewrite

Version 3.0 **replaced the entire 2.x architecture**. The 10-tool knowledge-graph / context-compression MCP surface (`graphflow_context`, `graphflow_plan`, `graphflow_run`, `graphflow_index`, `graphflow_insight`, `graphflow_skill_*`, `graphflow_diagnose`, `graphflow_artifact`), the episodic-skill flywheel, the VS Code graph-memory extension, and LLM routing were **all removed**. In their place: 4 deterministic surgical tools over an AST/structural pipeline. MCP schema tax dropped **92.2%** (5897 → 458 tokens per turn).

| 2.x (removed) | 3.x replacement |
| :--- | :--- |
| `graphflow_context(...)` | `gf_read({ targets, q, skeleton: true })` |
| `graphflow_plan` / `graphflow_run` | Removed — deterministic pipeline, no LLM routing |
| `graphflow_index` | Removed — the symbol index is built on demand |
| `graphflow_insight` / `graphflow_skill_*` | `gf_macro({ action: "mine" \| "mine-git" })` |
| `graphflow_diagnose` | `graphflow status` (CLI) |
| `graphflow_artifact` | `gf_macro({ action: "visualize" })` → `.graphflow/knowledge-graph.html` |
| `GRAPHFLOW_MCP_PROFILE` env | Removed — the 4 `gf_*` tools are the only surface |
| VS Code graph-memory extension | Thin prebuilt launcher (see [VSIX-INSTALL.md](./VSIX-INSTALL.md)) |
| Dialogue / workbench memory features | Removed with the flywheel; `gf_read({ targets: ["@brief"] })` covers cross-session handoff |

**2.x users must switch tool calls `graphflow_*` → `gf_*`.** There is no compatibility layer.

| Version | Notes |
| :--- | :--- |
| 2.3.0 | Last legacy release (10-tool knowledge-graph MCP) |
| 3.0.0 | Radical rewrite — breaking, 4 surgical tools |
| 3.1.0 | 21-agent installer, 3-strike circuit breaker, git co-change miner, struct-field contract guard |
| 3.1.1 | Thin prebuilt VS Code extension, VSIX on GitHub Releases |
| 3.2.0 | Doc-graph (cross-agent brief, doc↔code linking, HTML knowledge graph) + bilingual tokenizer |
| 3.2.1 | Fix pack: affected-tests honors `package.json` `scripts.test`, `gf_exec` `run:true` execute-vs-preview gating, brief hub in-degree for extension-ful imports |
| **3.3.0** | **Auto-register on VSIX activate (once per version, `graphflow.autoInstall` opt-out) + legacy registration prune on `install` (alias keys, stale launchers, removed-agent leftovers; `--no-prune` to skip)** |
| **3.3.1** | **Method-aware blast radius & rename (member call sites, abort on unresolved callers) · real DSH Cordis-patch install (`cwd` + `GRAPHFLOW_WORKSPACE_ROOT`) · safe scoped `uninstall` (`--agents` / `--all`) · Python heuristic syntax guard · `exec` argument parsing · failure source window after `Error:` + stack frame · Go/Rust `struct` kind** |
| **3.3.2** | **Real knowledge-graph edges (defines/imports/calls/doc-links-code/co-edit, class-qualified method ids, 5000-edge cap) · receiver-type-aware blast radius & rename (A/B same-name disambiguation, `REJECTED [ambiguous-symbol]`) · tsconfig/jsconfig alias + dynamic-import aware affected-test routing** |
| **3.3.3** | **Type-aware knowledge-graph calls (receiver-matched targets, foreign receivers dropped, alias-resolved imports) · inheritance/`super`/`base` receiver inference (subclass→base dispatch, last-assignment-wins, generic/array/nullable unwrapping) · tsconfig/jsconfig `extends` chains, nested configs and project references for affected-test routing · `npm run bench` harness** |
| **3.3.4** | **Safe host-hook merge on `install` (user `PreToolUse`/`PostToolUse` hooks preserved; idempotent reinstall) · `uninstall` removes only GraphFlow hooks · `graphflow status` per-agent registration state (`[MCP ✓] [Skill ✓] [Rule -] [Hook ✓]`) with `--agents` / `--all` · MCP stdio end-to-end test (initialize → tools/list 4 tools → gf_read/gf_exec → graceful unknown tool)** |
| **3.4.0** | **True AST by default for Python/Go/Rust/C/C++/C# via optional tree-sitter grammars (`engine: "tree-sitter"`); structural fallback when bindings are missing, `GRAPHFLOW_TREE_SITTER=0` forces structural · C/C++ header/prototype handling and Python `super` receiver · dependency story: required `tree-sitter` core + optional grammar packages · refreshed benchmark measurements** |
| **3.5.0** | **Doc↔code link precision (self-written BM25/IDF + PMI + reciprocal pruning + caps, `GRAPHFLOW_DOC_LINKS_MAX`; repo 728 → ≈150 edges, −80%) · `graphflow doctor parsers` + `npm run verify:parsers` + additive CI parser matrix · self-written L0 semantic index (confidence ≥0.75) with optional TypeScript/LSP providers · DSH config bundle `@roarpeng/graphflow-dsh` · release preflight (`npm run preflight` / `preflight:release`) · refreshed benchmarks** |
| **3.6.0** | **48-case six-language parity matrix + fixes (family-scoped `resolveMethod`/rename, Go embedding/grouped params, C typedef fields, Rust `&dyn`/`impl` unwrap, C/C++ header prototype↔definition rename) · bilingual recall 1.000 EN / 1.000 ZH on 30 pairs (pinyin/mixed/synonym 1.000; baseline ZH@1 0.967, pinyin 0.769) · local task reflection (`graphflow task`/`reflect`, `gf_macro` task-list/run/record) · Windows CRLF test fix; CI (6 jobs) + parser matrix (7 jobs) green · 458-token wire · 24 test files** |
| **3.6.1** | **Six-language parity 51 tests: Rust trait dispatch CLOSED (trait methods with `parentClass`=trait; `dyn Trait`/`impl Trait` receivers resolve to the trait method, concrete receivers to the impl), C# `record`/`record struct` kinds + positional fields + namespace map CLOSED (Go same-package imports stays an honest gap) · packed-file bilingual corpus: packed EN 1.000 / ZH 1.000 @1/@3/@5 (ZH@1 was 0.900; ±7-line own-doc bleed fixed) · task auto-harvest (`.graphflow/instruction-log.jsonl`, `task log`/`task harvest`, `gf_macro` `task-harvest`; external writer needed) · 458-token wire · 24 test files** |

## The Four Surgical Tools

| Tool | Purpose | Key arguments |
| :--- | :--- | :--- |
| `gf_read` | Symbol slices with cross-file type closure + receiver-type-aware `[Blast Radius]` call sites (semantic index first, then inheritance/`super` heuristics), skeleton folding, bilingual search (1.000 EN/ZH parity recall), `@brief` cross-agent handoff | `targets`, `q`, `topK`, `skeleton`, `dedup` |
| `gf_edit` | In-place / batch atomic edits, zero-LLM cross-repo rename (semantic target check first, receiver/inheritance heuristics as fallback; family-scoped staging, rejects ambiguous/foreign-receiver files; aborts if unresolved callers remain), struct-field contract guard | `file`, `symbol`, `newCode`, `edits`, `renameTo` |
| `gf_exec` | Diff-to-test routing (honors `package.json` `scripts.test`; resolves tsconfig/jsconfig aliases, `extends` chains, nested configs and dynamic imports) + output dehydrator: passing suites → 1-line `PASS`; failures inline up to 5 lines of source context; `run: true` executes, otherwise preview | `cmd`, `changedFiles`, `handle`, `run` |
| `gf_macro` | Habit macros, git co-change mining, knowledge-graph HTML export (type-aware `calls`, alias-resolved `imports`, BM25/IDF-capped `doc-links-code`; plus `defines` / `co-edit` edges), and **local task reflection** (`task-list` / `task-run` / `task-record` / `task-harvest`) | `action: "list" \| "run" \| "save" \| "mine" \| "mine-git" \| "visualize" \| "brief" \| "task-list" \| "task-run" \| "task-record" \| "task-harvest"` |

Session read dedup skips unchanged files; 3 consecutive edit-test failures trigger a deterministic rescue packet (blast-radius contracts + recent git diffs). Syntax guards use the true-AST backends when available — `@babel/parser` for TS/JS and tree-sitter ERROR/MISSING diagnostics for the other five — with the structural analyzers' heuristic checks (brace/declaration, Python missing-colon/bracket diagnostics) as the fallback, including when `GRAPHFLOW_TREE_SITTER=0` is set.

## What's New in 3.6.1

- **Parity suite 48 → 51 tests** — `tests/language-parity.test.ts` now closes two documented gaps: **Rust trait dispatch** (trait methods are emitted as methods with `parentClass` = trait name, so `dyn Trait` / `impl Trait` receivers resolve to the trait method and concrete receivers to the impl; cross-file trait/impl assertions plus structural-fallback trait scope) and **C# record kinds** (`record` → class, `record struct` → struct, positional record parameters exposed as fields). The self-written semantic index now builds a C# `namespace → files` map used for `using`/import, symbol and method-candidate resolution (with a file-stem fallback). **Go same-package imports remains an honest gap**: same-package sibling files still have no file-level `imports` edge (no invented edges; package-scope calls/edges resolve). Remaining residuals: trait+impl atomic rename is rejected safely, `impl Trait for Type` is not modelled as subclassing, doc-graph KG `calls` still uses a dir/stem heuristic for ambiguous same-stem namespaces (imports are correct), C is function-level, Go only models the first embedded type, rename stays conservative, and C++ prototype targeting is best-effort.
- **Packed-file bilingual corpus** — the bilingual parity suite now adds a packed-file corpus (6 symbols per file, Chinese-only docstrings) beside the isolated 30-pair corpus. Packed **EN 1.000 / ZH 1.000 at @1/@3/@5** (packed ZH@1 was 0.900 before the fix); own-doc-comment extraction no longer uses a fixed ±7-line window that bleeds into adjacent symbols, plus term caps/normalization. Isolated one-symbol, pinyin, mixed and synonym queries remain **1.000**. Residuals unchanged: generic English still cannot disambiguate pinyin-named symbols at @1, and the glossary is curated.
- **Task auto-harvest (still no LLM/network)** — reflection can now be fed by an external instruction log: `.graphflow/instruction-log.jsonl` written with `graphflow task log "<instruction>" --step "<cmd>"` (append-only; `--log <path>` override), then `graphflow task harvest [--log <path>]` promotes repeated normalized instructions into the same `.graphflow/tasks.json` + compiled `.graphflow/tasks/<id>.mjs` runners. MCP equivalent: `gf_macro({ action: "task-harvest", instruction, steps })` or a bare `task-harvest` to harvest the log. Harvesting is incremental via a byte-offset state file (`.graphflow/task-harvest.json`); the explicit `graphflow task record` path is unchanged and `graphflow reflect` still returns `MISS` when nothing matches. Limits: **an external writer is still needed** (shell wrapper / DSH skill appends to the log — there is no host hook or daemon), steps run locally with the recorder's privileges, `{{argN}}` parameters are manual, and concurrent records are last-writer-wins.
- **Version/state** — 3.6.1; MCP wire stays **458 tokens**, the suite is **24 test files**, CI (6 jobs) + parser matrix (7 jobs) remain green, and the benchmark numbers are the final 3.6.0 run (unchanged).

## What's New in 3.6.0

- **Six-language parity matrix & fixes** — new `tests/language-parity.test.ts` (48 tests) asserts symbol/span/field parity for TS/JS, Python, Go, Rust, C/C++, C# across slicing + type closure, receiver-aware blast radius, cross-file rename, and knowledge-graph `defines`/`imports`/`calls`. Fixes: language-family-scoped `resolveMethod`/rename staging (no cross-language leakage), Go struct embedding + grouped params + embedded fields, C `typedef struct` fields, Rust `&dyn`/`impl` receiver unwrap, and the C/C++ header prototype↔definition rename cluster. Documented residuals: Go same-package siblings have no file `imports` edge; Rust trait declarations are not emitted as method symbols (trait dispatch yields 0, never a wrong target); C# `record` maps to `interface` kind; C is function-level (no inheritance); deep/multiple Go embedding is not chained; the structural fallback is not part of the parity matrix. (3.6.1 raises this suite to 51 tests and closes the Rust trait-dispatch and C# record gaps; Go same-package imports remains the honest gap — see above.)
- **Bilingual recall 1.000 / 1.000** — new `tests/bilingual-parity.test.ts` measures 30 EN/ZH query pairs: EN and ZH recall are both **1.000 at @1/@3/@5**, and pinyin / mixed / synonym families are **1.000** (baseline ZH@1 0.967, pinyin 0.769). Tokenizer fixes: morphological-rescue asymmetry, synonym forward-expansion pollution, a missing zh/pinyin glossary + EN→ZH pinyin bridge, and over-broad mappings. Residuals: slicer doc-window/name weighting can still affect tightly packed files; generic English cannot disambiguate pinyin-named symbols at @1; the glossary is curated. (3.6.1 adds a packed-file corpus and fixes packed ZH@1 0.900 → 1.000 with own-doc-comment extraction.)
- **Local task reflection (no LLM, no network)** — repeated shell instructions can be recorded into `.graphflow/tasks.json` and compiled to `.graphflow/tasks/<id>.mjs`: `graphflow task list|show|record|run` (`--step` / `--steps` / `--args` / `--json` / `--root`) and `graphflow reflect "<instruction>"` (returns `MISS` when unknown), or MCP `gf_macro` actions `task-list` / `task-run` / `task-record` with `instruction`. The second recording promotes the task, and later identical/near-match (token-Jaccard 0.86) instructions replay it locally. The MCP surface stays exactly 4 tools at **458 wire tokens**. Limits: explicit recording only (no auto-harvest yet), shell steps run locally with the recorder's privileges, manual `{{argN}}` parameterization, and last-writer-wins on concurrent cross-process records. (3.6.1 adds external-log auto-harvest via `graphflow task log` / `graphflow task harvest`.)
- **CI & release** — the Windows CI `dsh-bundle` CRLF failure is fixed in the test (tamper check is now CRLF-safe; the validator is unchanged); **CI (6 jobs)** and the **parser matrix (7 jobs)** are green across ubuntu/windows/macos × Node 20/22 (plus the strict ubuntu job). The existing publish workflows are untouched; `npm run preflight` / `preflight:release` and `npm run task` / `npm run reflect` are available, and the suite now has **24 test files**.
- **Measurements** — wire schema is **458 tokens**; skeleton folding 27,926 → 7,840 (71.9%), symbol slice 27,926 → 1,165 (95.8%), PASS dehydration 5,946 → 30 (99.5%, 24-file suite), knowledge graph ≈1,277 nodes / ≈2,750 edges in ≈2.08 s (165 doc links), affected-test routing 26 ms (16 tests), blast radius 7 ms. See [Benchmarks](#benchmarks).

## What's New in 3.5.0

- **Doc↔code link precision** — the doc-graph linker is now a self-written retrieval pipeline: BM25/IDF over field-weighted section terms (title and explicit identifiers boosted), a PMI-style rare-token-pair reward, reciprocal top-K on both the section and symbol sides, margin pruning and greedy maximum-weight matching, per-section and per-symbol caps (≤3), a global cap via `GRAPHFLOW_DOC_LINKS_MAX` (default 400), and a per-link confidence label. On this repo doc↔code edges dropped from **728 → ≈150 (−80%)**; explicit reference links dominate but are also bounded by the caps (they get priority inside them), and concept-only links require score margin/confidence. `.md` / `.html` / `.xml` / `.docx` / `.pdf` are still supported, and `.graphflow/doc-link-feedback.json` is a read-only accept/reject input.
- **Parser matrix & doctor** — `graphflow doctor parsers` (alias `graphflow parsers`, `--strict`) prints the tree-sitter core/grammar versions and the effective default engine; `npm run verify:parsers` runs `scripts/verify-parsers.mjs` over six fixtures in both true-AST mode and `GRAPHFLOW_TREE_SITTER=0` structural mode (`--json`, `--strict`, `--check-install` supported). A new additive `.github/workflows/ci-parser-matrix.yml` covers ubuntu/windows/macos × Node 20/22 plus a strict ubuntu job; the existing ci/publish workflows are untouched.
- **Self-written L0 semantic index** — `src/semantic-index.ts` (no new dependencies) builds a module graph (root tsconfig/jsconfig aliases, barrels/re-exports), a workspace symbol table, and a per-file type environment (annotations, `new`, params, fields, assignments, branch conflicts unknown, generics/nullable/array unwrapping, inheritance/`super`), plus resolved call targets with confidence. Blast radius and rename consult it first (confidence ≥0.75) and fall back to the language heuristics. Residual limits: root config only (no `extends`/project references), default/namespace import limits, no flow narrowing or generic substitution.
- **Optional semantic acceleration** — `src/ts-semantic.ts` wraps the TypeScript Compiler API lazily through the existing devDependency (returns `undefined` when absent; `resolveCallTarget` / `getReferences` / `getTypeAt`), and `src/lsp-bridge.ts` is a self-written JSON-RPC stdio LSP client with presets for pyright/pylsp, gopls, rust-analyzer, clangd, OmniSharp/csharp-ls and typescript-language-server (timeouts, lazy restart, dispose). Both are **optional**: no new required dependencies and no bundled language servers — availability depends on your environment.
- **DSH config bundle** — the new `@roarpeng/graphflow-dsh` package (version mirrors the CLI) is a configuration-only Cordis bundle: `dsh.bundle.patch` inserts the same `mcp-graphflow` stdio row (cwd from `GRAPHFLOW_WORKSPACE_ROOT`, falling back to DSH's default working directory) and ships the skill. Install with `plugin_manager install_bundle` (or `node scripts/install-dsh-bundle.mjs --print|--stage|--check`). Honest DSH matrix: **MCP ✅ · Skill ✅ · Rules ❌ · Hooks ❌**. Use the bundle **or** `graphflow install --agents deepseek-harness`, not both (same row id/serverName); the CLI installer still copies the skill to `DSH_HOME/skills`.
- **Release preflight** — `npm run preflight` is a read-only gate over version consistency (package / lock / extension / README taglines), required files, `mcp.json`, existing workflow key contracts, skill frontmatter and package metadata; `npm run preflight:release` adds `npm test`, `npm pack --dry-run` and a local `vsce package` dry run (skipped when vsce is absent). The existing ci/publish-npm/publish-marketplace workflows are unchanged and validated; the parser matrix is additive. Audit caveats: the tag-vs-version guard is not in CI, and the VSIX workflow packages the committed extension build.
- **Measurements (3.5.0 run — historical; current 3.6.0 numbers above)** — MCP wire 459 tokens; skeleton 27,507 → 7,694 tokens (72.0%, 68–86% range); symbol slice 95.8% (~96%); PASS dehydration 4,282 → 30 tokens (99.3%); knowledge graph ≈1,156 nodes / ≈2,436 edges built in ≈1.15 s (≈145–150 doc links); affected-test routing 22 ms; blast radius 6 ms. See [Benchmarks](#benchmarks).

## What's New in 3.4.0

- **Six-language true AST on by default** — `analyzeSourceFile` now parses Python, Go, Rust, C/C++, C# with tree-sitter whenever the optional native bindings are installed (`engine: "tree-sitter"`); the built-in structural analyzers remain the fallback when a grammar is missing, and `GRAPHFLOW_TREE_SITTER=0` forces the structural path. TypeScript/JavaScript keeps its `@babel/parser` true AST. The tree-sitter backend extracts symbols (kind/span/signature/params/`parentClass`/fields/referencedTypes), imports, calls (callee/receiver/member/argsCount/caller/`isDeclaration`) and ERROR/MISSING syntax diagnostics; C/C++ prototypes are kept as `isDeclaration` call sites and deduped against definitions, and `.h` headers try the C++ grammar before falling back to C.
- **Python `super` receiver** — receiver inference understands `super()` / `super(A, self)` calls from the tree-sitter CST, alongside the existing `super`/`base` handling in blast radius and rename.
- **Dependency story changed** — required runtime deps are now `@babel/parser`, `@modelcontextprotocol/sdk` and `tree-sitter`; the six grammar packages (`tree-sitter-python`/`-go`/`-rust`/`-c`/`-cpp`/`-c-sharp`) are installed as optionalDependencies. npm may print peer-range warnings from the native grammars during install — that is expected, and a missing grammar simply falls back to the structural analyzer for that language. No other runtime dependencies are used.
- **Refreshed measurements** — the benchmark harness was re-run after the true-AST switch: MCP wire schema is still 459 tokens; skeleton folding 25,994 → 7,178 tokens (72.4%, 68–86% range across repo files); single-symbol slice ~95–96% (varies slightly per run); passing-suite dehydration 2,966 → 30 tokens (99.0%); knowledge graph ≈750 nodes / ≈2.2k edges built in ≈1 s; affected-test routing 31 ms. See [Benchmarks](#benchmarks).

## What's New in 3.3.4

- **Safe host-hook merge & uninstall** — `graphflow install` now merges GraphFlow `PreToolUse` / `PostToolUse` hooks into each host's existing hook config (Cursor, Claude Code, Codex, Gemini CLI) instead of overwriting it: user hooks in the same phase and all unrelated phases/keys are preserved, Claude/Codex/Gemini nested hook entries are filtered hook-by-hook, and re-running install refreshes only the GraphFlow entries (idempotent). `graphflow uninstall` removes only GraphFlow-owned hook entries, leaves user hooks untouched, and keeps the hook file valid JSON.
- **Per-agent registration status** — `graphflow status` now prints one line per agent showing exactly what is registered, e.g. `[MCP ✓] [Skill ✓] [Rule -] [Hook ✓] Cursor (cursor)`, and accepts `--agents <id1,id2>` / `--all` to scope the report (`graphflow doctor` is an alias).
- **MCP stdio end-to-end test** — a new e2e test drives the real stdio server through `initialize` → `notifications/initialized` → `tools/list` (exactly 4 `gf_*` tools, 459-token wire payload) → `gf_read` (symbol slice + `[Blast Radius]`) → `gf_exec` (`affected-tests` receipt) → an unknown tool (graceful error, no crash) → `tools/list` again. It runs as part of `npm test`.

## What's New in 3.3.3

- **Type-aware knowledge-graph calls** — `graphflow graph` now reuses the same receiver-type inference as blast radius: when a call's receiver resolves to a class, only a method declared on that class can be the target, and foreign receivers are dropped instead of misattributed (same-file `a.cancel()` / `b.cancel()` resolve to `A.cancel` / `B.cancel`). Unknown receivers keep the same-file → explicit-import → narrow-package heuristics. File → file `imports` edges now also resolve local `tsconfig.json` / `jsconfig.json` `compilerOptions.baseUrl` + `paths` aliases (root config only) in addition to relative paths. Caveat: calls remain best-effort heuristics, **not type-checked**; the 5000-edge cap and Go/C# stem/dir import fallback still apply.
- **Inheritance- and `super`-aware receiver inference** — receiver inference now parses class parents for TS/JS `extends` + `super.method()`, Python `class B(A)` + `super()`, C# `class B : A` + `base.Method()`, and C++ `class B : public A` + `A::method()`. `super`/`base` resolve to the parent class, and a subclass receiver counts for an inherited base method when no intermediate class overrides it. Inference is flow-insensitive with last-assignment-wins (conflicting branch assignments stay unknown), and generic/array/nullable wrappers are unwrapped (`Box<Order>`, `Order | null`, `Order[]`, `&Order`); C++ `auto x = new Type()` / `Type{}` is handled too. Residual limits: multi-level override chains require the intermediate class to be parseable, Rust traits and Go embedding are intentionally not inherited, and ambiguous unions/factory returns remain unknown. Still no type checker.
- **`extends` / nested configs / project references for affected tests** — `gf_exec({ cmd: "affected-tests" })` now merges `tsconfig.json` / `jsconfig.json` `extends` chains (relative paths and node_modules packages via `package.json` `tsconfig`, arrays, cycle-safe, child overrides parent), picks the nearest config walking upward from the importing file, inherits the same way for `jsconfig.json`, and adds root `references[].path` project configs as extra alias sources. Limits: no nested project-to-project reference traversal, no Node `exports` map, `node_modules` `extends` stops at the workspace root, and configs are cached for the process lifetime.
- **Local benchmark harness** — after `npm run build`, `npm run bench` runs `scripts/benchmark.mjs` and writes `benchmarks/latest.md` + `benchmarks/latest.json`; see [Benchmarks](#benchmarks).

## What's New in 3.3.2

- **Real knowledge-graph edges** — `graphflow graph` now exports a best-effort dependency graph instead of a flat inventory: `defines` (file → symbol), `imports` (file → file, resolved from each file's imports), `calls` (symbol → symbol; the caller symbol is the source when it can be identified, otherwise the file node), `doc-links-code`, and `co-edit`. Symbol node ids are class-qualified for methods (`sym:file#Class.method`) so same-named methods no longer collide, and the single-file HTML legend/colors/inspector render all five edge kinds. Caveats: `calls` edges are best-effort heuristics, **not type-checked** (3.3.3 adds receiver-type matching); edges are capped at 5000 for large repos; Go and C# `imports` edges fall back to file-stem/directory matching because package paths and namespaces are not file paths.
- **Receiver-type-aware blast radius** — for methods, `gf_read` resolves each call's receiver from local declarations, annotations, `new Type()`, parameters, class fields, `var x Type` / `x := Type{}` (Go), `let x: Type` (Rust), `Type x` (C++/C#), method receivers, `this`/`self`/`cls`/`Self`, and `Class.method`/`Class::method`. Known-mismatched receivers are excluded and known-matching receivers accepted; an unknown receiver in the declaring file is ignored (so `A.cancel` vs `B.cancel` in one file disambiguate), while unknown receivers in other files still count under the importer heuristic. This remains a static heuristic — not flow-sensitive: factory returns and dynamic/duck-typed receivers stay unresolved (3.3.3 adds inheritance/`super` and last-assignment handling; see above).
- **Safer rename** — `gf_edit({ renameTo })` reuses the same receiver resolution: files whose only matching calls belong to a foreign receiver are skipped, files that mix target and foreign receivers are rejected as `REJECTED [ambiguous-symbol]`, and same-name sibling declarations are rejected before anything is written. The post-rename unresolved-caller rollback still applies; rename is not type-checker-safe.
- **Alias-aware affected-test routing** — `gf_exec({ cmd: "affected-tests" })` now reads `tsconfig.json` / `jsconfig.json` (JSONC: comments and trailing commas allowed) `compilerOptions.baseUrl` + `paths` aliases and resolves them to workspace files; it follows dynamic `import("./x")` and `require("./x")` specifiers; and it recognizes more test conventions (`__tests__/`, `spec/`, `.test.mts`/`.cts`, `*_test.go`, `test_*.py`, `*Tests.cs`) plus `.mts`/`.cts` files. Runner-aware commands are unchanged (`scripts.test` first, vitest when detected, `npm test` for custom runners). Still heuristic (3.3.3 adds `extends` chains, nested configs and project references; see above).

## What's New in 3.3.1

- **Method-aware blast radius** — call sites now carry receiver/member information, so `service.cancelOrder(...)`, `this.cancelOrder(...)`, `Type.cancelOrder(...)` and `Type::cancelOrder(...)` in files that import the owning class are counted (3.3.2 later replaces this blanket importer heuristic with receiver-type inference; see above). Declarations are no longer counted as calls, wildcard imports (`#include`, `import *`) never imply a specific symbol, and language families are never mixed.
- **Rename safety** — `gf_edit({ renameTo })` updates member call sites as well; after the edit it re-analyzes the workspace, and if the old name still appears as a call or identifier it rolls back and returns `REJECTED` with the file list instead of silently breaking callers.
- **Real DSH registration** — `graphflow install` writes the managed Cordis patch at `~/.dsh/cordis.patch.yml` (inserting `@deepseek-ai/dsh-mcp-client`) with `cwd` set to the workspace and `GRAPHFLOW_WORKSPACE_ROOT` in its env. DSH does **not** read `~/.dsh/mcp.json`; that file is now written only as a legacy artifact. See [DeepSeek Harness (DSH)](#deepseek-harness-dsh).
- **Safe uninstall** — `graphflow uninstall` removes only detected agents by default; `--agents <ids>` targets a subset and `--all` cleans every known profile.
- **Python heuristic syntax guard** — `gf_edit` rejects a missing colon on `def`/`class`/compound statements (at bracket depth 0), unbalanced brackets, and unnamed `def`/`class`, without flagging multi-line signatures.
- **Failure source window** — dehydrated `gf_exec` failures now attach source context when an `Error:` line is immediately followed by a stack frame, and for Python tracebacks.
- **Parser/CLI accuracy** — Go and Rust structs report `kind: "struct"`; `graphflow exec --root <dir>` no longer appends the directory value to the command.

## What's New in 3.2.0

### Doc-Graph (`src/doc-graph.ts`)

- **Cross-agent onboarding brief** — persisted in `.graphflow/cross-agent-brief.json`, served as a ~300-token `@brief` target:
  - `gf_read({})` in a fresh session automatically includes architecture hubs, the last agent's modified symbols and test status.
  - `gf_read({ targets: ["@brief"] })` returns the full handoff brief: hubs + modified symbols + test status + linked design docs + compiled macros.
- **Multi-format doc↔code linking** — `.md`, `.html`, `.xml`, `.docx`, `.pdf`, with zero-dependency native zlib parsers:
  - `.docx` parsed via native ZIP Central Directory + `zlib.inflateRawSync` on `word/document.xml` — link a Word design spec section to the symbols it names.
  - `.pdf` parsed via `zlib.inflateSync` on `/FlateDecode` streams + `BT..ET` text extraction — link a PDF interface protocol to the implementing function.
  - PLCopen / config XML sections link to the parser symbols they describe.
- **Interactive knowledge graph** — `graphflow graph` exports `.graphflow/knowledge-graph.html`, a single-file force-directed canvas with search, node filtering, and a click inspector (files, symbols, docs, macros). Since 3.3.2 it carries real `defines` / `imports` / `calls` / `doc-links-code` / `co-edit` edges (see [What's New in 3.3.2](#whats-new-in-332)).

### Bilingual Tokenizer (`src/tokenizer.ts`)

One query engine for Chinese and English code search:

- **Pinyin bidirectional index** — `gf_read({ q: "dingdan chaoshi" })` resolves to `订单超时`; `q: "订单支付"` also emits `dingdan`/`zhifu` to match legacy pinyin-named identifiers such as `handleDingDanZhiFu`.
- **Chinese synonym clusters** — `q: "取消订单"` also matches `作废/撤单/撤销`; `支付 ↔ 付款/收款/结账`, `用户 ↔ 客户/买家/会员/账号`, `校验 ↔ 验证/验签/核对/检查`.
- **Homophone typo correction** — IME typos auto-corrected: `定单钞时取销 → 订单超时取消`, `回掉验千 → 回调验签`, `事物回滚 → 事务回滚`, `登陆帐号 → 登录账号`.
- **English fuzzy matching** — camelCase/snake_case splitting (`resolveEfficiencyPolicy → resolve/efficiency/policy`), stemming, and edit-distance-1 tolerance (`cancle → cancel`, `expried → expired`).

## Benchmarks

| Metric | Baseline | GraphFlow 3.6.0 | Saving |
| :--- | :--- | :--- | :--- |
| MCP tool schema tax / turn | 5897 tokens (2.x, 10 tools) | 458 tokens on the wire (4 tools, ~460) | **−92.2%** |
| Large-file read — skeleton folding | raw file read | 27,926 → 7,840 tokens on `ast-engine.ts` (71.9% smaller; 68–86% across repo files) | **−68% … −86%** |
| Single-symbol read — slice | raw file read | 95.8% smaller on `ast-engine.ts` (27,926 → 1,165 tokens; ~96%) | **~−96%** |
| Passing test-suite output | full log | 1-line `PASS` receipt (5,946 → 30 tokens on the 24-file suite) | **−99.5%** |
| Knowledge-graph build (repo) | — | ≈1,277 nodes / ≈2,750 edges in ≈2.08 s (165 doc links) | — |
| Affected-test routing | — | 26 ms for 1 changed file (16 affected tests) | — |
| Blast radius (repo symbol) | — | 7 ms | — |

**Schema tax detail:** the `tools/list` wire payload is 458 tokens — redundant `$schema` / `title` / `annotations` / `_meta` are stripped from the wire. The programmatic `getV3ToolDefinitions()` keeps those fields for the governance API, so the API view is larger than the wire view.

**Local harness:** after `npm run build`, `npm run bench` (`scripts/benchmark.mjs`) measures MCP schema tax, skeleton/slice compression, PASS/failure dehydration, knowledge-graph build, and affected-test/blast-radius latency, then writes `benchmarks/latest.md` and `benchmarks/latest.json`. The figures above are from the final 3.6.0 benchmark run (unchanged in 3.6.1; timing/count figures are rounded and vary slightly per run); re-run it to reproduce them on your own repo.

## Supported Languages

| Language | Extraction backend |
| :--- | :--- |
| TypeScript / JavaScript | **True AST** (`@babel/parser`) |
| Python | **True AST** via optional `tree-sitter-python` (structural fallback) |
| Go | **True AST** via optional `tree-sitter-go` (structural fallback) |
| Rust | **True AST** via optional `tree-sitter-rust` (structural fallback) |
| C / C++ | **True AST** via optional `tree-sitter-c` / `tree-sitter-cpp` (structural fallback) |
| C# | **True AST** via optional `tree-sitter-c-sharp` (structural fallback) |

The tree-sitter grammars are optional dependencies: when installed, Python/Go/Rust/C/C++/C# get true syntax trees by default; when a grammar is missing (or `GRAPHFLOW_TREE_SITTER=0` is set) the built-in structural analyzer for that language is used instead. tree-sitter is **syntax-only** — it does not perform semantic type resolution, so cross-file receiver/type inference stays heuristic with documented limits (Python import aliases/nested functions, Go grouped params/embedded fields, Rust macros/trait-macro edge cases, C/C++ macros/namespaces, C# properties-as-fields/non-record constructors).

Runtime dependencies: `@babel/parser`, `@modelcontextprotocol/sdk` and `tree-sitter` (required), plus the optional grammar packages `tree-sitter-python` / `-go` / `-rust` / `-c` / `-cpp` / `-c-sharp`. Nothing else runs.

## Quick Start

```bash
# 1) Install globally (Node 18+)
npm install -g @roarpeng/graphflow@3.6.1

# 2) One-click registration into detected agents (MCP + Skill + Rules + Hooks)
graphflow install            # equivalent: npx @roarpeng/graphflow install

# 3) Inspect per-agent registration state
graphflow status

# 4) Launch the MCP server (stdio)
graphflow-mcp
```

Skill-only entry via the [skills.sh](https://skills.sh) ecosystem (installs the agent skill; it then bootstraps the MCP server with `npx @roarpeng/graphflow@latest install`):

```bash
npx skills add Roarpeng/GraphFlow
```

Manual MCP registration for agents that read an `mcpServers` JSON block (for DSH, use the Cordis patch below instead):

```json
{ "mcpServers": { "graphflow": { "command": "graphflow-mcp" } } }
```

Run the test suite from source:

```bash
git clone https://github.com/Roarpeng/GraphFlow && cd GraphFlow
npm install && npm test      # tsx tests/run-all.ts (24 test files, incl. MCP stdio e2e)
npm run build && npm run bench  # optional: local benchmark harness → benchmarks/latest.md
npm run verify:parsers       # optional: true-AST vs forced-structural parser matrix
npm run preflight            # optional: static release checks
```

## VS Code Extension

A thin prebuilt launcher (`roarpeng.graphflow`) with three commands: **Install MCP, Skills & Hooks to Agents**, **Mine Git Co-Change History**, **Show Detected Agents Status**.

- Marketplace: search "GraphFlow" — https://marketplace.visualstudio.com/items?itemName=roarpeng.graphflow
- Open VSX: https://open-vsx.org/extension/roarpeng/graphflow
- Manual VSIX: download `graphflow-<version>.vsix` from https://github.com/Roarpeng/GraphFlow/releases → `code --install-extension graphflow-<version>.vsix`

Full steps: [VSIX-INSTALL.md](./VSIX-INSTALL.md).

## 21-Agent Auto-Installer

`graphflow install` auto-detects installed agents and registers MCP + Skill + Rules + Hooks. Host hooks are merged into existing `PreToolUse`/`PostToolUse` configs (user hooks are preserved; reinstall is idempotent), and `graphflow uninstall` cleanly removes MCP, skills, rules and hooks — only GraphFlow-owned entries, leaving user hooks and other phases intact — for **detected agents** by default; scope it with `--agents <id1,id2>` or clean every known profile with `--all`.

| Group | Agents |
| :--- | :--- |
| IDE / editors | Cursor, VS Code (GitHub Copilot), Windsurf, Trae / Trae CN, Zed |
| Terminal agents | Claude Code, OpenAI Codex, Gemini CLI, Antigravity, Kimi Code, DeepSeek Harness (DSH), OpenCode, ZCode |
| Extension-hosted | Cline, Roo Code, Kilo Code, Continue, PearAI, Qoder / Qoder CN |
| Desktop / cloud | Claude Desktop, Amazon Q |

Scope an install with `graphflow install --agents cursor,claude-code --workspace`.

## DeepSeek Harness (DSH)

DSH does **not** read `~/.dsh/mcp.json`. Its MCP servers are Cordis plugin inserts in `~/.dsh/cordis.patch.yml`. `graphflow install` now writes a managed block there (delimited by `# GRAPHFLOW-DSH-BEGIN` / `# GRAPHFLOW-DSH-END`) and copies the agent skill to `~/.dsh/skills/graphflow/SKILL.md`:

```yaml
# GRAPHFLOW-DSH-BEGIN
- insert:
    - id: mcp-graphflow
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: graphflow
        transport: stdio
        command: npx
        args: ['-y', '--package=@roarpeng/graphflow', 'graphflow-mcp']
        cwd: "C:/path/to/your/workspace"
        env: { GRAPHFLOW_WORKSPACE_ROOT: "C:/path/to/your/workspace", GRAPHFLOW_MCP_STDIO: '1', GRAPHFLOW_LOG_JSON: '1' }
        failOnStartupError: false
# GRAPHFLOW-DSH-END
```

`cwd` matters: without it the MCP child process starts in the DSH profile directory, so `gf_*` calls must pass an explicit `rootDir`. After running `graphflow install` **from your workspace**, `cwd` and `GRAPHFLOW_WORKSPACE_ROOT` are set to that workspace, so relative targets such as `src/app.ts#main` resolve normally. Re-running `install` replaces the managed block in place (including older blocks that used `cwd: !!js process.cwd()`); `graphflow uninstall --agents deepseek-harness` removes it.

`~/.dsh/mcp.json` is still written as a legacy artifact for other tooling, but DSH itself ignores it.

**Bundle alternative.** `@roarpeng/graphflow-dsh` is a configuration-only DSH Cordis bundle (version mirrors the CLI): its `dsh.bundle.patch` inserts the same `mcp-graphflow` stdio row with `cwd` from `GRAPHFLOW_WORKSPACE_ROOT` (falling back to DSH's default working directory) and ships the skill. Install it through DSH's `plugin_manager install_bundle` (or `node scripts/install-dsh-bundle.mjs --print|--stage|--check`) and copy the skill from the bundle/staged dir into `DSH_HOME/skills`. DSH capability matrix: **MCP ✅ · Skill ✅ · Rules ❌ · Hooks ❌** (DSH has no rules-file or host-hook API). Use the bundle **or** `graphflow install --agents deepseek-harness` — both register the same `mcp-graphflow` row, so using both duplicates it.

## CLI Reference

| Command | Purpose |
| :--- | :--- |
| `graphflow install [--workspace] [--agents <id1,id2>]` | Register MCP + Skill + Rules + Hooks in detected agents (merges host hooks; user hooks preserved) |
| `graphflow uninstall [--agents <id1,id2>] [--all]` | Cleanly remove MCP, skills, rules and hooks (GraphFlow-owned hook entries only); default is detected agents only, `--all` cleans every profile |
| `graphflow status [--agents <id1,id2>] [--all]` | List detected agents and per-agent registration state (`[MCP ✓] [Skill ✓] [Rule -] [Hook ✓]`) |
| `graphflow doctor parsers [--strict]` / `graphflow parsers` | Print tree-sitter core/grammar versions, effective default engine and `GRAPHFLOW_TREE_SITTER`; `--strict` exits non-zero when true AST is unavailable |
| `graphflow read [targets...] [-q <query>] [--skeleton] [--dedup]` | Surgical read from the terminal |
| `graphflow edit <file> [--symbol <sym>] [--new <code>] [--rename <name>]` | Surgical edit / rename |
| `graphflow exec [cmd] [--run] [--root <dir>]` | Run `affected-tests` or any command with dehydration (`--run` executes, otherwise preview); `--root` is parsed as a flag and never appended to the command |
| `graphflow macro <list\|run\|save\|mine\|mine-git> [id] [args...]` | Macros and git co-change mining |
| `graphflow task <list\|show\|record\|run\|log\|harvest> [--step <cmd>] [--log <path>] [--args <a>] [--json] [--root <dir>]` | Local task reflection: explicit `record`, or append to `.graphflow/instruction-log.jsonl` with `task log` and promote repeated instructions with incremental `task harvest`; replay offline |
| `graphflow reflect "<instruction>" [args...] [--json] [--root <dir>]` | Run the recorded/near-match task for an instruction locally (MISS when unknown) |
| `graphflow graph` | Export `.graphflow/knowledge-graph.html` |
| `graphflow brief` | Print the cross-agent handoff brief |
| `graphflow hook <pre-tool\|post-tool>` | Host hook interceptor entry (internal) |
| `graphflow version \| help` | Version / usage |

## Docs

- [README.zh.md](./README.zh.md) — Chinese documentation
- [VSIX-INSTALL.md](./VSIX-INSTALL.md) — VS Code extension install guide (EN + 中文)
- [skills/graphflow/SKILL.md](./skills/graphflow/SKILL.md) — agent-facing skill definition
- [Releases](https://github.com/Roarpeng/GraphFlow/releases) · [Issues](https://github.com/Roarpeng/GraphFlow/issues) · [License: Apache-2.0](./LICENSE)
