import { logger } from "../utils/logger";
import type { ValidationResult } from "../core/types";
import type { ModelSelection } from "../routing/model-router";
import { executeRolePrompt, type PromptContext } from "../routing/provider-executor";

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

export async function validateTaskResultLlm(
  task: string,
  workerOutput: string,
  selection: ModelSelection,
  context?: PromptContext
): Promise<ValidationResult> {
  if (!task.trim() || !workerOutput.trim()) {
    return validateTaskResult(task, workerOutput);
  }

  const prompt = [
    "You are a strict validator. Decide if the worker output satisfies the task.",
    "Return ONLY a JSON object shaped as {passed, feedback, matchedCriteria, missingCriteria, riskTags}.",
    "- passed: boolean",
    "- feedback: short string explaining the decision",
    "- matchedCriteria, missingCriteria, riskTags: arrays of strings",
    `Task: ${task}`,
    `Worker output: ${workerOutput}`,
  ].join("\n");

  let raw = "";
  try {
    raw = await executeRolePrompt("validator", prompt, selection, context);
  } catch (error) {
    logger.error({ error }, "Caught error");
    return validateTaskResult(task, workerOutput);
  }

  const parsed = parseValidatorJson(raw);
  if (!parsed) {
    return validateTaskResult(task, workerOutput);
  }

  return parsed;
}

function parseValidatorJson(raw: string): ValidationResult | null {
  if (!raw) {
    return null;
  }

  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    logger.error({ error }, "Caught error");
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.passed !== "boolean") {
    return null;
  }

  const toStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

  return {
    passed: record.passed,
    feedback: typeof record.feedback === "string" ? record.feedback : "",
    matchedCriteria: toStringArray(record.matchedCriteria),
    missingCriteria: toStringArray(record.missingCriteria),
    riskTags: toStringArray(record.riskTags),
  };
}
