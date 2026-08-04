# GraphFlow Public Benchmark Suite

A third-party reproducible benchmark suite for GraphFlow. Every benchmark is
**offline, deterministic, API-key free**, pinned to a git commit in its
machine-readable output, and runnable with a single command.

> **Self-test disclaimer:** the numbers quoted below are project self-test
> results (run by the authors, not independently verified). Please reproduce
> them yourself with the commands below and compare — that is exactly what
> this suite exists for. Full methodology (inputs, judgment criteria, honest
> caveats) is standardized in [`docs/benchmark-standards.md`](../docs/benchmark-standards.md).

## One-command reproduce

```bash
git clone https://github.com/Roarpeng/GraphFlow.git && cd GraphFlow
git checkout <pinned-commit-or-tag>   # pin the exact source state
npm ci                                # Node >= 20, npm >= 10
npm run bench:all                     # run everything below in sequence
```

| Command | Benchmark | Runner | Machine-readable JSON |
| --- | --- | --- | --- |
| `npm run bench:retrieval` | Retrieval golden set (fastest, ~2s) | `run-retrieval-eval.ts` | `.cache/retrieval-eval-results.json` |
| `npm run bench:token` | Token savings | `run-token-benchmark.ts` | `.cache/token-bench-results.json` |
| `npm run bench:skill-ab` | Skill flywheel A/B (injection + end-to-end P1-2) | `run-skill-ab-benchmark.ts` + `run-skill-ab.ts` | `.cache/skill-injection-results.json`, `.cache/skill-ab-results.json` |
| `npm run bench:memory` | Episodic-memory A/B (P3) | `run-memory-ab.ts` | `.cache/memory-ab-results.json` |

All JSON artifacts are written under `benchmarks/.cache/` (gitignored) and
carry a standard reproducibility envelope: `schemaVersion`, `benchmark`,
`generatedAt` (ISO-8601), `commit` (`git rev-parse HEAD`), and `environment`
(Node version + platform).

## Benchmarks

### 1. Retrieval golden set — `npm run bench:retrieval`

Evaluates GraphFlow's graph retrieval against **132 golden queries** (shared
with the regression suite `tests/retrieval-golden.test.ts`) plus 12 negative
(decoy-bleed) samples, on an in-memory graph built from this repo's `src/`.
Metrics: Hit-rate@1/3/5/10, MRR, NDCG@5/10, per-domain breakdown.

Self-test result (see `RETRIEVAL-EVAL-RESULTS.md`): **Hit-rate@5 = 100.0%**,
MRR = 0.836, NDCG@5 = 0.671, negative-sample precision = 100%.

### 2. Token savings — `npm run bench:token`

Compares GraphFlow's compressed context (summary + anchors) against a
simulated context-less agent (grep + read top-10 files in full), counting
tokens on both sides with `gpt-tokenizer` (gpt-4o encoding). 8 fixed golden
queries over this repo's `src/`.

Self-test result: **98.2% total savings** (baseline 274,434 → GraphFlow 4,928
tokens, 2026-08-04). Historical runs: 98.9% (2026-08-02), 98.7% (2026-07-28) —
the corpus is this repo itself, so numbers drift with `src/`; compare only
same-`commit` runs.

### 3. Skill flywheel A/B — `npm run bench:skill-ab`

Two tiers: injection/recall/overhead on 8 fixture tasks, and an end-to-end
success proxy (P1-2) on the 26 retrieval-golden queries with seeded
in-memory graphs, Arm A (flywheel ON) vs Arm B (OFF).

Self-test result (P1-2): **ON 100.0% vs OFF 61.5%** success proxy (26 tasks,
rescued=10, hurt=0, overhead 33.2 tok/task).

### 4. Episodic-memory A/B — `npm run bench:memory`

P3 extension of the A/B framework: 62 tasks (26 golden + 36 HARD tasks whose
golden nodes share **zero tokens** with the query, so pure retrieval cannot
win) with a full attribution chain per rescued task.

Self-test result: **ON 100.0% vs OFF 56.5%** (rescued=27, hurt=0, overhead
70.9 tok/task).

## Environment

- **Node >= 20** (validated on v22; win32/linux x64), **npm >= 10**.
- **Fully offline**: no network, no API keys. LLM/embedding steps are
  disabled or replaced by deterministic hashing.
- `git` on PATH for commit anchoring (falls back to `$GITHUB_SHA`, then
  `"unknown"` if absent).
- Linux / macOS / Windows all supported; no platform-specific calls.

## Commit anchoring

Every result JSON records the commit it ran against (`commit` field). The
token benchmark's corpus is the working tree (`src/`), so **uncommitted
changes alter results** — always compare runs at identical commits. When in
doubt, trust the JSON envelope over any quoted number.

## How to reproduce independently and report

1. Clone and `git checkout` a pinned commit/tag (e.g. a release tag).
2. `npm ci`, then run `npm run bench:all` (or any individual command).
3. Verify: each command exits 0; every JSON under `benchmarks/.cache/`
   contains `commit` + `generatedAt`; your numbers match the ones in the
   `*-RESULTS.md` files for the same commit.
4. Compare your totals against the self-test numbers above (and against
   `docs/benchmark-standards.md` §0). Same commit → identical numbers
   expected; cross-commit differences are corpus drift, not failures.
5. **Report:** open a GitHub issue titled
   `[benchmark] Independent reproduction — <commit>` containing: your commit
   hash, Node version/OS, the result JSON files (attach or paste key
   numbers), and any deviation you observed. Deviations at the same commit
   are valuable findings — please report them.

## Outputs

- Human-readable: `RESULTS.md`, `RETRIEVAL-EVAL-RESULTS.md`,
  `SKILL-AB-RESULTS.md` (regenerated by the runners; tracked).
- Machine-readable: `benchmarks/.cache/*.json` (gitignored; archive these for
  third-party reporting).
