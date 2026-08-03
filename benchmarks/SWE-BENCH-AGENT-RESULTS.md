# SWE-bench Agent 评测（DeepSeek + GraphFlow）

> Generated: 2026-08-03T08:45:31.813Z
> Commit: `10fa0f5e1399823f2396ef84d18575bf0dd1df50`
> LLM: DeepSeek Chat (deepseek-chat)
> Context: GraphFlow compressed context

> **说明**：这是完整的 SWE-bench 风格评测。
> 对每个真实 Flask PR：
> 1. checkout 到 PR 合并前的 commit
> 2. GraphFlow 索引仓库并提供压缩上下文
> 3. DeepSeek 基于上下文生成 patch
> 4. 应用 patch 并运行 pytest
> 5. 测试通过 = resolved

## Summary

| Metric | Value |
| --- | --- |
| **Resolution Rate** | **0.0%** (0/2) |
| Patch Generated | 2/2 |
| Total Instances | 2 |

## Instance Details

| ID | PR | Patch | Test | Context Tokens |
| --- | --- | --- | --- | --- |
| flask-6013 | #6013 | ✅ (358 chars) | ❌ | 814 |
| flask-5928 | #5928 | ✅ (13396 chars) | ❌ | 1023 |

## 局限性

1. **仅 Flask 项目**：单项目评测，不代表通用能力
2. **实例数量少**：仅 2 个实例，统计意义有限
3. **DeepSeek 模型**：结果依赖特定 LLM，换模型可能不同
4. **PR 描述 ≠ Issue 描述**：PR 描述通常比真实 issue 更具体
5. **测试环境**：本地 pytest，非 Docker 隔离

## Reproduce

```bash
# 前置条件
export DEEPSEEK_API_KEY=your-key
git clone https://github.com/pallets/flask.git tmp/swe-eval/flask

# 运行评测
npm run benchmark:swe-bench-agent
```
