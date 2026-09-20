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
  return (await tryBrainstormTaskLlm(task, selection, context)) ?? brainstormTask(task);
}

/**
 * Strict variant for callers that must distinguish real LLM ideas from the
 * local template fallback: resolves to null when the provider call throws,
 * the task is empty, or the reply yields no parsable idea lines. It never
 * rejects and never silently substitutes the heuristic ideas.
 */
export async function tryBrainstormTaskLlm(
  task: string,
  selection: ModelSelection,
  context?: PromptContext
): Promise<string[] | null> {
  const normalized = task.trim();
  if (!normalized) {
    return null;
  }

  const prompt = [
    "Brainstorm 3 short ideas in Chinese for the following task.",
    "Cover: 1) 目标澄清, 2) 实现路径, 3) 风险提示.",
    "Return each idea on its own line, no extra commentary.",
    `Task: ${normalized}`,
  ].join("\n");

  // One immediate retry (same rationale as tryPlanTasksLlm): an off-shape
  // reply on the first attempt should not force the template fallback.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw = "";
    try {
      // disableTools: same rationale as tryPlanTasksLlm — the tool-loop's
      // confirmation envelope would defeat idea-line parsing.
      raw = await executeRolePrompt("planner", prompt, selection, context, undefined, {
        disableTools: true,
      });
    } catch (error) {
      logger.error({ error, attempt }, "Caught error");
      continue;
    }

    const ideas = parseBrainstormIdeas(raw);
    if (ideas.length > 0) {
      return ideas.slice(0, MAX_BRAINSTORM_IDEAS);
    }
  }
  return null;
}

function parseBrainstormIdeas(raw: string): string[] {
  if (!raw) {
    return [];
  }

  // Some replies arrive as a confirmation envelope
  // {"ok":true,"summary":"1) …\n2) …"} — the ideas live inside `summary`.
  let text = raw;
  const envelope = text.match(/^\s*\{\s*"ok"\s*:\s*true\s*,\s*"summary"\s*:\s*"([\s\S]*)"\s*\}\s*$/);
  if (envelope?.[1]) {
    try {
      text = JSON.parse(`"${envelope[1]}"`);
    } catch {
      text = envelope[1];
    }
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("{"))
    .map((line) => line.replace(/^[-*•]\s*/, "").replace(/^\d+[\.\)、:：]\s*/, "").trim())
    .filter((line) => line.length > 0);
}
