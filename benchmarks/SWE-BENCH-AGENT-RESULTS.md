# SWE-bench Agent 评测 v3（DeepSeek V4 Flash + Retry）

> Generated: 2026-08-03T10:45:26.880Z
> Commit: `ece12f12485418a5fccce539766b4b5556468015`
> LLM: deepseek-v4-flash（推理模型）
> 改进：完整源码 + retry with error feedback

> **Disclaimer:** This 91.7% resolution rate used **uncompressed full source files** as context. It is **not** a GraphFlow compression / token-savings result, and it does **not** measure information fidelity of preview summaries. Agent score ≠ lossless body coverage.

> **说明**：SWE-bench 风格评测。
> 1. checkout 到 PR 合并前 commit
> 2. 读取完整源文件作为上下文（未压缩；不是 GraphFlow preview）
> 3. DeepSeek V4 Flash 生成 patch
> 4. apply 失败时，将错误反馈给模型重试
> 5. pytest 验证

## Summary

| Metric | Value |
| --- | --- |
| **Resolution Rate** | **91.7%** (11/12) |
| Patch Generated | 12/12 (100%) |
| Patch Applied | 11/12 (92%) |
| Total Instances | 12 |

## Instance Details

| ID | PR | Patch | Applied | Test | Context |
| --- | --- | --- | --- | --- | --- |
| flask-5736 | #5736 | ✅ 6795c | ✅ | ✅ | 6615tok |
| flask-5777 | #5777 | ✅ 246c | ✅ | ✅ | 5416tok |
| flask-5797 | #5797 | ✅ 246c | ✅ | ✅ | 2290tok |
| flask-5799 | #5799 | ✅ 20463c | ✅ | ✅ | 5417tok |
| flask-5808 | #5808 | ✅ 358c | ✅ | ✅ | 8401tok |
| flask-5818 | #5818 | ✅ 16191c | ✅ | ✅ | 16801tok |
| flask-5898 | #5898 | ✅ 268c | ✅ | ✅ | 5364tok |
| flask-5899 | #5899 | ✅ 4522c | ✅ | ✅ | 22384tok |
| flask-5917 | #5917 | ✅ 18181c | ✅ | ✅ | 8761tok |
| flask-5928 | #5928 | ✅ 14627c | ✅ | ✅ | 4033tok |
| flask-6013 | #6013 | ✅ 300c | ❌ | ❌ | 8733tok |
| flask-6095 | #6095 | ✅ 14344c | ✅ | ✅ | 5726tok |

## 局限性

1. 仅 Flask 项目
2. 12 个实例
3. deepseek-v4-flash（轻量推理模型）
4. 非 Docker 隔离
5. 上下文直接给源文件（未测试 GraphFlow 压缩效果）

## Reproduce

```bash
export DEEPSEEK_API_KEY=your-key
git clone https://github.com/pallets/flask.git tmp/swe-eval/flask
npm run benchmark:swe-bench-agent
```
