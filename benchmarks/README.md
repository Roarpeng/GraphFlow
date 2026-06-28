# GraphFlow Token-Savings Benchmark

A reproducible benchmark that measures how many LLM **input tokens** GraphFlow
saves versus the traditional "grep the repo and read whole files into the
prompt" workflow that a context-less coding agent uses.

## Why this exists

GraphFlow's headline claim is large context-token savings. This benchmark turns
that claim into an **independently reproducible number**: same tokenizer for both
sides, no API key, no network, deterministic graph build.

## One-command reproduce

```bash
npm install
npm run benchmark
```

That runs `benchmarks/run-token-benchmark.ts` with `tsx` (same toolchain as the
`start` script) and:

1. Writes an isolated, offline benchmark config to `benchmarks/.cache/`
   (network embeddings + LLM semantic enrichment disabled; only zero-cost
   graph-structure compression stays on).
2. Indexes this repository into a dedicated graph under `benchmarks/.cache/`
   (AST-only — no API cost).
3. For each representative query:
   - **Baseline:** greps `src/`, ranks files by query-term hits, reads the top
     N files in full, and counts their tokens with `gpt-tokenizer`.
   - **GraphFlow:** calls `previewContext` and uses its compressed
     `tokenEstimate`, cross-checked by re-tokenizing the summary + anchors.
4. Prints a per-query table to the console and writes `benchmarks/RESULTS.md`.

## Prerequisites

- Node + the repo's dev dependencies installed (`npm install`). `tsx` and
  `gpt-tokenizer` are already dependencies — nothing else is required.
- No API keys. The run is fully local and deterministic.

## Output

- Console: per-query and total token counts + savings %.
- `benchmarks/RESULTS.md`: Markdown table, totals, run environment, and an
  honest description of the baseline assumptions (file cap, scan scope, etc.).

## Honesty notes

The baseline is a **simulation** of a typical agent, not a recording of one
specific tool. It caps files-read-per-query (see `BASELINE_MAX_FILES_PER_QUERY`
in the runner) to stay bounded and reproducible; a higher cap would only
increase reported savings, so the cap is conservative. See the "Methodology &
honest caveats" section of `RESULTS.md` for the full breakdown.
