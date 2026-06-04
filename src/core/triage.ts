import { logger } from "../utils/logger";
import { executeRolePrompt, type PromptContext } from "../routing/provider-executor";

export type TaskComplexity = "simple" | "complex";

const COMPLEX_HINTS = [
  "multi",
  "across",
  "refactor",
  "architecture",
  "module",
  "parallel",
  "dag",
  "graph",
  "and",
];

export function triageTask(task: string): TaskComplexity {
  const normalized = task.toLowerCase();
  const hitCount = COMPLEX_HINTS.filter((hint) => normalized.includes(hint)).length;

  if (task.length > 80 || hitCount >= 2) {
    return "complex";
  }

  return "simple";
}

export async function triageTaskLlm(
  task: string,
  selection: { provider: string; model: string },
  context?: PromptContext
): Promise<TaskComplexity> {
  if (!task.trim()) {
    return "simple";
  }

  const prompt = [
    "You are an expert triage model. Classify the user task into 'simple' or 'complex'.",
    "A 'simple' task is small, localized, straight-forward, or low-risk (e.g. single file edit, simple print).",
    "A 'complex' task involves multiple files, architecture changes, parallel coordination, or high risk.",
    "Respond with exactly one word: 'simple' or 'complex'. Do not add punctuation or explanation.",
    `Task: ${task}`,
  ].join("\n");

  try {
    const raw = await executeRolePrompt("planner", prompt, selection as any, context);
    const cleaned = raw.trim().toLowerCase();

    if (
      cleaned.includes("[openbmb:") ||
      cleaned.includes("[openai:") ||
      (cleaned.includes("simple") && cleaned.includes("complex"))
    ) {
      return triageTask(task);
    }

    if (cleaned.includes("complex")) {
      return "complex";
    }
    if (cleaned.includes("simple")) {
      return "simple";
    }

    return triageTask(task);
  } catch (error) {
    logger.error({ error }, "Caught error");
    return triageTask(task);
  }
}
