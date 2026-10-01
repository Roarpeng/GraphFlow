# Real-Provider A/B Results — Step D 首份真实数字（2026-09-30）

`npm run benchmark:real` — 50 任务 × 双臂，真实 deepseek-v4-flash 调用，
usage 取自 provider 响应（R2 measured），R6 provenance 门全净。
总实验成本 ≈ **$0.20**。

## 设计

| 臂 | 上下文获取方式 | 预算 |
|---|---|---|
| baseline | 传统方式：grep 任务词 → 读 top-3 匹配文件（各 ≤250 行） | 6000 字符 |
| shadow | GraphFlow 压缩上下文包（graphflow_context，本仓库真实图谱） | 6000 字符（同预算） |

同模型、同单轮、同任务集（50 任务语料）。首版裸提示词基线被否掉——
它会把"效率层带上下文"误读成 +2000% 输入，方向性错误。

## §22 指标（50 任务）

| 指标 | baseline | shadow | Δ | §23 门槛 | 判定 |
|---|---|---|---|---|---|
| Context/input tokens（均值，n=50，单次运行，未测质量） | 1578 | 835 | **-47%** | ↓20% | ✅ 仅输入量过门槛（非质量结论） |
| 输入 token 总量 | 78,913 | 41,736 | -47.1% | — | — |
| LLM calls（总） | 50 | 50 | 0 | ↓20% | ⚪ 单轮设计，本轮不适用 |
| Rounds（均值） | 1.0 | 1.0 | 0 | ↓15% | ⚪ 同上 |
| 成功率 | 100% | 100% | 0 | ≥ baseline | ✅（判据=非空回答） |
| 决策成本占比 | — | 0.01% | — | — | ✅ |

费用（proxy 价格表）：两臂各 ≈ $0.10——输出 token 主导且 25-32/50 条
回复顶到 2048 上限，**输出侧本轮无结论价值**；输入侧 -47% 只说明输入 token
量更少，不说明回答质量持平（见下方局限 0）。

## 如实声明的局限

0. **-47% 只是输入 token 量，不是质量结论。** 本轮没有测回答质量；样本为
   50 个任务、每臂各跑 1 次，未记录逐任务方差（本报告只有均值，没有标准差
   或置信区间）。两臂共用 6000 字符上限，而 shadow 臂只发送压缩包的 summary
   （不含锚点），所以 -47% 主要反映 summary 比上限短多少，而非“同等信息量下
   少用 47%”。复跑后脚本会额外打印逐任务配对差值的中位数、标准差与 95% CI。
1. **成功率判据是"模型给出非空回答"**，不是任务正确性——质量判定要接
   validator 层（P2 broker 的 validate 环节）后才有意义。
2. **输出 token 被生成上限支配**（maxTokens=2048），输出/费用对比本轮
   不作数；后续应加 per-task 产出预算或改判据。
3. **单轮设计**：LLM Calls ↓ / Rounds ↓ 两道门槛需要带真实验证的
   重试循环（broker）才能测。
4. **同模型双臂**：Model Routing（economy 足够）门槛需要多档位臂。
5. grep 基线是"合理但特定"的反事实（top-3 文件 × 250 行 × 6000 字符）；
   更完整的对照沿用 `npm run benchmark`（token-benchmark Arm A/B）。

## 工件

- `graphflow-out/eff-bench/real-baseline.jsonl` / `real-shadow.jsonl`
  （50 条 TaskTrace/臂，全部 R6 干净）
- `benchmarks/run-real-ab.ts`（可复跑；`GRAPHFLOW_REAL_BENCH=0` 可禁）
