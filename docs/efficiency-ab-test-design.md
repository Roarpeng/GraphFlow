# 插件启用 / 未启用 完成任务 Token 消耗 A/B（SoL-Pi 配对效率测试设计）

> 目标：回答「启用 GraphFlow 插件是否让同一个 Agent 用更少 token 完成同一个任务，且没有少干活」。
> 方法：沿用 v1.18.0 借鉴 NVIDIA [SoL-Pi](https://nvlabs.github.io/SoL-Pi/) 的「配对双臂 + 能力地板」判定，而不是只看 token 降幅。
> 状态：离线 micro 臂已可一键运行并产出真实数字（§8）；真实会话臂已接线（§5），需人工跑两组 DSH。

---

## 1. 先回答：当前项目具备 SoL-Pi 能力吗？

**具备，P0/P1/P2 全链路已落地**，但有一个真实缺口（见下）。逐项证据：

| 层 | 能力 | 代码 / 表面 | 状态 |
| --- | --- | --- | --- |
| P0 | 统一效率开关 `efficiencyPolicy.{observations,contextPressure,actionFusion}`，默认全开 | `src/config/schema.ts`、`src/config/resolve.ts`、`src/config/defaults.ts:83-102` | ✅ |
| GF-2 | ObservationPack：大输出归档为 `gfo:` 句柄，head/tail 投影 + 分页精确召回 | `src/observations/policy.ts`、`host-hook.ts`、`graphflow_context` | ✅ |
| GF-3 | Online Context Compact：按**观测到的** contextPressure 缩放预算 + compaction 经济性建议 | `src/surfaces/mcp/tool-handlers.ts`、`tests/efficiency-wiring.test.ts` | ✅ |
| GF-4 | Action Fusion：edit 紧跟 run/validate 合并为执行描述符 steps | `src/core/orchestrator-phases.ts`、`tests/efficiency-wiring.test.ts` | ✅ |
| P1 | 配对效率报告 + 能力地板（tokens / turns / responseCount / score） | `src/learning/efficiency-report.ts`；`governance release-gate --min-efficiency-qualifying` | ✅ |
| P2 | 机制自动研究回路（proposed→in-trajectory→frozen→held-out→admitted/rejected） | `src/learning/mechanism-research.ts`；`graphflow mechanism *` | ✅ |
| 宿主投影 | DSH 原生 surface-replace：t/result 首插前替换为句柄，默认开、fail-open | `dsh/plugin.mjs:1284-1324`、`isObservationProjectionEnabled` | ✅ |

### 1.1 测试暴露并已修复的问题（本次优化）

| 问题 | 修复 | 验证 |
| --- | --- | --- |
| 配对报告**没有生产侧生产者**：`recordEfficiencyComparison` 只被测试调用，真实运行不会生成 `graphflow-out/efficiency.json` | `graphflow mechanism trial` 现在通过 `onComparison` 把它**自己评估出的 record**（用机制自带 tolerance，不按默认 0.05 重算）写入报告；新增 `appendEfficiencyRecord` 作为「不重算」的持久化入口 | `graphflow mechanism trial ... && graphflow efficiency` → `comparisons=1; qualifying=1` |
| 报告只能被 release-gate 间接读到，无法直接查看/清空 | 新增 CLI `graphflow efficiency [show\|reset] [--json]` | `graphflow efficiency --json` 返回 report + floor |
| `docs/efficiency-mechanisms.md:3-4` 说默认关闭，实际默认全开 | 改为「默认全开（best config），可按 section 关闭」 | 与 `src/config/defaults.ts:83` 一致 |
| `src/observations/host-hook.ts:92` 说投影默认关，实际默认开 | 改为「ON by default，显式 0/false/off/no/disabled 才关」 | 与 `dsh/plugin.mjs:1218` 一致 |
| ObservationPack 宣称 exact recall，但默认 `redactOnStore` 会先脱敏 | 文档明确「召回的是存档字节；默认脱敏，关闭才逐字节无损」 | `benchmarks/run-plugin-ab.ts --raw-store` 可验证 |

`benchmarks/run-plugin-ab.ts` 仍是最小生产者：它把一次离线 micro 对照或两次真实 DSH 会话，转成同一套配对记录。

---

## 2. 假设与判据（SoL-Pi 诚实规则）

- H0：插件不降低完成同一任务的 token。
- H1：插件降低 token，且能力指标不退化（没有靠「少干活」换 token）。

判定复用 `evaluateEfficiencyComparison`（`src/learning/efficiency-report.ts:128`），只有同时满足才算 qualify：

```
tokenSavingRatio > 0
scoreDeltaRatio          >= -tolerance   (默认 tolerance = 0.05)
responseCountDeltaRatio  >= -tolerance   (反「少干活」控制项)
```

- `no-efficiency-gain`：token 没有降。
- `capability-regression:score`：得分掉超容差。
- `capability-regression:response-count`：模型响应数（DSH 的 steps）掉超容差 —— 这正是**禁止用「少做步骤」伪造省 token**。

---

## 3. 被测任务（fixture，需产生 >8KB 工具结果）

投影阈值是**每条**工具结果 8192 字节，所以任务必须逼 Agent 读大文件，否则插件无事可做、测试无意义。

**主任务 T1（读多、可客观打分、只读）**

> 解释本仓库 `src/surfaces/cli/index.ts` 里 `mechanism trial` 子命令如何登记一次配对试验：
> 列出它调用的函数链、`baseline/packaged` 两臂字段如何映射，以及最终写入的节点 id 前缀。给出 `文件:行号`。

打分量规（0..1，先看客观事实再看表达）：

| 分项 | 分 | 判据 |
| --- | --- | --- |
| 调用链正确 | 0.4 | 命中 `recordMechanismTrial` → `evaluateEfficiencyComparison` → `writeMechanism` |
| 字段映射正确 | 0.3 | tokens / score / responses 三臂字段对应 |
| 节点 id 前缀正确 | 0.2 | `mechanism:<slug>` |
| 行号可核验 | 0.1 | 关键行号 ±2 行 |

**可选任务 T2（改代码 + 跑测试）**：给 `evaluateEfficiencyFloor` 增加一个可选阈值并补测试。
成功判据是 `vitest run` 全绿；工具输出包含大段测试日志，能同时压测「编辑+验证」融合臂。

同一份对照里 **两臂必须用同一个任务**；不同任务的 token 数不可相减。

---

## 4. 两个测量层级：L1 杠杆、L2 端到端

| 层级 | 测什么 | 成本 | 现在能否跑 |
| --- | --- | --- | --- |
| L1 micro | ObservationPack 在**首次插入前**对单条工具结果的 token 压缩 | 0，离线确定性 | ✅ 一条命令 |
| L2 session | 真实 Agent 跑完整任务的总 token + 能力 | 需要模型额度与时间 | 已接线，人工跑两组 DSH |

**不要把 L1 的数字当成端到端结论**：L1 只证明「大结果首插更省」，不包含 Agent 后续按 handle 召回的成本。

---

## 5. L2 真实对照协议（同一 workspace / 模型 / prompt）

### 5.1 两组 profile

```sh
# 基线臂 OFF：不带 graphflow 的官方 headless 模板
dsh --profile headless "<T1 prompt>"

# 打包臂 ON：从 headless 模板派生并装入插件
dsh plugin --profile headless-gf --from-default-profile headless
dsh plugin --profile headless-gf add @roarpeng/graphflow
graphflow graph index .        # 让 ON 臂真的有图谱上下文
dsh --profile headless-gf "<T1 prompt>"
```

一条命令打印以上全部步骤（不真正执行）：

```sh
npm run benchmark:plugin-ab -- --mode plan
```

### 5.2 取数：DSH 自带 provider 口径 token

DSH 把每个会话的用量写进投影缓存：

```
$DSH_HOME/storages/session_projcache/sessions/session-<uuid>.json
  record.rows.tokenUsage.val.totals = {
    uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens
  }
  record.rows.sessionStats.val = { turns, steps, ... }
```

注意 DSH 历史上写过 `session-<uuid>.json` 与 `<uuid>.json` 两种文件名，harness 两种都能解析。

### 5.3 配对并落盘

```sh
npm run benchmark:plugin-ab -- --mode session \
  --baseline-session <OFF session id> --packaged-session <ON session id> \
  --baseline-score <0..1> --packaged-score <0..1> --record
```

`--record` 会写 `graphflow-out/efficiency.json`（该目录在 `.gitignore` 中）。

### 5.4 必须固定的控制项

1. 同一模型与 temperature（建议 0）、同一系统提示、同一 prompt hash。
2. 同一 workspace commit；ON 臂先 `graphflow graph index .`。
3. 每臂 **≥3 次独立新会话**，取中位数，不用最好的一次。
4. 打分对两臂**盲评**（隐藏臂标签），或全部用自动判据。
5. 额外对照组：ON 臂再跑一次 `GRAPHFLOW_D_DSH_PROJECTION=0`，用于把「投影」与「MCP 上下文压缩」两种省法分开。
6. 打开 DSH 原生 result pruner 时要在报告里注明，否则省下的 token 可能来自宿主而非插件。

---

## 6. 指标定义

| 指标 | 定义 | 用途 |
| --- | --- | --- |
| `total` | uncachedInput + cacheRead + cacheWrite + output | 主指标：token 总消耗 |
| `input` | uncachedInput + cacheRead + cacheWrite | 上下文规模 |
| `uncached` | uncachedInput + output | 计费敏感下限 |
| `score` | T1 量规 / T2 测试是否全绿 | 能力地板 |
| `responseCount` | DSH `steps`（模型响应/步数） | 反「少干活」 |
| `turns` | DSH `turns` | 交互轮数参考 |
| 保真 | `graphflow-out/context-fidelity.json` 的 anchor recall / body coverage | 省 token 是否牺牲检索 |
| break-even recalls | savedTokens ÷ 单条原始结果 token | 需要召回多少次就白省了 |

---

## 7. 判读标准

- **合格（门禁口径）**：`tokenSavingRatio > 0` 且 score、responseCount 均不退化超 5%。
- **可发布（更严）**：`total` 中位降幅 ≥ 20%，score 不低于基线 0.05，responseCount 不降，且 ≥3 次运行一致。
- **不合格的典型形态**：token 降但 steps 降 → `capability-regression:response-count`；token 降但 score 降 → `capability-regression:score`；token 没降 → `no-efficiency-gain`。

门禁命令：

```sh
graphflow governance release-gate \
  --min-efficiency-qualifying 1 \
  --max-capability-regressions 0
```

---

## 8. 本次已跑真实结果（L1 micro）

命令：

```sh
npm run benchmark:plugin-ab              # --files N 调整样本；--raw-store 关闭存档脱敏
```

结果（本 checkout，8 个最大的 `src/**/*.ts` 真实文件作为「Agent 会整读的工具结果」）：

```
files (over-budget reads):  8  (archived: 8)
first-insert tokens OFF:    101692
first-insert tokens ON:     7418
saved:                      94274  (92.71%)
break-even full recalls:    7.42
recall fidelity:            ok  (modulo declared redaction; 4 redacted)
```

含义：

- 首插阶段省 **92.71%**；
- 但若 Agent 把其中 ≥7.42 条结果再整段召回，节省归零 —— 所以这是**上限**，不是端到端结论；
- 8 条全部可召回；其中 4 条因 `redactOnStore: true`（默认）在存档时被脱敏，召回的是**脱敏后的存档字节**。要验证纯无损，用 `--raw-store` 关闭脱敏后召回与原文逐字节一致。

落盘验证：`--record` 已成功写入 `graphflow-out/efficiency.json`，`qualifies=true`，`averageTokenSavingRatio=0.9271`。

---

## 9. 负面清单（不要把下列东西算成效率）

- 不要把只降 **输出** token、却让输入暴涨的改动算成省。
- 不要把「Agent 少读了文件/少跑了测试」算成省 —— responseCount / score 会把它抓出来。
- 不要跨任务、跨 commit、跨模型对比 token 数。
- 不要只看 `cacheReadTokens` 的绝对数：缓存读单价低于未缓存输入，`total` 与 `uncached` 要一起报。
- 不要在 ON 臂需要整段重读时仍宣称节省；用 break-even recalls 说明。
- 不要用单次最好成绩；用中位数 + 离散度。

---

## 10. 相关文件

| 文件 | 作用 |
| --- | --- |
| `benchmarks/run-plugin-ab.ts` | A/B harness：`micro` / `session` / `plan` 三模式 |
| `benchmarks/plugin-ab-lib.ts` | 纯函数：DSH 用量解析、token 口径、break-even |
| `tests/plugin-ab-benchmark.test.ts` | 上述纯函数的回归测试（14 例） |
| `benchmarks/run-real-task-ab.ts` | 真实任务离线 A/B：token + 可检索性能力地板；结果见 `benchmarks/REAL-TASK-AB-RESULTS.md` |
| `src/learning/efficiency-report.ts` | 配对判定与能力地板；新增 `appendEfficiencyRecord` 作为生产者入口 |
| `src/surfaces/cli/index.ts` | `graphflow mechanism trial` 写入报告；新增 `graphflow efficiency [show\|reset]` |
| `docs/efficiency-mechanisms.md` | SoL-Pi 机制总览（注意 §1.1 的漂移） |
