# GraphFlow 3.0: Token-First Surgical Engine Architecture

> **Design Principle**: Every token consumed by an AI coding agent must directly advance the task. Overhead that does not produce working code — verbose JSON schemas, redundant session echoes, whole-file read slop, multi-round trial-and-error compile errors, and verbose test suite logs — is eliminated by design.

## 1. The Four First-Principles Pillars + Host Hook Guard

GraphFlow 3.0 replaces heuristic prompt-based wrappers with a deterministic, multi-language AST pipeline and transparent host tool interceptors:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AI Coding Agent (Host)                          │
│        (Claude Code, Cursor, DeepSeek Harness, Kimi Code, Windsurf)    │
└──────────────┬───────────────────────────────────────┬─────────────────┘
               │                                       │
   4 Ultra-Lean MCP Tools (~444 Tokens)      Host PreToolUse / PostToolUse
  ┌────────────┼────────────┬────────────┐   Interceptor (host-interceptor.ts)
  │  gf_read   │  gf_edit   │  gf_exec   │   - Auto-folds raw Read (>250L)
  │            │            │  gf_macro  │   - Auto-dehydrates raw Bash logs
  └──────┬─────┴──────┬─────┴──────┬─────┘   - Enforces post-edit AST guard
         ▼            ▼            ▼
  [Multi-Language Surgical AST Engine: TS/JS · Python · C/C++ · C# · Rust · Go]
```

## 2. Pillar 1: Precise Context Slicing (`gf_read`) Across 6 Language Families

* **First-Class Multi-Language AST Analyzers (`src/v3/ast-engine.ts`)**:
  * **TypeScript / JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`)**: `@babel/parser` AST extraction.
  * **Python (`.py`, `.pyi`)**: Indentation-scoped `def` / `async def` / `class` extraction, `@decorator` span inclusion, `self`/`cls`-normalized parameter counting, and Pythonic skeleton folding (`...  # [lines X-Y folded]`).
  * **Go (`.go`)**: Receiver methods, exported/unexported functions, `struct`/`interface` definitions, and same-package + imported call-site tracking.
  * **Rust (`.rs`)**: `pub fn`, `impl` blocks, `struct`/`enum`/`trait` declarations, `&self`-normalized arity counting, and `use crate::...` resolution.
  * **C / C++ (`.c`, `.h`, `.cc`, `.cpp`, `.hpp`, `.cxx`, `.hxx`)**: Function/method definitions, `class`/`struct`/`enum` declarations, and `#include` header type closure.
  * **C# (`.cs`)**: `namespace`, `class`/`interface`/`struct`/`record`/`enum` declarations, and method signature/call extraction.
* **Cross-File Type-Closure Resolution**: Automatically includes referenced `interface`/`type`/`struct`/`dataclass`/`record`/`enum` definitions from the same file, explicit imports, or same-package/header files.

## 3. Pillar 2: Surgical Modification, Batch Atomic Edits & Static Guard (`gf_edit`)

* **Cross-Repo Blast Radius Localization**: Attaches 3-line call-site micro-snippets (`[Blast Radius]`) with exact 1-based line numbers across the repository.
* **Bottom-Up Batch Atomic Multi-Edit (`edits: [...]`)**: Groups edits by file and sorts them in descending line order (`b.startLine - a.startLine`), eliminating line-number drift when updating multiple call sites or symbols in one turn.
* **Zero-LLM Instant Static Guard**: Validates AST syntax and brace/indentation balance before committing to disk (with automatic rollback on syntax error) and checks caller argument count (arity) against updated signatures.

## 4. Pillar 3: Deterministic Tool Execution (`gf_exec` & `renameTo`)

* **Zero-LLM Cross-Repo Symbol Rename (`gf_edit(renameTo="...")`)**: Renames a symbol across its declaration, imports, and call sites repository-wide with word-boundary precision and full AST verification.
* **Multi-Language Diff-to-Test Impact Router**: Traces 2-hop reverse imports from `git diff` to locate affected test files (`*.test.ts`, `test_*.py`, `*_test.go`, `*_test.rs`, `*Tests.cs`) in <15ms.
* **Terminal Output Dehydrator**: Collapses passing runs to a 1-line `PASS` receipt (~28 tokens) and strips framework stack frames on failure while inlining the 5-line source window around each error location.

## 5. Pillar 4: Habit Memory, Parameterized Macros & Host Hook Interceptor

* **Habit Memory (`src/v3/macro-engine.ts`)**:
  * **Parameterized Command Templates (`command-template`)**: Automatically generalizes recurring commands that differ only by file/target argument into `{{arg1}}` macros.
  * **Co-Edit File Pairs (`coEdits`)**: Learns files frequently modified together and warns when only one side of a pair is edited.
  * **Directory Auto-Verify Hooks (`dirVerifyCommands`)**: Learns the user's preferred verification command per directory prefix and runs it automatically after `gf_edit`.
* **Host `PreToolUse` / `PostToolUse` Token-Guard Interceptor (`src/v3/host-interceptor.ts`)**:
  * Intercepts unscoped native `Read` calls on files >250 lines and substitutes the AST Skeleton Folded view (-75% to -93% tokens).
  * Intercepts verbose native `Bash` outputs, dehydrating logs and recording commands into `.graphflow/trajectories.jsonl`.
