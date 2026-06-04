import { logger } from "../utils/logger";
import type { TaskNode } from "../core/types";
import type { ModelSelection } from "../routing/model-router";
import { executeRolePrompt, type PromptContext } from "../routing/provider-executor";

function toNode(id: string, description: string, dependencies: string[]): TaskNode {
  return {
    id,
    description,
    dependencies,
    status: "PENDING",
    contextQuery: description,
    retryCount: 0,
  };
}

export function planTasks(task: string, skillHints?: string[]): TaskNode[] {
  const parts = task
    .split(/\band\b|,|;/i)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (parts.length <= 1) {
    return [toNode("task-1", withSkillHints(task.trim(), skillHints), [])];
  }

  const parallelTasks = parts.map((part, index) =>
    toNode(`task-${index + 1}`, withSkillHints(part, skillHints), [])
  );
  const finalTask = toNode(
    `task-${parts.length + 1}`,
    withSkillHints(`integrate and verify: ${parts.join("; ")}`, skillHints),
    parallelTasks.map((item) => item.id)
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
  const prompt = buildPlannerPrompt(task, options);
  let raw = "";
  try {
    raw = await executeRolePrompt("planner", prompt, options.selection, options.context);
  } catch (error) {
    logger.error({ error }, "Caught error");
    return planTasks(task, options.skillHints);
  }

  const parsed = parsePlannerJson(raw);
  if (!parsed || parsed.length === 0) {
    return planTasks(task, options.skillHints);
  }

  return parsed.slice(0, MAX_PLAN_NODES).map((item) =>
    toNode(item.id, withSkillHints(item.description, options.skillHints), item.dependencies)
  );
}

function buildPlannerPrompt(task: string, options: PlanTasksLlmOptions): string {
  const lines: string[] = [];
  lines.push("You are a task planner. Decompose the task into a small DAG.");
  lines.push("Return ONLY a JSON array of items shaped as {id, description, dependencies}.");
  lines.push("- id: short string like task-1");
  lines.push("- description: concrete actionable subtask");
  lines.push("- dependencies: array of ids this task depends on (may be empty)");
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
