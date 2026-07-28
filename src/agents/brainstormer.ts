import { logger } from "../utils/logger";
import type { ModelSelection } from "../routing/model-router";
import { executeRolePrompt, type PromptContext } from "../routing/provider-executor";
import { splitTaskClauses } from "./task-clauses";

export function brainstormTask(task: string): string[] {
  const normalized = task.trim();
  if (!normalized) {
    return ["澄清目标: 任务描述不能为空"];
  }

  const clauses = splitTaskClauses(normalized);
  const focus = clauses.length > 1 ? clauses.slice(0, 3) : [normalized];
  const ideas = [
    `目标澄清: 明确要完成 ${focus.join("、")}`,
    `实现路径: 先拆分子任务并并行推进，再做集成校验`,
    `风险提示: 重点关注跨文件依赖和回归影响`,
  ];

  return ideas;
}

const MAX_BRAINSTORM_IDEAS = 6;

export async function brainstormTaskLlm(
  task: string,
  selection: ModelSelection,
  context?: PromptContext
): Promise<string[]> {
  const normalized = task.trim();
  if (!normalized) {
    return brainstormTask(task);
  }

  const prompt = [
    "Brainstorm 3 short ideas in Chinese for the following task.",
    "Cover: 1) 目标澄清, 2) 实现路径, 3) 风险提示.",
    "Return each idea on its own line, no extra commentary.",
    `Task: ${normalized}`,
  ].join("\n");

  let raw = "";
  try {
    raw = await executeRolePrompt("planner", prompt, selection, context);
  } catch (error) {
    logger.error({ error }, "Caught error");
    return brainstormTask(task);
  }

  const ideas = parseBrainstormIdeas(raw);
  if (ideas.length === 0) {
    return brainstormTask(task);
  }

  return ideas.slice(0, MAX_BRAINSTORM_IDEAS);
}

function parseBrainstormIdeas(raw: string): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[-*•]\s*/, "").replace(/^\d+[\.\)、:：]\s*/, "").trim())
    .filter((line) => line.length > 0);
}
