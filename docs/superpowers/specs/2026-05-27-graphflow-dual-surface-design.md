# GraphFlow 双形态智能编排工具设计文档

- 日期: 2026-05-27
- 状态: Draft (User-Confirmed Architecture)
- 作者: GitHub Copilot
- 适用范围: GraphFlow v0.1 MVP

## 1. 背景与目标

用户希望将 Graphify 与 Superpowers 的能力整合为一个可长期演进的工具，满足以下关键诉求：

1. 简单任务单 Agent 直接执行。
2. 复杂任务自动进入计划拆解与任务包执行。
3. 多 Agent 并行执行复杂任务的子任务。
4. 每完成一个任务节点必须进行校验，检查需求与结果是否对齐。
5. 规划与校验使用更强模型，执行使用更高性价比模型。
6. 模型可配置并兼容 OpenAI、Anthropic、百炼、豆包。
7. 每次项目更新自动建立/更新知识图谱，稳定后续对话上下文并降低 token 消耗。
8. 引入小模型学习飞轮，形成“越用越聪明”的策略优化能力。

## 2. 非目标

1. v0.1 不做 Web 控制台，仅提供 CLI 与 VS Code 扩展入口。
2. v0.1 不做全自动在线持续训练主模型，避免稳定性风险。
3. v0.1 不做跨仓库多租户权限系统。

## 3. 总体方案

采用分层架构（方案 B）：统一编排内核 + 双前端适配器。

### 3.1 分层架构

1. Surface Layer
- VS Code Extension: 命令面板与运行视图。
- CLI: 批处理和自动化入口。

2. Core Orchestration Layer
- Triage: 判断 simple / complex。
- Planner: complex 模式下生成 DAG 任务包。
- DAG Scheduler: 并行执行与依赖控制。
- Validator Loop: 每节点校验与重试控制。

3. Intelligence Layer
- Model Router: 角色到模型分层映射与故障降级。
- Context Router: 图谱查询、摘要层召回、token 预算裁剪。
- Learning Flywheel: 反馈采集、策略训练、灰度发布。

4. Infra Integration Layer
- Graphify MCP Client: 图谱 upsert 与 query。
- Git Hooks + File Watcher: 自动图谱更新触发。
- Provider Adapters: OpenAI / Anthropic / 百炼 / 豆包统一接口。

## 4. 运行模式

### 4.1 混合路由模式（默认）

1. 系统先给出自动判定与推荐执行模式。
2. 用户可一键确认或覆盖模式。
3. 判定规则：
- Simple: 单文件或低依赖任务，目标清晰，低风险。
- Complex: 涉及多文件依赖、架构调整、跨模块联动或不确定性高。

### 4.2 执行模式定义

1. Single-Agent Mode
- 角色: Worker + Validator。
- 流程: 执行 -> 校验 -> 最多 N 次重试。

2. Plan-and-Package Mode
- 角色: Planner -> 多 Worker -> Validator。
- 流程: 需求转 DAG -> 按依赖并行执行任务包 -> 每节点校验 -> 汇总收敛。

## 5. 角色与模型路由

### 5.1 角色职责

1. Planner
- 输入: 需求、图谱摘要、约束。
- 输出: 严格结构化 DAG（节点、依赖、验收条件、上下文查询）。

2. Worker
- 输入: 单任务、上下文切片、上轮反馈。
- 输出: 修改提案（代码/文档/命令执行结果）。

3. Validator
- 输入: 任务原始需求、Worker 结果、相关上下文。
- 输出: pass/fail + 精简反馈 + 风险标签。

### 5.2 模型分层规则

1. smart tier
- 默认用于 Planner 和 Validator。
- 目标: 提升推理质量与验收稳定性。

2. economy tier
- 默认用于 Worker 并行池。
- 目标: 降低执行成本、提高吞吐。

3. 升档策略
- 当任务被连续打回达到阈值时，Worker 临时升档至 smart tier 一次。

### 5.3 多供应商兼容

统一 ProviderAdapter 接口：

1. generateText
2. generateStructured
3. streamText
4. usage

支持供应商：

1. OpenAI
2. Anthropic
3. 百炼
4. 豆包

## 6. 知识图谱设计（对齐 Graphify）

### 6.1 图谱目标

1. 用最小必要上下文支持任务执行，减少全量代码注入。
2. 保障同一次运行内 Planner/Worker/Validator 上下文一致。
3. 对复杂任务支持多跳依赖与模块级摘要召回。

### 6.2 节点与边（MVP）

节点类型：

1. File
2. Symbol
3. Module
4. TaskRun
5. Decision

关系类型：

1. defines (File -> Symbol)
2. references (Symbol -> Symbol)
3. imports (File -> File/Module)
4. depends_on (Module/Symbol -> Module/Symbol)
5. changes (TaskRun -> File/Symbol)
6. validates (Validator -> TaskRun)

### 6.3 自动更新触发链

默认触发源：

1. 任务执行成功后。
2. Git commit 后。
3. Git checkout 后（可配置）。
4. 周期增量扫描（防漏）。

更新流程：

1. 计算变更集（git diff + run artifacts）。
2. 增量解析受影响文件（AST + 引用关系）。
3. upsert 节点与边至 Graphify。
4. 生成模块/社区摘要索引。
5. 标记 graph version（例如 gv_<timestamp>_<hash>）。

### 6.4 上下文切片策略

采用三层召回：

1. L1: 当前任务直达节点（文件/符号）。
2. L2: 一跳依赖邻域。
3. L3: 相关历史决策与最近失败反馈。

预算策略：

1. 优先结构化摘要。
2. 再按需拉源码片段。
3. 超预算时保留接口签名、最近变更和失败证据。

## 7. 学习飞轮（越用越聪明）

### 7.1 原则

1. 优先优化“检索和路由策略”，而非在线重训主模型。
2. 周期离线训练 + 灰度发布，避免策略漂移。

### 7.2 1B 小模型定位

建议将 OpenBMB 1B 模型用于：

1. 复杂度分类（simple/complex）。
2. 子图候选重排（上下文最小有效子图）。
3. Validator 反馈压缩与标签化。
4. 多层摘要生成与更新。

### 7.3 训练数据回路

每次任务自动记录：

1. 任务 query。
2. 候选子图集合与最终选择。
3. 通过/打回标签与重试次数。
4. token/cost/latency。
5. 人工介入结果。

构建训练样本：

1. 正样本: 一次通过且低成本。
2. 负样本: 多次打回或高成本低收益。
3. 训练目标: pairwise ranking / policy scoring。

### 7.4 发布与回滚

1. 训练频率: nightly 或 weekly。
2. 发布策略: 10% canary。
3. 监控门槛:
- 一次通过率不下降。
- 平均 token 下降。
- 平均时延不显著上升。
4. 不达标自动回滚上个稳定策略模型。

## 8. 核心状态机

任务节点状态：

1. PENDING
2. RUNNING
3. VALIDATING
4. COMPLETED
5. FAILED
6. HUMAN_REVIEW_REQUIRED

转换规则：

1. PENDING -> RUNNING: 依赖满足。
2. RUNNING -> VALIDATING: Worker 产生结果。
3. VALIDATING -> COMPLETED: 校验通过。
4. VALIDATING -> RUNNING: 校验失败且未超重试阈值。
5. VALIDATING -> HUMAN_REVIEW_REQUIRED: 超阈值或风险等级过高。
6. 任意 -> FAILED: 系统异常不可恢复。

## 9. 关键配置

文件：graphflow.config.json

建议结构：

1. providers
- openai
- anthropic
- bailian
- doubao

2. tiers
- smart: [provider/model 链路]
- economy: [provider/model 链路]

3. roles
- planner -> smart
- validator -> smart
- worker -> economy

4. fallbackPolicy
- maxProviderRetry
- switchProviderOn
- cooldownSeconds

5. budgetPolicy
- runTokenCap
- runCostCap
- actionWhenExceeded

6. graphPolicy
- enableAutoBuild
- triggers
- maxContextTokens

7. learningPolicy
- enableFlywheel
- trainingCadence
- canaryRatio
- rollbackThresholds

## 10. 工程结构（v0.1）

```text
GraphFlow/
  src/
    core/
      orchestrator.ts
      dag-engine.ts
      triage.ts
      types.ts
    agents/
      planner.ts
      worker.ts
      validator.ts
      base-agent.ts
    routing/
      model-router.ts
      provider-adapters/
        openai.ts
        anthropic.ts
        bailian.ts
        doubao.ts
    graph/
      graphify-client.ts
      graph-indexer.ts
      context-slicer.ts
    learning/
      feedback-collector.ts
      sample-builder.ts
      canary-gate.ts
    surfaces/
      cli/
        index.ts
      vscode/
        extension.ts
    config/
      schema.ts
      loader.ts
  docs/
    superpowers/
      specs/
        2026-05-27-graphflow-dual-surface-design.md
```

## 11. 验收标准（可操作）

### 11.1 功能验收

1. 简单任务可单 Agent 执行并完成校验。
2. 复杂任务可自动生成 DAG 并并行执行任务包。
3. 每个任务节点都必须产出 validator 结果。
4. 模型路由按角色分层生效，且支持手动覆盖。
5. 四类供应商可通过统一配置接入并可切换。
6. 项目更新后图谱自动增量更新。
7. 执行阶段能从图谱检索上下文切片并遵守 token 预算。

### 11.2 性能与成本验收

1. 与无图谱基线相比，复杂任务平均上下文 token 降低 >= 30%。
2. 同复杂度任务下，一次通过率提升 >= 15%（或至少不下降）。
3. economy worker 并行时，单位任务平均成本低于 smart 全执行模式。

### 11.3 稳定性验收

1. 任一节点失败不导致全局死锁。
2. 重试超阈值后进入人工介入状态，流程可恢复。
3. 模型供应商不可用时 fallback 可自动切换。

## 12. 风险与应对

1. 风险: 图谱更新失败导致上下文缺失。
- 应对: 自动降级到 diff + 局部检索，并记录风险标签。

2. 风险: 小模型策略漂移导致召回退化。
- 应对: 离线评估 + canary + 自动回滚。

3. 风险: 多模型接口差异导致行为不一致。
- 应对: 强制统一 adapter contract + 合约测试。

## 13. 分期实施建议

1. Phase 1 (1-2 周)
- 建立核心 orchestrator、DAG 引擎、CLI 入口。
- 完成基础 model router 与单一供应商打通。

2. Phase 2 (1-2 周)
- 引入 VS Code 扩展入口。
- 接入 Graphify MCP，完成增量图谱更新与 context slicer。

3. Phase 3 (1-2 周)
- 接入多供应商适配与 fallback 策略。
- 完成 validator 闭环与人工介入状态。

4. Phase 4 (2 周)
- 上线学习飞轮数据管道、离线训练编排与 canary 机制。
- 完成全链路验收与基线对比报告。

## 14. 决策记录

1. 架构采用方案 B（分层内核 + 双入口）。
2. 路由采用混合模式（自动建议 + 用户覆盖）。
3. 模型采用多供应商可配置策略（OpenAI/Anthropic/百炼/豆包）。
4. 图谱采用 Graphify 对齐的增量更新方案。
5. 引入 1B 小模型用于检索与路由策略强化，不做在线主模型持续重训。
