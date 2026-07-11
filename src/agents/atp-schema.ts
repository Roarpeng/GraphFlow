// 阶段1: 意图分析
export interface IntentAnalysis {
  explicitIntent: string;      // 用户明确表达的意图
  implicitIntent: string;      // 用户隐含的真实需求
  coreProblem: string;          // 核心问题定义
  nonGoals: string[];           // 非目标（不做什么）
  successDefinition: string;    // 成功标准定义
}

// 阶段2: 需求分析
export interface RequirementAnalysis {
  functional: string[];         // 功能性需求
  nonFunctional: string[];      // 非功能性需求
  constraints: string[];        // 已知约束
  priority: "Low" | "Medium" | "High" | "Critical";
  scope: {
    included: string[];         // 范围内
    excluded: string[];         // 范围外
  };
}

// 阶段6: 第一性原理
export interface FirstPrinciplesAnalysis {
  assumptions: string[];        // 当前假设
  facts: string[];              // 不可再分的基本事实
  deconstructedTo: string[];    // 问题被拆解到的基本元素
  challenges: string[];         // 对假设的挑战
}

// 阶段7: 决策矩阵
export interface DecisionMatrixOption {
  name: string;
  description: string;
  scores: {
    complexity: number;         // 1-10, 越低越好
    cost: number;               // 1-10, 越低越好
    risk: number;               // 1-10, 越低越好
    maintainability: number;    // 1-10, 越高越好
    impact: number;             // 1-10, 越高越好
  };
  pros: string[];
  cons: string[];
}

export interface DecisionMatrixResult {
  options: DecisionMatrixOption[];
  recommendedOption: string;
  rationale: string;
}

// 阶段10: 反思
export interface PlanReflection {
  confidence: number;           // 0.0-1.0
  uncertainties: string[];
  missingInformation: string[];
  improvementDirections: string[];
}

// 完整 ATP 中间表示
export interface AgentThinkingProtocol {
  task: string;
  intent: IntentAnalysis;
  requirements: RequirementAnalysis;
  sixHatsInsight: import("./insight").SixHatsInsight;
  firstPrinciples: FirstPrinciplesAnalysis;
  decisionMatrix: DecisionMatrixResult;
  plan: import("../core/types").TaskNode[];
  reflection: PlanReflection;
}
