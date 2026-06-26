export type TaskStatus =
  | "PENDING"
  | "RUNNING"
  | "VALIDATING"
  | "COMPLETED"
  | "FAILED"
  | "HUMAN_REVIEW_REQUIRED"
  | "DELEGATED";

export type AgentRole = "planner" | "worker" | "validator" | "enricher" | "evolver" | "compressor";

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
  };
}

export interface TaskNode {
  id: string;
  description: string;
  dependencies: string[];
  status: TaskStatus;
  contextQuery: string;
  retryCount: number;
}

export interface OrchestrationInput {
  task: string;
  maxRetries?: number;
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
