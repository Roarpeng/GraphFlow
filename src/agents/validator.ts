import type { ValidationResult } from "../core/types";

export function validateTaskResult(task: string, workerOutput: string): ValidationResult {
  if (!task.trim()) {
    return {
      passed: false,
      feedback: "Task cannot be empty.",
      matchedCriteria: [],
      missingCriteria: ["task"],
      riskTags: ["invalid_input"],
    };
  }

  if (!workerOutput.trim()) {
    return {
      passed: false,
      feedback: "Worker output is empty.",
      matchedCriteria: [],
      missingCriteria: extractCriteria(task),
      riskTags: ["empty_output"],
    };
  }

  const criteria = extractCriteria(task);
  const matchedCriteria = criteria.filter((criterion) => matchesCriterion(criterion, workerOutput));
  const missingCriteria = criteria.filter((criterion) => !matchedCriteria.includes(criterion));

  if (missingCriteria.length > 0) {
    return {
      passed: false,
      feedback: `Validation failed: missing criteria -> ${missingCriteria.join(", ")}`,
      matchedCriteria,
      missingCriteria,
      riskTags: ["criteria_mismatch"],
    };
  }

  return {
    passed: true,
    feedback: `Validation passed: matched ${matchedCriteria.length}/${criteria.length} criteria.`,
    matchedCriteria,
    missingCriteria: [],
    riskTags: [],
  };
}

function extractCriteria(task: string): string[] {
  const parts = task
    .split(/\band\b|,|;/i)
    .map((item) => item.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts : [task.trim()];
}

function matchesCriterion(criterion: string, output: string): boolean {
  const criterionLower = criterion.toLowerCase();
  const outputLower = output.toLowerCase();

  if (outputLower.includes(criterionLower)) {
    return true;
  }

  const tokens = criterionLower
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9_/.-]/g, ""))
    .filter((token) => token.length >= 4);

  if (tokens.length === 0) {
    return false;
  }

  return tokens.every((token) => outputLower.includes(token));
}
