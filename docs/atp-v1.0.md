# Agent Thinking Protocol (ATP) v1.0

> 本文档描述 GraphFlow v1.5.0+ 中集成的 **Agent Thinking Protocol v1.0** — 统一 Agent 在执行任务前的思考流程，使所有 Agent 遵循一致的推理过程，而不是直接生成答案。

## 设计目标

- **Intent First**：先理解真正目的，再规划
- **Facts Before Opinions**：先事实，后判断
- **Root Cause Over Symptoms**：优先解决根因，而非表象
- **Multiple Options Before Decision**：至少比较多个可行方案
- **Plan Before Execution**：先规划，再执行
- **Atomic Tasks**：任务应尽可能原子化、可验证、可复用
- **Reflection Driven Improvement**：通过反思不断优化规划质量

## 适用场景

- Requirement Analyzer
- Planner
- Task Decomposer
- Multi-Agent Communication
- Memory
- Reflection
- Workflow Engine

## 思考流程

```
User Request
     │
     ▼
Intent Analysis ──→ 理解显式/隐式意图、核心问题、非目标、成功标准
     │
     ▼
Requirement Analysis ──→ 结构化功能/非功能需求、优先级、范围
     │
     ▼
Context Collection ──→ 背景、资源、约束、历史信息
     │
     ▼
Six Thinking Hats ──→ 白(事实)、红(直觉)、黑(风险)、黄(价值)、绿(创新)、蓝(管理)
     │
     ▼
Five Whys ──→ 连续追问根因，最多 5 层
     │
     ▼
First Principles ──→ 拆解到不可再分事实，挑战假设
     │
     ▼
Decision Matrix ──→ 多方案按 5 维度打分比较
     │
     ▼
Planning ──→ 总体执行策略与阶段目标
     │
     ▼
Task Decomposition ──→ 原子化、可验证、可复用的任务
     │
     ▼
Reflection ──→ 对分析质量进行自我评估
     │
     ▼
Execution
```

## GraphFlow 实现映射

| ATP 阶段 | GraphFlow 实现 | 文件 |
|---|---|---|
| Intent Analysis | `analyzeIntent()` + `analyzeIntentHeuristic()` | `src/agents/insight.ts` |
| Requirement Analysis | `extractRequirements()` + `extractRequirementsHeuristic()` | `src/agents/insight.ts` |
| Context Collection | `preview_context` + graph compression | `src/graph/context-slicer.ts` |
| Six Thinking Hats | `analyzeWithSixHats()` | `src/agents/insight.ts` |
| Five Whys | `applyFiveWhys()` (certainty < 0.6 触发) | `src/agents/insight.ts` |
| First Principles | `applyFirstPrinciples()` + `applyFirstPrinciplesHeuristic()` | `src/agents/decision-engine.ts` |
| Decision Matrix | `evaluateOptions()` + `evaluateOptionsHeuristic()` | `src/agents/decision-engine.ts` |
| Planning | `buildPlanFromInsight()` | `src/agents/insight.ts` |
| Task Decomposition | `TaskNode[]` ( enriched with priority/complexity/verification ) | `src/core/types.ts` |
| Reflection | `reflectOnPlan()` + `reflectOnPlanHeuristic()` | `src/agents/insight.ts` |
| Execution | Bridge mode / DAG execution | `src/core/orchestrator.ts` |

## 启用方式

### MCP 工具

```bash
graphflow_plan_insight <task> [runFullAtp=true]
```

### CLI

```bash
npx graphflow plan "你的任务" --run-full-atp
```

### API

```typescript
import { planInsight } from "@roarpeng/graphflow";

const { insight, plan, atp } = await planInsight(task, options, true);
// atp: AgentThinkingProtocol 完整中间表示
```

## Agent Thinking Protocol 类型定义

详见 `src/agents/atp-schema.ts`：

- `IntentAnalysis` — 意图分析
- `RequirementAnalysis` — 需求分析
- `FirstPrinciplesAnalysis` — 第一性原理
- `DecisionMatrixOption` / `DecisionMatrixResult` — 决策矩阵
- `PlanReflection` — 反思
- `AgentThinkingProtocol` — 完整 IR

## JSON Schema

完整 JSON Schema 见下文。该协议既可作为单 Agent 的标准思考协议，也可作为 Multi-Agent 系统中 Planner、Coordinator、Executor、Reviewer 之间共享的统一中间表示（Intermediate Representation）。

```json
{
  "version": "1.0",
  "metadata": {
    "request_id": "",
    "timestamp": "",
    "language": "zh-CN",
    "source": "user",
    "planner": "Agent Thinking Protocol"
  },
  "intent": {
    "explicit_intent": "",
    "implicit_intent": "",
    "core_problem": "",
    "expected_result": "",
    "success_definition": "",
    "non_goals": [],
    "confidence": 0.95
  },
  "requirement": {
    "original_request": "",
    "interpreted_goal": "",
    "business_goal": "",
    "success_criteria": [],
    "priority": "High",
    "deadline": "",
    "scope": {
      "included": [],
      "excluded": []
    }
  },
  "context": {
    "background": "",
    "environment": [],
    "known_constraints": [],
    "available_resources": [],
    "stakeholders": [],
    "history": []
  },
  "six_thinking_hats": {
    "white": {
      "purpose": "Facts",
      "known": [],
      "unknown": [],
      "assumptions": [],
      "required_information": [],
      "evidence": []
    },
    "red": {
      "purpose": "Intuition",
      "user_intention": [],
      "implicit_goals": [],
      "concerns": [],
      "preferences": [],
      "confidence": 0.85
    },
    "black": {
      "purpose": "Risk",
      "technical_risks": [],
      "business_risks": [],
      "resource_constraints": [],
      "dependencies": [],
      "failure_modes": [],
      "worst_case": []
    },
    "yellow": {
      "purpose": "Value",
      "benefits": [],
      "opportunities": [],
      "expected_outcomes": [],
      "long_term_value": [],
      "roi": ""
    },
    "green": {
      "purpose": "Creativity",
      "alternative_solutions": [],
      "creative_ideas": [],
      "optimizations": [],
      "automation": [],
      "future_extensions": []
    },
    "blue": {
      "purpose": "Management",
      "summary": "",
      "planning_strategy": "",
      "decision": "",
      "next_actions": [],
      "review_points": [],
      "completion_definition": []
    }
  },
  "five_whys": {
    "analysis": [
      { "level": 1, "question": "", "answer": "", "reasoning": "", "evidence": "", "confidence": 0.95 },
      { "level": 2, "question": "", "answer": "", "reasoning": "", "evidence": "", "confidence": 0.92 },
      { "level": 3, "question": "", "answer": "", "reasoning": "", "evidence": "", "confidence": 0.90 },
      { "level": 4, "question": "", "answer": "", "reasoning": "", "evidence": "", "confidence": 0.87 },
      { "level": 5, "question": "", "answer": "", "reasoning": "", "evidence": "", "confidence": 0.85 }
    ],
    "root_problem": "",
    "root_cause": "",
    "recommended_focus": ""
  },
  "first_principles": {
    "fundamental_facts": [],
    "challenged_assumptions": [],
    "irreducible_constraints": [],
    "derived_principles": []
  },
  "decision_matrix": {
    "evaluation_criteria": ["Complexity", "Cost", "Performance", "Maintainability", "Scalability", "Risk"],
    "options": [
      {
        "name": "",
        "description": "",
        "pros": [],
        "cons": [],
        "score": 0
      }
    ],
    "recommended_option": ""
  },
  "planning": {
    "objective": "",
    "strategy": "",
    "milestones": [
      { "id": "M1", "name": "", "deliverable": "", "success_criteria": [] }
    ],
    "deliverables": [],
    "acceptance_criteria": [],
    "execution_order": []
  },
  "task_decomposition": [
    {
      "task_id": "T1",
      "parent_task": null,
      "name": "",
      "purpose": "",
      "description": "",
      "priority": 1,
      "complexity": "Medium",
      "estimated_time": "",
      "inputs": [],
      "outputs": [],
      "dependencies": [],
      "tools": [],
      "risks": [],
      "verification": [],
      "status": "Pending"
    }
  ],
  "reflection": {
    "confidence": 0.90,
    "uncertainties": [],
    "missing_information": [],
    "lessons_learned": [],
    "potential_improvements": [],
    "next_iteration_focus": []
  }
}
```

## 各模块职责

| 模块 | 作用 |
|---|---|
| Intent | 理解用户真正想解决的问题，而不是字面需求 |
| Requirement | 将自然语言转换为结构化目标 |
| Context | 收集背景、资源、约束、历史信息 |
| Six Thinking Hats | 从事实、直觉、风险、价值、创新、管理六个角度全面分析 |
| Five Whys | 连续追问问题根因，避免停留在表象 |
| First Principles | 拆解到不可再分的事实，验证基本假设 |
| Decision Matrix | 客观比较多个方案，选择最佳路径 |
| Planning | 制定总体执行策略与阶段目标 |
| Task Decomposition | 将计划拆分为可独立执行、可验证的任务 |
| Reflection | 对分析质量进行自我评估，为下一轮迭代提供依据 |

## 向后兼容

- `planInsight(task, options)` 不传第三参数时行为不变（原有的 Six Hats + 5-Why + DAG Plan）
- `planInsight(task, options, true)` 启用完整 ATP 8 阶段流程
- Agent 委托模式下 work items 从 13 个扩展到 18 个，submit/merge 闭环不变
