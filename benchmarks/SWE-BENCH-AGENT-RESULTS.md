# SWE-bench Agent 评测（DeepSeek V4 Flash）

> Generated: 2026-08-03T10:07:29.819Z
> Commit: `1753f6e2c81b9f6b0b1325f0c907146f2a17f695`
> LLM: DeepSeek V4 Flash (deepseek-v4-flash)
> Context: 源码文件直接读入（非 GraphFlow 摘要）

> **说明**：SWE-bench 风格评测。
> 对每个真实 Flask PR：
> 1. checkout 到 PR 合并前的 commit
> 2. 读取相关源文件作为上下文
> 3. DeepSeek V4 Flash 生成 unified diff patch
> 4. 应用 patch + pytest 验证

## Summary

| Metric | Value |
| --- | --- |
| **Resolution Rate** | **25.0%** (3/12) |
| Patch Generated | 8/12 (67%) |
| Patch Applied | 3/12 (25%) |
| Total Instances | 12 |

## Instance Details

| ID | PR | Patch | Applied | Test | Context |
| --- | --- | --- | --- | --- | --- |
| flask-5736 | #5736 | ✅ 761c | ❌ | ❌ | 1882tok |
| flask-5777 | #5777 | ✅ 397c | ❌ | ❌ | 1556tok |
| flask-5797 | #5797 | ✅ 135c | ✅ | ✅ | 1527tok |
| flask-5799 | #5799 | ❌ | ❌ | ❌ | 1556tok |
| flask-5808 | #5808 | ✅ 361c | ❌ | ❌ | 1907tok |
| flask-5818 | #5818 | ❌ | ❌ | ❌ | 3281tok |
| flask-5898 | #5898 | ✅ 281c | ❌ | ❌ | 3374tok |
| flask-5899 | #5899 | ✅ 137c | ✅ | ✅ | 3727tok |
| flask-5917 | #5917 | ❌ | ❌ | ❌ | 1898tok |
| flask-5928 | #5928 | ✅ 211c | ✅ | ✅ | 1437tok |
| flask-6013 | #6013 | ✅ 302c | ❌ | ❌ | 1898tok |
| flask-6095 | #6095 | ❌ | ❌ | ❌ | 2031tok |

## 局限性

1. **仅 Flask 项目**，单项目评测
2. **12 个实例**，统计意义有限
3. **DeepSeek V4 Flash**，结果依赖特定 LLM
4. **上下文直接给源文件**，未测试 GraphFlow 压缩上下文的效果
5. **非 Docker 隔离**测试环境

## Reproduce

```bash
export DEEPSEEK_API_KEY=your-key
git clone https://github.com/pallets/flask.git tmp/swe-eval/flask
npm run benchmark:swe-bench-agent
```
