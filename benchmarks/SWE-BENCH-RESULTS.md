# SWE-bench 风格上下文就绪评测

> Generated: 2026-08-03T07:45:48.080Z
> Commit: `05a798172a6cff9d0d3d6df8d155bcf3e52305cb`

> **重要说明**：这不是真正的 SWE-bench 评测。GraphFlow 是上下文与记忆层插件，不具备解题能力。
> 本评测测量的是"上下文就绪率"——即 GraphFlow 压缩后的上下文是否包含任务所需的文件和符号，
> 是任务解决的**必要前提**而非充分条件。实际解决还需 LLM agent 理解、编码、测试。
>
> 评测采用多查询策略（将任务分解为文件名/符号名/原始描述多个子查询），
> 这模拟了真实 agent 的使用方式，但也意味着结果依赖于查询分解的质量。

## Summary

| Metric | Value |
| --- | --- |
| **上下文就绪率** | **100.0%** (12/12) |
| Avg File Recall | 100.0% |
| Avg Symbol Recall | 100.0% |
| Triage Accuracy | 100.0% |
| Avg Context Tokens | 4397 |
| Avg Latency | 36ms |
| Avg Plan Nodes | 4.0 |

> 单查询模式（不使用多查询分解）的上下文就绪率约为 16.7%，
> 多查询策略的 100% 结果反映的是"给定充分查询分解后，图检索能否命中相关文件"。

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

## 局限性

1. **非真实 SWE-bench**：12 个实例均为 GraphFlow 自身代码库的模拟任务，非 SWE-bench 官方数据集
2. **仅测上下文**：不测量实际代码修改、测试通过、bug 修复能力
3. **多查询策略**：评测中使用了任务分解（文件名/符号名子查询），这在实际 agent 场景中需要额外的查询规划能力
4. **自测自评**：测试用例和预期结果均由项目作者设计，可能存在偏差
5. **上下文就绪 ≠ 任务解决**：即使上下文包含所有相关文件，agent 仍需正确理解、编码和验证

## Reproduce

```bash
npx tsx benchmarks/run-swe-bench-eval.ts
```