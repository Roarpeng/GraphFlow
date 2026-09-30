# @roarpeng/graphflow-efficiency-agent

GraphFlow 2.x 效率决策层的落地包（v0.1：schema + 合同 + 纯函数，无运行时依赖）。
它消费 GraphFlow 的 MCP 输出，不直接读写 GraphFlow 的 SQLite/文件实现。

## 边界规则（Boundary rules）

1. 只通过 GraphFlow MCP / 公开 CLI 输出获取数据（如 `graphflow_run` 的
   `advisory` block、`graphflow_report_outcome`、efficiency 证据文件中
   已声明为公开的部分）。
2. 不 import 主包内部模块，不打开 `graphflow-out/graphflow-graph.*`。
3. 主仓（GraphFlow 1.x substrate）不反向依赖本包；两侧通过
   JSON schema（`schemas/`）对齐，演进以 schema 版本号为准。
4. 本包保持零 runtime 依赖；类型与校验器是纯函数。

## 内容

**契约与基准（P0–P1）**

- `src/measurement.ts` — 测量合同（Measurement Contract）：每个成本字段
  必须携带 provenance（measured / estimated / proxy）；聚合取最弱来源；
  校验器强制 R1–R6。
- `src/trace.ts` — TaskTrace v1：基准 runner 每任务一行的 trace 结构，
  `validateTraceProvenance` 是 A/B 比较的准入门（有违规即拒绝比较）。
- `src/contract.ts` — Execution Contract v1：`graphflow_run` advisory 的
  规范类型（executionDescriptor 的超集演进），`assertAdvisoryCompatible`
  验收 MCP advisory JSON。
- `src/corpus.ts` + `benchmarks/eff-tasks-v1.jsonl` — 50 任务语料（§24 组成
  20/15/10/5；regular 队列文本衍生自本仓库真实 git 历史）。
- `src/bench.ts` — 纯 trace 构建器（provenance 在构造点决定）。

**P2–P7 实现（domain.ts 为共享类型契约）**

- `src/fingerprint.ts` + `src/reuse-gate.ts` + `src/caches/`（**P3**）—
  §8 四轨指纹（semantic/project/context/environment → reuseKey）、
  版本化 Context/Plan/Result 三层缓存（TTL、状态校验、结果安全类目白名单）、
  保守复用阶梯 REUSE→ADAPT→FRESH。
- `src/broker.ts` + `src/workers/`（**P2**）—
  标准 Worker 适配器生命周期（prepare/execute/observe/validate/stop）、
  轮次+预算+停止条件的 Broker。三大 Worker 现已就位：
  * `local-command-worker.ts`：本地命令验证 worker（execFile、超时、AbortController 停止）；
  * `typesafe-jev-worker.ts`：基于强类型 Schema 约束的 AI Worker，杜绝语法漂移与任意命令执行；支持云端与本地部署端点（如 `http://localhost:8000/v1`），本地部署自动免密；
  * `external-cli-worker.ts`：外部通用 CLI Worker 适配器，包装 Claude Code、Codex CLI、Cursor 等外部通用 AI 编程代理。
- `src/dynamic-harness.ts`（**P7**）—
  §11 Dynamic Temporary Harness 动态任务沙盒控制面。根据任务复杂度自适应装配：
  * trivial：零模型确定性 fast-path
  * simple：单 Worker One-shot 模式
  * medium：Worker + 专用工具链 + 受控退避重试
  * complex：任务专属临时沙盒（Context 规划 + 专用工具集 + Sub-agents 调度 + 严格 Budget Cap 熔断 + 安全资源清理）。
- `bin/eff-agent.ts` —
  §12/§25 独立原生 CLI 命令行入口，支持直接运行任务与基准评测：
  * `eff-agent run <task> [--mode=broker|shadow|advisory] [--worker=local|jev|external]`
  * `eff-agent bench run <tasks.jsonl> [--worker=typesafe-jev|local] [--mode=baseline|shadow]`
  * `eff-agent bench compare <baseline.jsonl> <shadow.jsonl>`
- `src/learning/`（**P4**）— TrajectoryRecord 校验/汇总、带滞回的策略
  学习（成功率 <0.7 升档、≥0.9 且 2×minSamples 才降档、avgRounds>1.5 转
  loop、失败阶段 ≥30% 进 avoidPatterns）、版本化 append-only 策略存储。
- `src/project-twin.ts` + `src/tools/`（**P5**）— §10 Project Twin（模块/
  入口/关键符号/构建/测试/约定，确定性派生）、§9 工具能力注册表
  （success_history 驱动排序）+ 能力路由器（按能力选工具，不按名字偏好）。
- `src/cost/`（**P6**）— 成本组合模型（R5 最弱来源聚合）+ 受 floor 约束的
  最小成本动作选择器（success/fidelity/safety/evidence 四道门）。
- `src/self-optimize/`（**P7**）— 反思规则（cache-win/miss、over-budget、
  quality-floor-miss）+ §21 自优化闭环编排（决策→执行→反思→策略更新，
  策略学习器可注入）。
- `tests/integration-cycle.test.ts` — 跨模块集成：指纹→缓存→复用门→
  真实本地 worker 执行→轨迹→策略升档→优化器选择→闭环，全部真实模块。

- `schemas/trace-v1.schema.json` / `schemas/execution-contract-v1.schema.json`
  / `schemas/tool-capability-v1.schema.json` — 外部工具用的规范 JSON Schema。

## 命令行与基准运行（CLI & Benchmark）

### 1. 独立 eff-agent CLI
```bash
# 运行单个任务（Broker 真实调度）
npx eff-agent run "修复某个模块的类型报错" --worker=jev --policy=conservative

# 运行真实模型基准
npx eff-agent bench run benchmarks/eff-tasks-v1.jsonl --worker=jev --mode=shadow

# 严格 R1-R6 溯源门禁 A/B 比较
npx eff-agent bench compare baseline.jsonl shadow.jsonl
```

### 2. 仓库内部基准脚本（含真实 Worker 臂）
```bash
# 离线模拟臂
npm run benchmark:eff -- run --mode=baseline
npm run benchmark:eff -- run --mode=shadow

# 真实 Worker 臂（支持 TypeSafe-JEV 或 DeepSeek）
npm run benchmark:eff -- run --mode=shadow --worker=typesafe-jev --provider=deepseek

# A/B 对比输出真实 Token 节约率与 LLM 调用减少率
npm run benchmark:eff -- compare graphflow-out/eff-bench/baseline.jsonl graphflow-out/eff-bench/shadow.jsonl
```

```
npm run benchmark:eff -- run --mode=baseline   # → graphflow-out/eff-bench/baseline.jsonl
npm run benchmark:eff -- run --mode=shadow     # → graphflow-out/eff-bench/shadow.jsonl
npm run benchmark:eff -- compare graphflow-out/eff-bench/{baseline,shadow}.jsonl
```

双臂离线（bridge 路径、无 LLM key、临时沙箱、episode 按队列语义闭合：
failure 队列记 fail），测量的是打包+决策管线成本，不是 worker 结局——
worker 结局臂随 P2 broker 到来。

## 校准发现（Shadow 第一条，已修复）

全量 50 任务首跑实测：闭合 episode 后 **49/50 判 ADAPT**。根因是 substrate
`similarEpisodes` 的 `score` 字段是**结局分**（pass=1 / pending=0 / fail=-1）
而非相似度分——advisory 的 0.5 阈值实际语义退化成"top-3 相似排名里存在
任何 pass episode"。

**已修复**（similarity/outcome 拆分）：`orchestrator-episode.ts` 的 summary
现在同时携带 `score`（结局信号）与 `similarity`（文本 Jaccard 相似度，
`taskSimilarity()`）；advisory `decideReuseMode` 以 `similarity ≥ 0.5` 为主
门，仅在调用方无法提供 similarity 时回退旧 score 门。修复后 6 任务切片
ADAPT 5→3（边界任务 rep-004 Jaccard=0.45 正确落回 FRESH）。

## 测量合同速览（R1–R6）

| 规则 | 内容 |
| --- | --- |
| R1 | 成本字段一律 `Measurement`，不许裸数字 |
| R2 | `measured`：直读仪表（provider usage、墙钟）；不得带 method/confidence |
| R3 | `estimated`：按公式推导；`method` 必填（如 `chars/4`） |
| R4 | `proxy`：替代不可得的直接信号（如 host telemetry 计 token）；`method` 必填 |
| R5 | 聚合继承输入的最弱 provenance（measured > estimated > proxy） |
| R6 | 带违规的 trace 不可比较，比较器必须拒绝 |

为什么：验收指标里 "LLM Calls ↓ 20%" 这类数字在 Worker 侧往往拿不到
provider usage——没有 provenance 的 A/B 比较是拿猜测当结论。合同把
"这个数从哪来" 变成结构属性。

## 与主仓的对应

- substrate 侧 `src/core/efficiency-advisory.ts` 产出 advisory（纯 Layer A，
  零 LLM 调用），经 `graphflow_run` 响应下发；
- substrate 侧 `src/learning/decision-ledger.ts` 把决策自身成本
  （`graphflow-out/decision-ledger.jsonl`）入账，字段语义与本包
  measurement 合同一致；
- 本包 `assertAdvisoryCompatible` + `validateTraceProvenance` 是基准
  runner（Step A/B/D）的准入与比较门。
