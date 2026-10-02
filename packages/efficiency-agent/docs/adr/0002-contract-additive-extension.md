# ADR-0002: Execution Contract v1 extends the substrate advisory additively

- Status: Accepted
- Date: 2026-10-01
- Spec: §2 (Execution Contract), §5 (fingerprint), §21, §24

## Context

The spec describes an Execution Contract with reshaped objects, for example a `reuse{}` object
(mode, evidence, confidence) and a `validation{}` object (commands, required, evidence). The
substrate already ships an earlier shape: `graphflow_run` returns an `advisory` block with a flat
`reuseMode` and `validation: string[]` (`src/core/efficiency-advisory.ts`), and hosts and
benchmarks already parse it. Reshaping would break every existing consumer and would leave
two incompatible "v1" documents.

## Decision

`ExecutionContractV1` (`src/contract.ts`, `schemas/execution-contract-v1.schema.json`) is a
**superset** of the substrate advisory:

- **Kept as-is**: `schemaVersion: "1.0"`, `taskId`, `mode`, `reuseMode`, `confidence`, `signals`, `context{source, requiredAnchors, maxTokens?, cached?}`, `worker{modelTier, executionMode, maxRounds}`, `validation: string[]`, `decision{provenance, llmCalls, durationMs}`, and the optional `project{root, gitHead?}`, `experience{episodes, topSimilarity?}`, `tools[]`, `policyApplied`.
- **Added as optional fields** (instead of reshaping):
  - `decisionId` — the replay/rollback key
  - `reuseEvidence[]`
  - `budget{maxInputTokens, maxOutputTokens, maxToolCalls, maxRounds, maxWallMs}`
  - `permissions{read, write, network}`
  - `worker.provider`
  - `project.workingTreeHash`, `project.graphVersion`, `project.toolchainHash`
  - `experience.skills`, `experience.avoidPatterns`
  - `tools[].risk`
  - `validationPolicy{required, evidenceRequired}`
- **Compatibility is executable**: `assertAdvisoryCompatible()` validates both the substrate advisory and the agent's own contract (the pipeline calls it on every contract it emits). `tests/graphflow-compat.test.ts` builds real substrate advisories with `buildEfficiencyAdvisory` and requires zero violations.
- Invariant: `decision.provenance === "deterministic"` ⇒ `decision.llmCalls === 0`.

## Consequences

- Positive: every `graphflow_run` advisory is a valid contract today; no consumer migration is needed.
- Positive: new needs keep landing as optional fields under the same `schemaVersion: "1.0"`, which matches the substrate version policy (frozen surfaces change only additively).
- Negative: the spec's grouping (`reuse{}`, `validation{}`) exists only implicitly: reuse is spread over `reuseMode` + `confidence` + `reuseEvidence`, and validation over `validation` + `validationPolicy`. The docs map the spec names to these fields.
- A real reshape, if ever needed, means `schemaVersion: "2.0"`, a deprecation window of one minor release, and a major bump of the substrate surface S3.
