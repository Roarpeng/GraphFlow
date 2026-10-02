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
4. 唯一 runtime 依赖是 `@modelcontextprotocol/sdk`（作为 MCP 客户端调用
   `graphflow_context`）；类型、校验器与决策逻辑是纯函数，I/O 只在
   `src/host/` 与 `bin/`。兼容矩阵见 `docs/GRAPHFLOW_COMPATIBILITY.md`。

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
- `src/corpus.ts` + `benchmarks/golden-v1.jsonl` — 50 任务语料（§24 组成
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
- `src/agent/pipeline.ts` — §27 端到端管线：flags → 指纹 → Project Twin
  （带 provenance 的 ProjectFact）→ 经验检索 → 缓存判定（命名空间化）→
  GraphFlow MCP 上下文 → Reuse Gate → 安全门 → 工具/模型路由 → 合同 →
  成本优化 → 动态 harness 执行/验证/重规划 → 写入审计 → 经验/策略生命周期 → trace。
  `runPipelineFailOpen` 实现 §9「Agent 故障 → 回退原生 worker」。
- `src/flags.ts` — §22 特性开关（默认值与规范一致；默认 broker 被封顶为 shadow）。
- `src/security/` + `policies/` — §6–§8 能力模型、R0–R5 风险分级、策略判定
  （默认 / STRICT 失败关闭）、脱敏、不可信内容包裹、注入检测、缓存准入。
- `src/observability/` — §3/§11 事件记录、OTel(OTLP JSON) 映射、trace replay。
- `src/learning/policy-lifecycle.ts` — §15 Evidence Gate → Shadow → Canary →
  Production / Anti-pattern，支持回滚。
- `src/bench-runner.ts` + `src/bench-compare.ts` — §18 五轨基准（独立 worktree、
  oracle 判定、隐藏测试、回归守卫）与 §28 验收门。
- `bin/eff-agent.ts` — §25 CLI（见下）。
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

本包是 `private: true`，**未发布到 npm**。请在仓库根目录 `npm install` 后从源码运行
（下文 `eff-agent` = `npx tsx packages/efficiency-agent/bin/eff-agent.ts`）。

### 1. 运行任务（§27 管线）

```bash
# 只生成 Execution Contract（Shadow Advisor，不执行）
eff-agent run "修复 X 的类型报错" --mode advisory

# 真实执行：外部 agent CLI 执行任务，验证命令判定成败
eff-agent run "修复 X 的类型报错" --worker external --cli-command claude --cli-args "-p" \
  --validation "npx tsc --noEmit" --policy conservative
```

- 没有执行器也没有验证命令 → `not-executed`（退出码 3），绝不报成功。
- 执行了但没有验证 → `unverified`（4）；安全策略拒绝 → `blocked`（5，R2 可 `--approve`）；
  写入越权（只读任务改文件、写 `.env` 等受保护路径）→ `violation`（6）。
- GraphFlow MCP 不可用 → 回退 twin-only 上下文；缓存损坏 → FRESH；安全策略文件损坏 →
  STRICT（失败关闭）；经验存储不可写 → 本次不学习；管线自身异常 → 原生 worker 路径（`FAIL-OPEN`）。
- 低延迟（§10 决策 P50 < 1.5 s）：默认每个 `eff-agent` 进程拉起一次 GraphFlow（冷启动约 4–5 s）。
  反复调用时先常驻一个服务，再用 URL 连接（实测决策 P50 1.35 s）：

  ```bash
  graphflow-mcp --http --port 7357          # 在项目目录常驻（或 npm run start:mcp -- --http --port 7357）
  EFF_GRAPHFLOW_MCP=http://127.0.0.1:7357/mcp eff-agent run "…" --mode shadow
  ```

  非回环地址必须设置 `EFF_GRAPHFLOW_MCP_TOKEN`（服务端用 `--http-token` 配同一值）。

### 2. 特性开关与回滚（§22 / §24）

```bash
eff-agent flags                          # 查看生效值及来源（default < flags.json < env）
eff-agent flags set EFF_AGENT_ENABLED=1 EFF_SHADOW_MODE=0
eff-agent flags rollback                 # 一键回到 shadow（原生 worker 行为）
eff-agent cache invalidate               # 命名空间代数 +1，所有旧缓存失效
eff-agent policy status | policy rollback
eff-agent trace replay graphflow-out/eff-agent/traces.jsonl --otel-out spans.json
```

默认值即规范 §22：`EFF_AGENT_ENABLED=0`、`EFF_SHADOW_MODE=1`、`EFF_PLAN_REUSE=0`、
`EFF_RESULT_REUSE=0`、`EFF_SELF_LEARNING=0`、`EFF_NETWORK_DEFAULT=0`……
因此不开启开关时 `--mode broker` 会被封顶为 shadow，并在输出中说明原因。
每次决策在 trace 中记录 `decisionId / policyVersion / contractVersion / workerVersion /
toolVersions / cacheNamespace / securityPolicyVersion / flags`。

### 3. 基准（§18 五轨）

```bash
eff-agent bench run packages/efficiency-agent/benchmarks/golden-v1.jsonl \
  --arm baseline --cli-command claude --cli-args "-p" --output runs/baseline.jsonl
eff-agent bench run packages/efficiency-agent/benchmarks/golden-v1.jsonl \
  --arm adaptive --cli-command claude --cli-args "-p" --output runs/adaptive.jsonl
eff-agent bench compare runs/baseline.jsonl runs/adaptive.jsonl --gate
```

- 轨道：`baseline`（原生）/ `graphflow`（仅注入 GraphFlow 上下文）/ `shadow` /
  `conservative` / `adaptive`；每个任务在固定 `baseCommit` 的独立 git worktree 中运行。
- 成功只由 oracle 判定（输出断言、文件断言、隐藏测试 overlay、拒绝判定）；未判定任务不进成功率；
  `guards` 失败计入回归率。
- `compare` 输出 success/fidelity/tokens/llmCalls/toolCalls/rounds/latency(P50/P95)/
  cacheHit/reuseRate/regressionRate/Net Saving，并给出 §28 验收门；`--gate` 时任一门失败退出 1。
- 外部 agent CLI 内部的 LLM 调用不可观测：`llm.calls` 标为 `proxy`（agent 调用次数），
  token 为 `estimated`（prompt 字符/4）——比较器会显示 provenance，不把它们当测量值。

### 4. 仓库根的离线基准脚本

`npm run benchmark:eff -- run --mode=baseline|shadow` 只测打包与决策管线成本
（不执行任务，trace 一律 `judged: false`），不能用于成功率结论。

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
