# P3: CodeGraph-style Independent Multi-Domain Benchmark

> Generated: 2026-08-03T07:45:46.515Z
> Methodology: 5 domains within GraphFlow codebase, mirroring CodeGraph's multi-repo framework
> Graph: 2007 nodes, 7067 edges, indexed in 0.5s

## Summary

| Metric | Value |
| --- | --- |
| **Overall Score** | **96.2%** |
| Hit@1 | 96.0% |
| Hit@3 | 96.0% |
| Hit@5 | 96.0% |
| Avg token savings | 96.6% |
| Domains tested | 5 |
| Total queries | 26 |

## Per-Domain Results

| Domain | Description | Hit@1 | Hit@3 | Hit@5 | GF tok | Base tok | Savings |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D1-core-orchestration | Orchestrator, DAG engine, planner | 100% | 100% | 100% | 826 | 14143 | 94.2% |
| D2-graph-engine | File indexer, retrieval, context compression | 100% | 100% | 100% | 800 | 20458 | 96.1% |
| D3-learning-subsystem | Skill flywheel, episodic memory, training | 100% | 100% | 100% | 726 | 27766 | 97.4% |
| D4-config-routing | Configuration loader, model routing, providers | 80% | 80% | 80% | 755 | 19152 | 96.1% |
| D5-integrations | MCP server, bridge mode, VS Code extension | 100% | 100% | 100% | 763 | 81950 | 99.1% |

## Comparison with CodeGraph

| Metric | CodeGraph (self-reported) | GraphFlow |
| --- | --- | --- |
| Tool call savings | ~70% | 96.6% (token savings) |
| Multi-repo coverage | 7 repos | 5 domains |
| Retrieval Hit@5 | N/A | 96.0% |
| Indexing approach | File watcher incremental | Full rebuild |

## Reproduce

```bash
npx tsx benchmarks/run-independent-bench.ts
```