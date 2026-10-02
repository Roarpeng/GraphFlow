# Efficiency Agent — Architecture Map

This document maps every section of the Efficiency Agent implementation spec to the
modules that implement it in `packages/efficiency-agent`. Each row carries an honest status:

- **Implemented** — code and tests exist and are wired into `eff-agent run` / `bench`.
- **Partial** — the core exists, but a spec requirement is missing or only a target; the reason is stated.
- **Not implemented** — nothing ships yet.

Paths are relative to `packages/efficiency-agent/` unless they start with `/` (repo root).

## End-to-end flow

```text
eff-agent run <task>                                   bin/eff-agent.ts
  └─ runPipeline                                       src/agent/pipeline.ts
       flags → effective mode                          src/flags.ts
       classify task category                          src/agent/classify.ts
       project facts (git, files, lockfile)            src/host/project-facts.ts → src/project/facts.ts
       four-track fingerprint                          src/fingerprint.ts
       project twin                                    src/project-twin.ts
       GraphFlow context (MCP stdio)                   src/host/graphflow-mcp-client.ts
       experience search                               src/agent/experience.ts
       cache lookups (context / plan / result)         src/caches/*.ts (namespaced: caches/namespace.ts)
       reuse gate                                      src/reuse-gate.ts
       security gate (capabilities, risk, policy)      src/agent/security-*.ts → src/security/*.ts
       tool routing                                    src/tools/{capability-registry,tool-router}.ts
       model routing + cost                            src/cost/*.ts, learned policy
       Execution Contract v1 (+ assertAdvisoryCompatible)  src/contract.ts
       dynamic harness / broker                        src/dynamic-harness.ts, src/broker.ts
       worker execute + validate + replan              src/workers/*.ts
       post-run write audit                            src/security/policy.ts (auditWorkspaceWrites)
       experience + policy learning                    src/learning/*.ts, src/self-optimize/*.ts
       trace (redacted) + events                       src/trace.ts, src/observability/*.ts
```

GraphFlow is consumed only through MCP and public files; see
[GRAPHFLOW_COMPATIBILITY.md](GRAPHFLOW_COMPATIBILITY.md).

## Spec section → module map

| § | Topic | Modules / files | Status |
|---|-------|-----------------|--------|
| 1 | Boundary: consume GraphFlow via MCP/API, never copy its algorithms | `src/host/graphflow-mcp-client.ts`, `src/host/project-facts.ts` (`graphArtifactVersion`, metadata only), `docs/GRAPHFLOW_COMPATIBILITY.md`, `tests/graphflow-compat.test.ts` | **Implemented**. Runtime code imports nothing from root `src/`; only the compat test does, by design. |
| 2 | Execution Contract | `src/contract.ts` (`ExecutionContractV1`, `assertAdvisoryCompatible`), `schemas/execution-contract-v1.schema.json`; substrate producer `/src/core/efficiency-advisory.ts` | **Implemented**. Additive-extension shape per [ADR-0002](adr/0002-contract-additive-extension.md). |
| 3 | Reuse Gate state machine | `src/reuse-gate.ts` (REUSE/ADAPT/FRESH ladder), `src/trace.ts` (`TraceEvent`: stage, outcome, reason, evidence, policyVersion), `src/observability/events.ts` | **Implemented**. Every transition is recorded with reason + evidence + policyVersion. REUSE requires a result hit **and** a result-safe category. |
| 4 | Three caches + invalidation | `src/caches/context-cache.ts` (TTL + full fingerprint), `src/caches/plan-cache.ts` (project-track state validation), `src/caches/result-cache.ts` (result-safe categories only; write categories refused at `put`), `src/caches/namespace.ts` (generation bump = cache rollback), store `src/host/file-kv-store.ts` | **Implemented**. Miss reasons, generation-bump invalidation and fingerprint drift (validation commands and executor args are part of the environment track) are covered by `tests/cache-invalidation.test.ts`. Context cache TTL 24 h (`CONTEXT_TTL_MS`); result cache TTL 6 h (`DEFAULT_RESULT_TTL_MS`, miss reason `ttl-expired`, checked after the fingerprint). Results replay without execution or validation, so their staleness budget is tighter: the fingerprint covers repo state but not installed tools, remote docs or the agent's model. Hosts override both via `PipelineDeps.cacheTtlMs = { context?, result? }`. |
| 5 | Task fingerprint | `src/fingerprint.ts` (semantic / project / context / environment tracks), `schemas/task-fingerprint-v1.schema.json`; facts from `src/host/project-facts.ts` (gitHead, working-tree hash, relevant-file hashes incl. GraphFlow anchor files, lockfile hash) | **Implemented**. The context track uses the GraphFlow artifact size+mtime (`graphVersion`, experimental surface S6). |
| 6 | Security | `src/security/policy.ts` (policy load, write containment, protected paths, porcelain write audit, cache admission), `src/security/redact.ts`, `src/security/untrusted.ts`, `src/agent/security-adapter.ts`, `src/agent/security-default.ts`, `policies/default-policy-v1.json`, `schemas/policy-v1.schema.json`, `security/adversarial-v1.jsonl` (51 cases, `tests/security-adversarial.test.ts`) | **Partial**. Enforced for what eff-agent launches (pre-run command + worker-launch check, `--approve` for approval-required, post-run write audit → `violation`, redacted output/trace, untrusted-content wrapping, cache admission); the external agent CLI's internal tool use cannot be sandboxed by eff-agent ([ADR-0004](adr/0004-security-model.md)). The post-run audit compares workspace snapshots (`src/host/workspace-snapshot.ts`, `src/security/write-audit.ts`): `git status --porcelain=v1 --untracked-files=all --ignored=matching` plus content signatures (sha256 ≤ 2 MiB, else size+mtime) of up to 2000 pre-dirty and 256 ignored files (64 MiB hash budget). It detects re-modified pre-dirty files (`rewrittenDirty`), git-ignored writes (`ignoredChanged`; ignored directories compared as single entries, never walked) and writes outside the workspace root (`outsideRoot`; porcelain paths re-based with `rev-parse --show-prefix`); declared write scopes outside the root are denied before execution (`tests/security-write-audit.test.ts`). Not covered: writes outside the git repository, writes inside ignored directories, attribution between the agent, validation commands and concurrent editors. |
| 7 | Capabilities | `src/security/capabilities.ts`, `policies/capabilities-v1.json`; tool cards `src/tools/capability-registry.ts`, `schemas/tool-capability-v1.schema.json`; GraphFlow MCP tools carry `_meta["graphflow/capabilities"]` in the same vocabulary | **Implemented**. |
| 8 | Risk classes R0–R5 | `src/security/risk.ts` (`classifyCommand`, `maxRisk`), `policies/risk-classes-v1.json` (R0 read-only, R1 bounded-local, R2 external side effect, R3 secret/escape, R4 destructive, R5 agent-spawn); `TraceSecurityDecision.risk` in `src/trace.ts`; `_meta["graphflow/risk"]` on MCP tools | **Implemented**. |
| 9 | Fail-open / fail-closed | Fail-open: `src/agent/pipeline.ts` (GraphFlow down → twin-only context; no history → FRESH; agent throws → native baseline rerun, `failOpen.reason`). Fail-closed: `src/agent/security-default.ts` + `loadSecurityPolicy` (corrupt/invalid policy → STRICT) | **Implemented**. |
| 10 | Performance budgets | `src/dynamic-harness.ts` (per-tier budget caps: rounds, wall time), `ExecutionContractV1.budget`, release-gate `perf` step (`tests/perf-budget.test.ts`) | **Met with a resident server; not from a cold process**. Measured on this repo (Windows, 9.7k nodes / 52k edges, P50 of 5–7 fresh `eff-agent run --mode shadow` processes, unique tasks so the context cache misses): published 2.0.3 launcher spawned per process **5.3 s**; this checkout's MCP server spawned per process **4.6 s**; resident `graphflow-mcp --http` via `EFF_GRAPHFLOW_MCP=http://127.0.0.1:PORT/mcp` **1.35 s** (< 1.5 s). A cold server cannot reach the target: node + module load ≈ 1 s, store open ≈ 0.1–0.6 s, ONNX embedding model ≈ 1.7 s, tokenizer ≈ 0.3 s, then the preview. A warm in-process preview went from 1.0–1.3 s to 0.57–0.65 s (SQLite snapshot metadata parsed on access instead of ~8×90 ms per preview). Repeated tasks hit the project-state-bound context cache. Without GraphFlow (`tests/perf-budget.test.ts`): cache lookups P95 ≈ 0.1 ms, advisory decision P50 ≈ 0.7 ms (fixture facts) / ≈ 0.6 s (real git facts). |
| 11 | Observability | `src/trace.ts` + `schemas/trace-v1.schema.json` (TaskTrace v1, provenance-checked), `src/measurement.ts` (measured/estimated/proxy), `src/observability/events.ts`, `src/observability/otel.ts` (OTLP/JSON spans, no network exporter), `src/observability/replay.ts` (`renderReplay`, `replayProblems`) | **Implemented**. Export is to file/JSON; shipping to a collector is the operator's job. |
| 12 | Telemetry privacy | `src/security/redact.ts` (traces, history, lessons, cache output), `src/observability/otel.ts` (task text and high-cardinality ids opt-in; evidence exported as counts) | **Implemented**. Nothing is sent off-machine by eff-agent. |
| 13 | Project Twin provenance | `src/project-twin.ts` (pure twin), `src/project/facts.ts` (facts with source, provenance, observedAt, trust, hash; real build/test observations override), `src/host/project-facts.ts` (collection) | **Implemented**. `knownIssues` / `preferredTools` are left empty in v0 instead of being guessed. |
| 14 | Tool intelligence | `src/tools/capability-registry.ts` (ranking by measured success → latency → cost → name), `src/tools/tool-router.ts`, persisted history `graphflow-out/eff-agent/tools.json` | **Implemented**. Gated by `EFF_TOOL_ROUTING`. |
| 15 | Self-learning loop | `src/learning/trajectory.ts`, `policy-learner.ts`, `policy-store.ts`, `policy-from-ledger.ts` (substrate ledger → `efficiency-policy.json`), `policy-lifecycle.ts` (evidence gate → candidate → shadow → canary → production, with rollback), `src/self-optimize/{reflection,loop}.ts`, `src/agent/experience.ts` | **Partial**. The loop is implemented, but `EFF_SELF_LEARNING=0` by default (candidates are proposed, not applied). Ledger-derived trajectories treat success as neutral because the ledger has no outcomes yet (documented in `policy-from-ledger.ts`). |
| 16 | Dynamic harness | `src/dynamic-harness.ts` (trivial / simple / medium / complex tiers, budgets, stop conditions, disposable resources), `src/broker.ts` (gate order: validation pass → rounds exhausted → budget) | **Partial**. Implemented, but `EFF_DYNAMIC_HARNESS=0` by default; the complex tier's dynamic sub-agents are bounded by `EFF_SUBAGENT=0`. |
| 17 | Five quality layers | Mapped by function: (1) contract/schema validity — `src/contract.ts`, `schemas/*`; (2) execution validation — `src/broker.ts`, validation commands in the contract, `src/workers/*`; (3) write/security audit — `src/security/policy.ts`; (4) oracle judgment — `src/bench-runner.ts`; (5) regression/golden gates — `scripts/release-gate.mjs`, `scripts/check-golden.mjs` | **Partial**. All five checks exist, but there is no single quality-layer module, and the golden live run is opt-in (needs a CLI). |
| 18 | Four benchmark tracks | `src/bench-runner.ts` (arms: A `baseline`, B `graphflow`, C `shadow`, D `adaptive`, plus `conservative`; per-task git worktree, oracle judge), `src/bench.ts`, `src/bench-compare.ts` (A/B compare, `regressionRate`), `src/corpus.ts` (composition gate), `benchmarks/golden-v1.jsonl` (50 tasks: 20 repetition / 15 regular / 10 complex / 5 failure), `src/flags.ts` `benchArmFlags` , `benchmarks/golden-extended-v1.jsonl` (200 tasks, 15 families, generated by `scripts/gen-extended.mjs`), `benchmarks/long-horizon-v1.jsonl` (20 sessions / 125 steps, run in ONE worktree per session with reuse expectations) | **Datasets implemented; no agent A/B yet**. All three datasets validate against their schemas and the git-backed checks (`check-golden.mjs --dataset all`: 84 commits, 0 errors; `gen-extended.mjs --check` reproducible), both in the release gate's `golden` step on every push. Nightly live runs (`datasets-nightly` job) need an agent CLI (`EFF_AGENT_CLI`) and have not run. No agent-level A/B numbers yet; the model-level DeepSeek A/B in `benchmarks/run-real-ab.ts` is a different measurement ([ADR-0005](adr/0005-benchmark-honesty.md)). |
| 19 | CI gates | `/.github/workflows/efficiency-agent.yml` (ubuntu + windows gate matrix, provenance job, opt-in golden-live, nightly `datasets-nightly` matrix over Golden-Extended / Long-Horizon), `scripts/release-gate.mjs` (code, contract, security, cache, golden, chaos, perf, package), `scripts/check-golden.mjs`, `scripts/secret-scan.mjs` | **Partial**. All eight gates pass locally (`node scripts/release-gate.mjs`); a missing gate test counts as a **FAIL** by design. The GitHub workflow (including the SLSA provenance and opt-in golden-live jobs) has not run on GitHub yet. |
| 20 | Supply chain | `scripts/supply-chain.mjs` (npm pack, `SHA256SUMS`, CycloneDX SBOM, `provenance.json`), `scripts/secret-scan.mjs`, SLSA attestation step in the workflow; outputs in `artifacts/` | **Implemented**. Signing happens only in CI (`id-token: write`); local runs produce unsigned artifacts. |
| 21 | MCP | Consumer: `src/host/graphflow-mcp-client.ts`. Substrate side: `/src/surfaces/mcp/server.ts` (stable identity `graphflow` + `package.json` version), `/src/surfaces/mcp/tool-definitions.ts` (per-tool `annotations` + `_meta` risk/capabilities), `/tests/mcp-tool-annotations.test.ts` | **Partial**. GraphFlow tools declare capability + permission + risk. eff-agent does **not** expose its own MCP server yet (CLI only), and does not yet use the substrate annotations to gate its own calls. |
| 22 | Feature flags | `src/flags.ts` (defaults, file `graphflow-out/eff-agent/flags.json`, env precedence, `effectiveMode`, `benchArmFlags`); security flags applied in `src/security/policy.ts` (`applySecurityEnvFlags`) | **Implemented** ([ADR-0003](adr/0003-feature-flags.md)). CLI: `eff-agent flags [get]`, `flags set NAME=VALUE…`, `flags rollback` (writes `EFF_AGENT_ENABLED=0`). |
| 23 | Modes | `src/flags.ts` `RequestedMode` (`advisory`, `shadow`, `baseline`, `conservative`, `adaptive`), `src/agent/pipeline.ts` arms, `bin/eff-agent.ts --mode/--policy` | **Implemented**. |
| 24 | Rollback | One switch: `EFF_AGENT_ENABLED=0` / `EFF_SHADOW_MODE=1` → shadow (`src/flags.ts`). Caches: generation bump (`src/caches/namespace.ts`). Policy: `src/learning/policy-lifecycle.ts` rollback. CLI: `eff-agent flags rollback`, `cache invalidate`, `policy status|rollback`, `trace replay [--id] [--otel-out]`. Replay keys: `src/version.ts` + `TraceDecisionRecord` (decisionId, policyVersion, contract/context-policy versions) | **Implemented**. |
| 25 | Directory layout | See below. | **Implemented** (with a deliberate mapping). |

## §25 Directory layout: spec names vs. this package

The package follows the spec's layering, but some directory names follow the codebase
conventions that existed before the spec was written. The mapping is deliberate:

| Spec directory | Package location | Why |
|----------------|------------------|-----|
| `reuse/` | `src/caches/` + `src/reuse-gate.ts` | Each cache is its own module with its own miss reasons; the gate that merges cache verdicts is a single pure function at the top level. |
| `context/`, `project/` adapters, process runner | `src/host/` (`graphflow-mcp-client.ts`, `project-facts.ts`, `spawn-command.ts`, `file-kv-store.ts`) | `host/` holds every platform side effect (MCP child process, git, filesystem, process spawn) behind small adapters, so all other modules stay pure and testable with fakes. |
| `project/` (twin + facts) | `src/project-twin.ts` (pure twin), `src/project/facts.ts` (provenance shaping) | Collection is in `host/`, shaping in `project/`, the twin stays a pure function. |
| `contract/` | `src/contract.ts` + `schemas/execution-contract-v1.schema.json` | One normative type + one JSON Schema; no directory needed. |
| `security/` | `src/security/` + `src/agent/security-{adapter,default}.ts` + `policies/` | The pipeline only talks to the adapter seam; policy data is JSON so it can be versioned and audited. |
| `tools/` | `src/tools/` | Same name. |
| `learning/` | `src/learning/` + `src/self-optimize/` + `src/agent/experience.ts` | Reflection/self-optimize predates the lifecycle module and stays separate. |
| `harness/`, `broker/` | `src/dynamic-harness.ts`, `src/broker.ts` | Single modules each. |
| `workers/` | `src/workers/` (`local-command`, `external-cli`, `agent-task`, `typesafe-jev`) | Same name. |
| `observability/` | `src/trace.ts`, `src/measurement.ts`, `src/observability/` | Trace + measurement contracts are top-level because benchmarks and the contract share them. |
| `cost/` | `src/cost/` | Same name. |
| `benchmark/` | `src/bench.ts`, `src/bench-runner.ts`, `src/corpus.ts`, `benchmarks/golden-v1.jsonl` | Code in `src/`, data in `benchmarks/`. |
| `cli/` | `bin/eff-agent.ts` | npm `bin` convention. |
| `schemas/`, `policies/`, `scripts/`, `docs/` | same names | — |

Runtime state lives under the **workspace's** `graphflow-out/eff-agent/` (`cache.json`,
`tools.json`, `policy.json`, `history.jsonl`, `flags.json`) and benchmark output under
`graphflow-out/eff-bench/`. Both are excluded from the project fingerprint and from the
post-run write audit (`SELF_WRITTEN` in `src/agent/security-default.ts`).

## Decisions

- [ADR-0001](adr/0001-monorepo-package.md) — independent workspace package in this repository
- [ADR-0002](adr/0002-contract-additive-extension.md) — Execution Contract v1 extends additively
- [ADR-0003](adr/0003-feature-flags.md) — feature flags, precedence and the rollback switch
- [ADR-0004](adr/0004-security-model.md) — security model: what is and is not enforced
- [ADR-0005](adr/0005-benchmark-honesty.md) — benchmark honesty rules
