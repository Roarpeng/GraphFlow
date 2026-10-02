# ADR-0005: Benchmark honesty rules

- Status: Accepted
- Date: 2026-10-01
- Spec: §18 (benchmark tracks), §19 (CI gates), §11 (measurement provenance)

## Context

An efficiency layer is only worth its cost if it measurably saves tokens, time or rounds
**without** lowering success. Such claims are easy to inflate: synthetic durations, success
inferred from "the agent said done", tasks whose tests the agent can read and overfit, or
quietly dropping tasks that could not be judged. Earlier internal runs also showed how a
gating bug can masquerade as a win (49/50 ADAPT verdicts from an outcome-score gate).

## Decision

The benchmark (`src/bench-runner.ts`, `src/bench.ts`, `src/bench-compare.ts`, `src/corpus.ts`,
`benchmarks/golden-v1.jsonl`) follows these rules:

1. **Pinned base commits**: every task carries a `baseCommit`; the golden gate (`scripts/check-golden.mjs`) verifies that every referenced commit resolves.
2. **One git worktree per task**: each run starts from a clean worktree at its base revision, so arms and tasks cannot contaminate each other. Arm flags are forced inside the worktree (ADR-0003).
3. **Oracle-judged success only**: a task passes only when its oracle (`outputAnyOf` / `outputAllOf` / validation commands) passes. The agent's own claim of success is never counted.
4. **Hidden tests overlaid after the agent finishes**: oracle test files (`oracle.overlayFrom` commit + paths) are copied into the worktree only after the run, so the agent cannot read or tailor them.
5. **Unjudged tasks never enter success rates**: a task without an oracle, or whose premise depends on runtime configuration, is executed and reported as `unjudged` but excluded from numerators and denominators.
6. **Regression guards feed `regressionRate`**: tasks that passed in the baseline and fail in the candidate are counted and reported, never netted away against improvements.
7. **No synthetic numbers**: durations, token counts and outcomes come from real runs, with provenance (`measured` / `estimated` / `proxy`, `src/measurement.ts`). Aggregates inherit the weakest provenance. A trace with provenance violations is disqualified from A/B comparison (`validateTraceProvenance`).

Scope today: Golden-v1, 50 tasks (20 repetition / 15 regular / 10 complex / 5 deliberate
failure); Golden-Extended, 200 generated tasks in 15 families (`scripts/gen-extended.mjs`,
reproducibility checked by `--check`; 5 unjudged); Long-Horizon, 20 sessions / 125 steps that
share one worktree per session and carry per-step reuse expectations (fresh / reuse-allowed /
must-refresh). Rules 1–7 apply to all three; for Long-Horizon, rule 2 is per session rather
than per step. The extended datasets have only been validated and smoke-run with a no-op
agent; no live result exists for them, and none may be reported as if it did.

A model-level A/B (`benchmarks/run-real-ab.ts`: the same DeepSeek model answering with a
grep baseline vs. GraphFlow-compressed context) measures input tokens and answer presence,
not oracle-judged task success. It is reported under that name and never as a Golden result.

## Consequences

- Positive: a published comparison (`eff-agent bench compare`) is reproducible from the pinned corpus plus the run JSONL.
- Negative: live runs are slow and need a real agent CLI, so the CI `golden-live` job is opt-in (workflow input or `EFF_AGENT_CLI` repository variable). Until a live run is published, the package claims no efficiency numbers.
- Negative: oracle authoring is the bottleneck; tasks without a trustworthy oracle stay unjudged instead of being given a weak one.
