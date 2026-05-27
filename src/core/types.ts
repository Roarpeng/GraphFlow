export type TaskStatus =
  | "PENDING"
  | "RUNNING"
  | "VALIDATING"
  | "COMPLETED"
  | "FAILED"
  | "HUMAN_REVIEW_REQUIRED";

export type AgentRole = "planner" | "worker" | "validator";

export interface ValidationResult {
  passed: boolean;
  feedback: string;
}

export interface TaskRunResult {
  status: TaskStatus;
  attempts: number;
  feedback: string;
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
  type: "File" | "Symbol" | "Module" | "TaskRun" | "Decision";
  content: string;
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
    | "validates";
}
