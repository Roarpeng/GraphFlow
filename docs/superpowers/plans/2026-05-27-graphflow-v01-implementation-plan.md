# GraphFlow v0.1 实施计划

- 日期: 2026-05-27
- 关联设计: ../specs/2026-05-27-graphflow-dual-surface-design.md
- 目标版本: v0.1.0
- 实施原则: 小步快跑、每阶段可验收、可回滚

## 1. 范围与里程碑

### M1: 核心可运行（Engine Bootstrap）

目标：在 CLI 下跑通单任务执行闭环。

包含：

1. 项目初始化（TypeScript + lint + test）。
2. 核心类型与状态机。
3. 单任务 Worker + Validator 闭环（不含 DAG 并行）。
4. 基础 Model Router（smart/economy）。

交付物：

1. src/core/types.ts
2. src/core/state-machine.ts
3. src/agents/worker.ts
4. src/agents/validator.ts
5. src/routing/model-router.ts
6. src/surfaces/cli/index.ts

验收标准：

1. `graphflow run "update readme"` 可执行并输出 pass/fail。
2. 节点状态流转符合设计文档。
3. 至少 5 个单元测试通过。

---

### M2: 复杂任务编排（Plan + Package）

目标：跑通 Planner 生成 DAG，按依赖并行执行任务包。

包含：

1. Triage simple/complex 判定。
2. Planner 结构化输出 DAG。
3. DAG 调度器并发执行。
4. 每节点 Validator 校验与重试。

交付物：

1. src/core/triage.ts
2. src/agents/planner.ts
3. src/core/dag-engine.ts
4. src/core/orchestrator.ts

验收标准：

1. complex 输入可生成合法 DAG（含依赖与验收条件）。
2. 独立节点可并发执行，依赖节点不越序。
3. 重试超阈值进入 HUMAN_REVIEW_REQUIRED。

---

### M3: Graphify 知识图谱增量链路

目标：每次项目更新触发图谱增量更新，并在执行时裁剪上下文。

包含：

1. Graphify MCP client 接口封装。
2. git diff 增量解析器。
3. graph indexer upsert 节点与边。
4. context slicer 三层召回（L1/L2/L3）。

交付物：

1. src/graph/graphify-client.ts
2. src/graph/graph-indexer.ts
3. src/graph/context-slicer.ts
4. src/hooks/post-run-sync.ts

验收标准：

1. run 成功后自动触发图谱更新。
2. 能按任务 query 返回受 token 预算约束的上下文切片。
3. 图谱不可用时自动降级到 diff + 局部检索。

---

### M4: VS Code 双入口与多供应商适配

目标：实现 VS Code 扩展入口并打通四类供应商。

包含：

1. VS Code command 与运行视图。
2. ProviderAdapter 四实现：OpenAI/Anthropic/百炼/豆包。
3. fallback 策略与 provider 健康检查。

交付物：

1. src/surfaces/vscode/extension.ts
2. src/routing/provider-adapters/openai.ts
3. src/routing/provider-adapters/anthropic.ts
4. src/routing/provider-adapters/bailian.ts
5. src/routing/provider-adapters/doubao.ts

验收标准：

1. VS Code 中可触发 run 并查看节点状态。
2. 供应商切换不影响上层编排逻辑。
3. 主模型失败时可自动 fallback 到候选模型。

---

### M5: 学习飞轮最小闭环（策略层）

目标：上线“越用越聪明”最小版本，不在线重训主模型。

包含：

1. feedback collector 记录任务行为。
2. sample builder 生成排序训练样本。
3. canary gate 灰度策略发布与回滚开关。

交付物：

1. src/learning/feedback-collector.ts
2. src/learning/sample-builder.ts
3. src/learning/canary-gate.ts

验收标准：

1. 可生成训练样本集（含正负样本标签）。
2. 可按 canaryRatio 控制策略版本流量。
3. 指标不达标时触发自动回滚。

## 2. 工作分解结构（WBS）

### 2.1 初始化与工程约束

1. 初始化 Node + TypeScript。
2. 建立 eslint + prettier + vitest。
3. 定义代码规范与目录约束。

### 2.2 核心模型与协议

1. 定义 TaskNode、RunContext、ValidationResult。
2. 定义 ProviderAdapter 合约。
3. 定义 GraphifyClient 合约。

### 2.3 核心流程实现

1. run pipeline（simple）。
2. plan pipeline（complex）。
3. validate-retry pipeline。

### 2.4 外部集成

1. Graphify MCP。
2. Git hooks 与定时任务。
3. VS Code extension 命令入口。

### 2.5 质量保障

1. 单元测试。
2. 合约测试（provider adapter）。
3. 端到端测试（CLI 最小场景）。

## 3. 任务优先级与并行建议

P0（必须）：

1. M1 全部。
2. M2 的 triage/planner/dag-engine。
3. M3 的 graphify-client/context-slicer。

P1（高优先）：

1. M4 VS Code 入口。
2. M4 多供应商 fallback。

P2（增强）：

1. M5 学习飞轮闭环。
2. 可视化运行面板。

并行建议：

1. 线程 A: core + agents。
2. 线程 B: graph + context slicer。
3. 线程 C: providers + VS Code surface。

## 4. 配置与密钥策略

1. `graphflow.config.json` 存非敏感配置。
2. `.env` 存各供应商 API Key。
3. 启动时做配置校验，缺失项直接 fail fast。

必填配置（v0.1）：

1. providers.openai.apiKey (可选，若使用)
2. providers.anthropic.apiKey (可选，若使用)
3. providers.bailian.apiKey (可选，若使用)
4. providers.doubao.apiKey (可选，若使用)
5. tiers.smart
6. tiers.economy
7. budgetPolicy.runTokenCap

## 5. 验证计划

### 5.1 测试矩阵

1. simple run（单文件任务）。
2. complex run（多节点 DAG）。
3. validator 连续打回（重试与人工介入）。
4. 图谱服务不可用（降级路径）。
5. provider 主链路故障（fallback）。

### 5.2 指标采集

1. firstPassRate
2. avgContextTokens
3. avgRunCost
4. avgLatency
5. retryCount

## 6. 风险与应对

1. 风险：多供应商协议差异。
- 应对：统一 adapter contract + contract tests。

2. 风险：图谱更新延迟影响实时性。
- 应对：先返回旧版图谱 + 后台补齐增量。

3. 风险：学习策略上线导致性能回退。
- 应对：灰度 + 自动回滚阈值。

## 7. 2 周执行排期（建议）

第 1 周：

1. Day 1-2: M1。
2. Day 3-4: M2。
3. Day 5: M2 回归 + 文档。

第 2 周：

1. Day 1-2: M3。
2. Day 3-4: M4。
3. Day 5: 联调验收，形成 v0.1 RC。

## 8. 启动清单（下一步立刻执行）

1. 初始化 package.json、tsconfig、eslint、vitest。
2. 创建 src 目录骨架与核心类型文件。
3. 实现 CLI `graphflow run` 最小链路。
4. 添加 5 个最小单元测试并跑通。
5. 产出首个可运行 demo。
