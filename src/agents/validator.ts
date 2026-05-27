import type { ValidationResult } from "../core/types";

export function validateTaskResult(task: string, workerOutput: string): ValidationResult {
  if (!task.trim()) {
    return {
      passed: false,
      feedback: "Task cannot be empty.",
    };
  }

  if (!workerOutput.trim()) {
    return {
      passed: false,
      feedback: "Worker output is empty.",
    };
  }

  return {
    passed: true,
    feedback: "Validation passed.",
  };
}
