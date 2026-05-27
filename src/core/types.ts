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
