# P4: SWE-bench Style End-to-End Evaluation

> Generated: 2026-08-03T07:45:48.080Z
> Commit: `05a798172a6cff9d0d3d6df8d155bcf3e52305cb`
> Methodology: SWE-bench style "context readiness" evaluation — measures whether GraphFlow's compressed context provides sufficient information for task resolution

## Summary

| Metric | Value |
| --- | --- |
| **Resolution Rate** | **100.0%** (12/12) |
| Avg File Recall | 100.0% |
| Avg Symbol Recall | 100.0% |
| Triage Accuracy | 100.0% |
| Avg Context Tokens | 4397 |
| Avg Latency | 36ms |
| Avg Plan Nodes | 4.0 |

## By Difficulty

| Difficulty | Resolved | Total | Rate |
| --- | --- | --- | --- |
| easy | 4 | 4 | 100.0% |
| medium | 5 | 5 | 100.0% |
| hard | 3 | 3 | 100.0% |

## By Category

| Category | Resolved | Total | Rate |
| --- | --- | --- | --- |
| bug-fix | 4 | 4 | 100.0% |
| test | 1 | 1 | 100.0% |
| refactor | 2 | 2 | 100.0% |
| feature | 5 | 5 | 100.0% |

## Instance Details

| ID | Difficulty | Category | Files | Symbols | Tokens | Latency | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GF-001 | easy | bug-fix | 100% | 100% | 3750 | 70ms | ✅ |
| GF-002 | easy | bug-fix | 100% | 100% | 2584 | 28ms | ✅ |
| GF-003 | easy | test | 100% | 100% | 3072 | 13ms | ✅ |
| GF-004 | easy | bug-fix | 100% | 100% | 3122 | 24ms | ✅ |
| GF-005 | medium | refactor | 100% | 100% | 4623 | 35ms | ✅ |
| GF-006 | medium | feature | 100% | 100% | 4637 | 38ms | ✅ |
| GF-007 | medium | bug-fix | 100% | 100% | 4693 | 30ms | ✅ |
| GF-008 | medium | feature | 100% | 100% | 4541 | 42ms | ✅ |
| GF-009 | medium | feature | 100% | 100% | 3478 | 18ms | ✅ |
| GF-010 | hard | feature | 100% | 100% | 6442 | 53ms | ✅ |
| GF-011 | hard | refactor | 100% | 100% | 7238 | 35ms | ✅ |
| GF-012 | hard | feature | 100% | 100% | 4585 | 44ms | ✅ |

## Comparison with SWE-bench Standards

| System | Resolution Rate | Context |
| --- | --- | --- |
| GraphFlow (context readiness) | 100.0% | Compressed graph context |
| SWE-bench top systems (actual resolution) | ~30-50% | Full repo + LLM agent |
| SWE-bench baseline (no context) | ~5-10% | Raw grep |

> **Note**: This measures *context readiness* (whether the right files/symbols are in the compressed context), not actual task resolution (which requires an LLM agent). Context readiness is a necessary precondition for resolution.

## Reproduce

```bash
npx tsx benchmarks/run-swe-bench-eval.ts
```