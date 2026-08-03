# SWE-bench 真实项目评测（Flask）

> Generated: 2026-08-03T08:28:30.355Z
> Commit: `e0e75c6fd9d35ae36aa242006995e409beb3a145`
> Target: pallets/flask (Python)

> **说明**：本评测使用 Flask 真实合并 PR 作为测试实例。
> PR 描述作为 problem_statement，PR 修改的文件作为 ground truth。
> 测量 GraphFlow 上下文检索的文件召回率。
> 这不是完整的 SWE-bench 评测（无 LLM patch 生成），仅测量上下文准备能力。

## Summary

| Metric | Value |
| --- | --- |
| **Full Recall Rate** | **40%** (4/10) |
| Partial Recall | 2/10 |
| No Recall | 4/10 |
| Avg File Recall | 48.3% |
| Avg Context Tokens | 882 |
| Graph Size | 1897 nodes, 13324 edges |
| Index Time | 0.3s |

## Instance Details

| ID | Difficulty | Recall | Hits | Tokens | Status |
| --- | --- | --- | --- | --- | --- |
| flask-6013 | easy | 100% | 1/1 | 910 | ✅ |
| flask-5928 | medium | 33% | 1/3 | 829 | ⚠️ |
| flask-6095 | easy | 0% | 0/2 | 865 | ❌ |
| flask-5800 | medium | 0% | 0/2 | 905 | ❌ |
| flask-5700 | medium | 100% | 1/1 | 781 | ✅ |
| flask-5600 | easy | 100% | 1/1 | 900 | ✅ |
| flask-5500 | easy | 0% | 0/1 | 930 | ❌ |
| flask-5400 | hard | 100% | 2/2 | 883 | ✅ |
| flask-5300 | medium | 50% | 1/2 | 943 | ⚠️ |
| flask-5200 | hard | 0% | 0/2 | 871 | ❌ |

## By Difficulty

| easy | 2/4 | 50% |
| medium | 1/4 | 46% |
| hard | 1/2 | 50% |

## 局限性

1. **仅测文件召回**：不测量符号级召回、patch 生成、测试通过
2. **单项目**：仅 Flask 一个 Python 项目，不代表通用能力
3. **PR 描述 ≠ Issue 描述**：PR 描述通常比 issue 更具体，可能偏向容易检索
4. **无 LLM**：真实 SWE-bench 需要 LLM 生成 patch，本评测不涉及
5. **浅层 clone**：使用 --depth 1，无完整 git 历史

## Reproduce

```bash
# 1. Clone Flask
git clone --depth 1 https://github.com/pallets/flask.git /tmp/flask-swe-test

# 2. Run evaluation
npx tsx benchmarks/run-swe-bench-real.ts
```
