# GraphFlow 完整测试指南

## 快速开始

### 前置条件
1. 扩展已安装（GraphFlow 0.4.3+）
2. 没有 MiniCPM 模型也没关系，系统会自动回退到兼容模式

### 一键运行完整测试
```powershell
# 在工作区根目录运行
.\test-workflow.ps1
```

或在 macOS/Linux 上：
```bash
bash test-workflow.sh
```

或分步手动运行本指南中的命令。

---

## 分步详解

### 📘 第一步：建立知识库（图索引）

**命令**
```bash
npm run build
npx graphflow graph index .
```

**作用**
- 扫描当前工作区所有 .ts/.tsx/.js/.jsx/.md 文件
- 提取文件、符号、模块、任务等信息
- 建立关系图谱（dependencies, imports, exports）
- 生成 JSON 知识库文件

**输出解读**
```json
{
  "nodes": [
    { "id": "src/core/planner.ts", "type": "File", "contentPreview": "..." },
    { "id": "executeRolePrompt", "type": "Symbol", "parentId": "src/routing/provider-executor.ts", "complexity": 3 }
  ],
  "edges": [
    { "from": "src/surfaces/cli/index.ts", "to": "src/core/orchestrator.ts", "relation": "imports" }
  ]
}
```

- **nodes**：知识库中的实体（文件、符号、模块等）
- **edges**：实体之间的关系（导入、调用、继承等）
- **complexity**：符号复杂度（越高越需要压缩）

**你能看到的效果**
- 项目规模：多少个文件、符号、模块
- 关系密度：导入/导出连接数

---

### 📊 第二步：Context 预览（Token 节省展示）

**命令**
```bash
npx graphflow context preview "refactor planner module and add comprehensive error handling"
```

**作用**
- 根据查询 query 在知识库中找到相关代码
- 按照 token 预算压缩选中代码
- 展示"如果用全量知识库 vs 用压缩后"的 token 对比

**输出解读**

```
Context preview for: "refactor planner module and add comprehensive error handling"

Token budget:
- raw≈4821
- compressed=1840/16000
- saved≈61%
- anchors=24 (L1=6, L2=4, L3=14)

Summary (top 8 anchors):
- src/core/planner.ts: orchestrator that plans task decomposition
- src/core/dag-engine.ts: DAG execution with retry/circuit-break
- src/routing/provider-executor.ts: unified provider interface
- ...

Anchors by layer:
L1 (直接相关): 6 个核心文件/符号
L2 (间接相关): 4 个扩展依赖
L3 (远程相关): 14 个背景信息
```

**关键指标**
- **raw≈4821**：如果把所有相关代码都放进去，需要 ~4821 token
- **compressed=1840/16000**：压缩后只需 1840 token，预算上限 16000
- **saved≈61%**：节省了 61% 的 token 开销
- **L1/L2/L3 分层**：按相关性分层，确保最重要的信息优先保留

**你能看到的效果**
- 知识库是否被正确索引
- 压缩率是否合理（一般 50-70% 是正常的）
- 查询相关性是否符合预期

---

### 🧠 第三步：语义增强（Semantic Enrichment）

**命令**
```bash
npx graphflow graph enrich
```

**作用**
- 对每个 Symbol 节点调用 enricher 角色（小模型如 minicpm-1b）
- 生成中文摘要（或英文，取决于提示词）
- 补充到知识库中，后续 context 切片时使用这些摘要

**输出解读**
```
Enriching graph semantics...
[enricher] Batch 1/6: processing 5 symbols...
  - executeRolePrompt (provider-executor.ts): 封装了提示词+模型路由的核心入口...
  - openbmbGenerateText (openbmb.ts): openbmb 提供商的文本生成实现...
  - buildLayeredContextPackage (context-slicer.ts): 按相关性分层构建知识库切片...
[enricher] Batch 2/6: processing 5 symbols...
...
enrichedCount=48
```

**关键指标**
- **enrichedCount**：有多少个 Symbol 被补充了摘要
- **处理速度**：每批次处理的符号数、总批数

**你能看到的效果**
- 知识库中的符号现在有了"中文摘要"，后续查询时能更精准匹配
- 不需要真实模型，系统自动用 minicpm-1b 或回退模式

---

### 🔧 第四步：技能融合与演化

**命令**
```bash
npx graphflow learn nightly
```

**作用**
- 读取学习事件日志（tmp/learning-events.jsonl）
- 分析哪些技能（skill）最常被成功使用
- 进行技能融合：识别新的模式和关联
- 生成技能演化报告

**输出解读**
```json
{
  "trainingCadence": "nightly",
  "totalEventCount": 42,
  "successfulRuns": 28,
  "failedRuns": 14,
  "successRate": 0.667,
  "skills": [
    {
      "id": "skill:token-compression",
      "name": "token-compression",
      "score": 0.85,
      "uses": 12,
      "lastOutcome": "pass",
      "prerequisites": ["context-slicing", "layer-stratification"],
      "tripleComposites": [
        { "a": "context-slicing", "b": "semantic-enrichment", "c": "near-lossless" }
      ]
    },
    {
      "id": "skill:provider-routing",
      "name": "provider-routing",
      "score": 0.72,
      "uses": 8,
      "lastOutcome": "pass"
    }
  ],
  "skillEvolutionModel": "openbmb:minicpm-1b",
  "recommendedActions": [
    "提升 provider-routing 的 preset 配置，当前成功率偏低",
    "继续强化 token-compression 组合，效果稳定"
  ]
}
```

**关键指标**
- **score**：技能有效性评分（0-1）
- **uses**：被使用次数
- **successRate**：成功率
- **prerequisites**：技能前置依赖
- **tripleComposites**：三元融合（三个相关技能的组合模式）

**你能看到的效果**
- 系统会学到"什么时候用什么组合最有效"
- 后续任务编排会优先用高评分的技能组合

---

### 🎯 第五步：任务编排（Plan & Brainstorm）

**命令**
```bash
npx graphflow plan "optimize token compression for large codebases"
```

**作用**
- 接收任务描述
- brainstorm 角色生成多个实施思路
- planner 角色根据知识库和技能融合结果生成详细计划
- 分解为子任务、优先级、工作量估计

**输出解读**
```
Plan for: "optimize token compression for large codebases"

Brainstorm ideas:
1. 在 context-slicer.ts 中增加 lazy load 机制，避免大仓库一次性加载全图
2. 对 layer-stratification 算法优化，使用启发式而非贪心
3. 引入向量召回补充关键字召回，提升相关性
4. 并行化 context 切片，利用 worker_threads

Plan steps:
1. [ANALYZE] 分析当前 token 开销分布 (estimated 4h)
   - depends-on: Token compression 技能
   - owner: enricher
2. [DESIGN] 设计 lazy-load 与并行方案 (estimated 6h)
   - depends-on: 上一步
3. [IMPLEMENT] 改造 context-slicer.ts (estimated 16h)
   - parallelizable: step 2.1, 2.2
   - owner: worker
4. [VERIFY] 性能基准与回归测试 (estimated 8h)
   - testing: m23-graph-retrieval.test.ts, m8-token-compression.test.ts
```

**关键指标**
- **子任务分解**：有多少个步骤、依赖关系
- **时间估计**：每个步骤的工作量
- **技能映射**：每个步骤用到哪些已验证的技能
- **平行化**：可以并行做的任务

**你能看到的效果**
- 系统理解了当前代码库的关键技能
- 能够自动分解复杂任务，避免人工判断

---

### 📈 第六步：图检查（Graph Inspection）

**命令**
```bash
npx graphflow graph inspect
```

**作用**
- 导出知识库的样本快照
- 展示图的拓扑结构
- 可视化节点类型分布、顶层关系

**输出解读**
```json
{
  "transport": "file",
  "nodeCount": 1247,
  "edgeCount": 3841,
  "nodeTypeCount": {
    "File": 142,
    "Symbol": 892,
    "Module": 104,
    "TaskRun": 71,
    "Skill": 38
  },
  "topRelations": [
    { "relation": "imports", "count": 1240 },
    { "relation": "exports", "count": 318 },
    { "relation": "calls", "count": 1012 },
    { "relation": "prerequisite", "count": 113 }
  ],
  "sampleNodes": [...],
  "sampleEdges": [...]
}
```

**关键指标**
- **nodeCount / edgeCount**：知识库规模
- **nodeTypeCount**：各类型节点的分布
- **topRelations**：最常见的关系类型

---

## 扩展中的交互方式

### 命令面板
1. `GraphFlow: Run Task` - 完整任务执行流程
2. `GraphFlow: Plan & Brainstorm` - 任务规划
3. `GraphFlow: Context Preview` - 查看 token 预算
4. `GraphFlow: Enrich Graph Semantics` - 手动触发语义增强
5. `GraphFlow: Show Skills` - 查看技能评分

### Chat 中的 @graphflow 命令
```
@graphflow /plan optimize error handling in orchestrator

@graphflow /context search for worker thread implementations

@graphflow /graph show node count and relation distribution

@graphflow /skills show top 5 skills
```

---

## 完整理解

你现在看到的流程涵盖了 GraphFlow 的核心功能：

1. **知识库建立** = 图索引 → 理解项目结构
2. **Token 节省** = Context 压缩 → 用少得多的 token 表达相同信息
3. **语义增强** = 小模型补充摘要 → 提升查询精准性
4. **技能融合** = 学习什么组合最有效 → 优化未来决策
5. **任务编排** = 分解任务 + 技能应用 → 自动生成可行计划

这些都不需要真实的 MiniCPM 模型，系统会自动降级到兼容模式。

如果要用真实模型，参考前面的"模型获取"三种方式。
