import { logger } from "../utils/logger";
import type { TaskNode } from "../core/types";
import type { ModelSelection } from "../routing/model-router";
import { executeRolePrompt, type PromptContext } from "../routing/provider-executor";
import { splitTaskClauses } from "./task-clauses";

export { looksLikeActionableTaskClause, splitTaskClauses } from "./task-clauses";

function toNode(
  id: string,
  description: string,
  dependencies: string[],
  skillHints?: string[]
): TaskNode {
  const node: TaskNode = {
    id,
    description,
    dependencies,
    status: "PENDING",
    contextQuery: description,
    retryCount: 0,
  };
  const skillRefs = (skillHints ?? []).filter((s) => s.trim().length > 0);
  if (skillRefs.length > 0) {
    node.skillRefs = skillRefs;
  }
  return node;
}

export function planTasks(task: string, skillHints?: string[]): TaskNode[] {
  const parts = splitTaskClauses(task);

  if (parts.length <= 1) {
    const baseTask = task.trim();
    return [
      toNode("task-1", withSkillHints(`分析与设计: ${baseTask}`, skillHints), [], skillHints),
      toNode("task-2", withSkillHints(`实现: ${baseTask}`, skillHints), ["task-1"], skillHints),
      toNode("task-2b", withSkillHints(`测试设计: ${baseTask}`, skillHints), ["task-1"], skillHints),
      toNode("task-3", withSkillHints(`验证: ${baseTask}`, skillHints), ["task-2", "task-2b"], skillHints),
    ];
  }

  const parallelTasks = parts.map((part, index) =>
    toNode(`task-${index + 1}`, withSkillHints(part, skillHints), [], skillHints)
  );
  const finalTask = toNode(
    `task-${parts.length + 1}`,
    withSkillHints(`integrate and verify: ${parts.join("; ")}`, skillHints),
    parallelTasks.map((item) => item.id),
    skillHints
  );

  return [...parallelTasks, finalTask];
}

function withSkillHints(task: string, skillHints?: string[]): string {
  if (!skillHints || skillHints.length === 0) {
    return task;
  }

  return `${task} | use skills: ${skillHints.join(", ")}`;
}

export interface PlanTasksLlmOptions {
  selection: ModelSelection;
  skillHints?: string[];
  brainstormIdeas?: string[];
  previousPlan?: TaskNode[];
  failureFeedback?: string;
  context?: PromptContext;
}

const MAX_PLAN_NODES = 8;

export async function planTasksLlm(task: string, options: PlanTasksLlmOptions): Promise<TaskNode[]> {
  const nodes = await tryPlanTasksLlm(task, options);
  return nodes ?? planTasks(task, options.skillHints);
}

/**
 * Strict variant for callers that must distinguish a real LLM-produced plan
 * from the local template fallback: resolves to null whenever the provider
 * call throws, or the reply does not parse into at least one task node.
 * It never rejects and never silently substitutes the heuristic template.
 */
export async function tryPlanTasksLlm(
  task: string,
  options: PlanTasksLlmOptions
): Promise<TaskNode[] | null> {
  const prompt = buildPlannerPrompt(task, options);
  // One immediate retry on a failed/unparseable attempt: fast models
  // occasionally return an off-shape reply (observed ~1/3 of calls with
  // deepseek-v4-flash — e.g. a bare {"ok":true} instead of the array); the
  // second attempt lands within the same latency budget and makes the flake
  // a rare event instead of a guaranteed template fallback.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw = "";
    try {
      // disableTools: pure text decomposition needs no provider tools, and
      // the deepseek tool-loop wraps plain replies in a {"ok":true,...}
      // confirmation envelope that defeats JSON-array parsing.
      raw = await executeRolePrompt("planner", prompt, options.selection, options.context, undefined, {
        disableTools: true,
      });
    } catch (error) {
      logger.error({ error, attempt }, "Caught error");
      continue;
    }

    const parsed = parsePlannerJson(raw);
    if (parsed && parsed.length > 0) {
      return parsed.slice(0, MAX_PLAN_NODES).map((item) =>
        toNode(item.id, withSkillHints(item.description, options.skillHints), item.dependencies, options.skillHints)
      );
    }
  }
  return null;
}

function buildPlannerPrompt(task: string, options: PlanTasksLlmOptions): string {
  const lines: string[] = [];
  lines.push("You are a task planner. Decompose the task into a small DAG.");
  lines.push("Return ONLY a JSON array of items shaped as {id, description, dependencies}.");
  lines.push("- id: short string like task-1");
  lines.push("- description: concrete actionable subtask");
  lines.push("- dependencies: array of ids this task depends on (may be empty)");
  lines.push(
    "- Do NOT split a single analytical request into noun-phrase dimensions listed after a colon (e.g. assumptions, failure modes)."
  );
  lines.push(`Task: ${task}`);
  if (options.skillHints && options.skillHints.length > 0) {
    lines.push(`Skill hints: ${options.skillHints.join(", ")}`);
  }
  if (options.brainstormIdeas && options.brainstormIdeas.length > 0) {
    lines.push(`Brainstorm ideas: ${options.brainstormIdeas.join(" | ")}`);
  }
  if (options.previousPlan && options.previousPlan.length > 0) {
    const projection = options.previousPlan.map((node) => ({
      id: node.id,
      description: node.description,
      dependencies: node.dependencies,
    }));
    lines.push(`Previous plan: ${JSON.stringify(projection)}`);
  }
  if (options.failureFeedback) {
    lines.push(`Previous failure feedback: ${options.failureFeedback}`);
    lines.push("Revise the plan to address the failures. Avoid repeating failing steps verbatim.");
  }
  return lines.join("\n");
}

interface PlannerJsonItem {
  id: string;
  description: string;
  dependencies: string[];
}

function parsePlannerJson(raw: string): PlannerJsonItem[] | null {
  if (!raw) {
    return null;
  }

  let text = raw.trim();
  text = stripCodeFences(text);
  const jsonBlock = extractFirstJsonArray(text);
  if (!jsonBlock) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (error) {
    logger.error({ error }, "Caught error");
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const items: PlannerJsonItem[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const entry = parsed[index];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : `task-${index + 1}`;
    const description = typeof record.description === "string" ? record.description.trim() : "";
    if (!description) {
      continue;
    }
    const dependenciesRaw = record.dependencies;
    const dependencies = Array.isArray(dependenciesRaw)
      ? dependenciesRaw.filter((dep): dep is string => typeof dep === "string")
      : [];
    items.push({ id, description, dependencies });
  }

  return items.length > 0 ? items : null;
}

function stripCodeFences(text: string): string {
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }
  return text;
}

function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}
