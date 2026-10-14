# P3: Multi-Domain Internal Check (CodeGraph-style layout)

> Generated: 2026-09-30T14:55:52.518Z
> Methodology: 5 domains within the GraphFlow codebase itself (not independent repos)
> Graph: 4146 nodes, 15007 edges, indexed in 1.7s

> **Self-graded internal check, not an independent benchmark.** Queries, expected
> keywords, domain file patterns, and the composite weights were all chosen by the
> project author; there is no held-out query set. Do not quote the composite as a
> product score or compare it with other tools' numbers.

## Summary

| Metric | Value |
| --- | --- |
| Composite (self-chosen weights: 0.4·Hit@5 + 0.3·savings + 0.2·Hit@3 + 0.1·Hit@1) | 82.8% |
| Hit@1 | 62.0% |
| Hit@3 | 76.7% |
| Hit@5 | 80.0% |
| MRR | 0.695 |
| Avg token savings (token ratio vs domain files in full; not an answer-quality measure) | 97.6% |
| Domains tested | 5 |
| Total queries | 26 |

## Per-Domain Results

| Domain | Description | Hit@1 | Hit@3 | Hit@5 | MRR | GF tok | Base tok | Savings |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1-core-orchestration | Orchestrator, DAG engine, planner | 60% | 60% | 60% | 0.629 | 940 | 19561 | 95.2% |
| D2-graph-engine | File indexer, retrieval, context compression | 50% | 83.3% | 100% | 0.644 | 854 | 26886 | 96.8% |
| D3-learning-subsystem | Skill flywheel, episodic memory, training | 80% | 100% | 100% | 0.900 | 855 | 102699 | 99.2% |
| D4-config-routing | Configuration loader, model routing, providers | 60% | 60% | 60% | 0.600 | 870 | 29290 | 97% |
| D5-integrations | MCP server, bridge mode, VS Code extension | 60% | 80% | 80% | 0.700 | 880 | 237477 | 99.6% |

## Methodology & caveats

- **Relevance**: an anchor is relevant when its id points into one of the domain's files, or
  when its own id + content contain every expected keyword. Only the ranked anchor channel
  counts; the summary channel carries no rank.
- **Hit@k** = the first relevant anchor has rank <= k. **MRR** = mean of 1/rank (0 when no
  anchor is relevant). Earlier versions credited Hit@1 whenever the whole package matched,
  ignoring rank; those numbers are superseded.
- **Token savings** is a token-count ratio against concatenating every file of the domain;
  it does not check that the package still contains what is needed to answer the query.
- Corpus = GraphFlow's own `src/`; the queries were written by the author who also tunes the
  ranker, so these numbers are optimistic and are not evidence of generalization.

## Reproduce

```bash
npx tsx benchmarks/run-independent-bench.ts
```