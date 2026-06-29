import { logger } from "../utils/logger";
import type { ModelSelection } from "../routing/model-router";
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

/** triage 决策的原因说明，用于准确率数据收集与启发式后续优化 */
export interface TriageReason {
  /** 命中的复杂度关键词（来自 COMPLEX_HINTS） */
  matchedKeywords: string[];
  /** 任务文本长度 */
  taskLength: number;
  /** 触发 complex 的判定来源 */
  triggeredBy: "length" | "keywords" | "both" | "default";
  /** 是否经由 LLM triage 得出（heuristic 路径为 false/undefined） */
  llmBased?: boolean;
}

export interface TriageExplanation {
  decision: TaskComplexity;
  reason: TriageReason;
}

/**
 * 带原因说明的 triage 启发式判定。
 * 既返回 simple/complex 决策，也返回匹配到的关键词、任务长度与触发来源，
 * 供 triage 准确率数据收集使用。
 */
export function triageTaskExplain(task: string): TriageExplanation {
  const normalized = task.toLowerCase();
  const matchedKeywords = COMPLEX_HINTS.filter((hint) => normalized.includes(hint));
  const longEnough = task.length > 80;
  const keywordHit = matchedKeywords.length >= 2;
  const isComplex = longEnough || keywordHit;

  let triggeredBy: TriageReason["triggeredBy"] = "default";
  if (longEnough && keywordHit) triggeredBy = "both";
  else if (longEnough) triggeredBy = "length";
  else if (keywordHit) triggeredBy = "keywords";

  return {
    decision: isComplex ? "complex" : "simple",
    reason: { matchedKeywords, taskLength: task.length, triggeredBy },
  };
}

export function triageTask(task: string): TaskComplexity {
  return triageTaskExplain(task).decision;
}

export async function triageTaskLlm(
  task: string,
  selection: ModelSelection,
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
    const raw = await executeRolePrompt("planner", prompt, selection, context);
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
