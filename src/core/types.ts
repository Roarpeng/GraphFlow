import type { GraphClient } from "../graph/client-factory.js";

export type TaskStatus =
  | "PENDING"
  | "RUNNING"
  | "VALIDATING"
  | "COMPLETED"
  | "FAILED"
  | "HUMAN_REVIEW_REQUIRED"
  | "DELEGATED";

export type AgentRole = "planner" | "worker" | "validator" | "compressor";

/**
 * Agent 专业领域类型，用于多 Agent 协作编排时标注建议的执行角色。
 * - frontend: 前端相关（ui/component/css/style）
 * - backend: 后端相关（api/server/database/model）
 * - testing: 测试相关（test/testing）
 * - docs: 文档相关（doc/readme/changelog）
 * - general: 通用任务（默认）
 */
export type AgentSpecialty = "frontend" | "backend" | "testing" | "docs" | "general";

export interface ValidationResult {
  passed: boolean;
  feedback: string;
  matchedCriteria: string[];
  missingCriteria: string[];
  riskTags: string[];
}

export interface RouteDecision {
  role: AgentRole;
  provider: string;
  model: string;
  tier: "smart" | "economy";
  fallbackApplied: boolean;
}

export interface TaskRunResult {
  status: TaskStatus;
  attempts: number;
  feedback: string;
  routeDecisions?: RouteDecision[];
  executionRounds?: string[][];
  validationSummary?: {
    matched: number;
    missing: number;
    riskTags: string[];
  };
  replanRounds?: number;
  brainstormIdeas?: string[];
  promptContextLines?: number;
  episodeId?: string;
  similarEpisodes?: Array<{ id: string; task: string; score: number }>;
  executionDescriptor?: {
    action: "execute";
    task: string;
    context: string;
    retryHints: string[];
    /** When no external LLM API is configured, prompts for the connected coding agent. */
    agentMode?: "delegated-llm";
    agentWorkItems?: Array<{
      id: string;
      kind: string;
      hat?: string;
      prompt: string;
      expectedFormat: string;
    }>;
    insightSummary?: string;
    /** 多 Agent 协作编排：每个任务节点建议的 agent 专业领域映射 */
    agentAssignments?: Array<{ taskId: string; specialty: AgentSpecialty }>;
  };
}

export interface TaskNode {
  id: string;
  description: string;
  dependencies: string[];
  status: TaskStatus;
  contextQuery: string;
  retryCount: number;
  /** 指定执行该节点的 agent 角色（AgentSpecialty），用于多 Agent 协作编排 */
  assignedAgent?: AgentSpecialty;
  /** ATP v1.0: 任务优先级 (1=最高) */
  priority?: number;
  /** ATP v1.0: 任务复杂度 */
  complexity?: "Low" | "Medium" | "High";
  /** ATP v1.0: 验收标准 */
  verification?: string[];
  /** ATP v1.0: 输入依赖 */
  inputs?: string[];
  /** ATP v1.0: 预期产出 */
  outputs?: string[];
  /** ATP v1.0: 风险标签 */
  risks?: string[];
}

export interface OrchestrationInput {
  task: string;
  maxRetries?: number;
}

export interface OrchestrateOptions {
  graphClient?: GraphClient;
  enableAutoGraphSync?: boolean;
  enableNearLosslessMode?: boolean;
  nearLosslessQuery?: string;
  maxContextTokens?: number;
  layerQuota?: { l1: number; l2: number; l3: number };
  onContextPackage?: (pkg: import("../graph/context-slicer").LayeredContextPackage) => void;
  providerHealth?: import("../routing/model-router").ProviderHealthMap;
  providerFallbackChain?: import("../routing/model-router").ProviderName[];
  enableSkillFlywheel?: boolean;
  skillHintsLimit?: number;
  /** 预置种子技能：在技能飞轮启用时，于 orchestrator 首次运行时写入常见工程技能基线（幂等）。 */
  enableSeedSkills?: boolean;
  enableLlmAgents?: boolean;
  enableDriftReplan?: boolean;
  maxReplanRounds?: number;
  enableGraphContextInPrompt?: boolean;
  enableEpisodicMemory?: boolean;
  enableLlmTriage?: boolean;
  embeddingProvider?: import("../learning/embeddings").EmbeddingProvider;
  configPath?: string;
  executionMode?: "bridge" | "llm";
  /** Enable zero-cost graph-structure compression (edge weights + PageRank). Default true. */
  enableGraphCompression?: boolean;
  /** Adaptively size the context token budget from task complexity. Auto-enabled for complex tasks unless false. */
  enableAdaptiveBudget?: boolean;
  /** Return module-level RepoMap overview when budget is tight. Default false. */
  enableRepoMapFallback?: boolean;
  /** Run Six Hats plan_insight before complex DAG planning. Default true for complex tasks. */
  enablePlanInsight?: boolean;
}

export interface GraphNode {
  id: string;
  type: "File" | "Symbol" | "Module" | "TaskRun" | "Decision" | "Skill";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation:
    | "defines"
    | "references"
    | "imports"
    | "depends_on"
    | "changes"
    | "validates"
    | "co_occurs"
    | "prerequisite"
    | "improves"
    | "conflicts_with"
    | "calls"
    | "inherits";
}
