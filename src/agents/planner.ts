import { logger } from "../utils/logger";
import type { TaskAcceptance, TaskNode } from "../core/types";
import type { ModelSelection } from "../routing/model-router";
import { executeRolePrompt, type PromptContext } from "../routing/provider-executor";
import { classifyTaskTemplate, splitTaskClauses } from "./task-clauses";
import { tokenizeTaskText, type RetrievedEpisode } from "./episode-retrieval";

export { looksLikeActionableTaskClause, splitTaskClauses } from "./task-clauses";

function toNode(
  id: string,
  description: string,
  dependencies: string[],
  skillHints?: string[],
  acceptance?: TaskAcceptance
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
  if (acceptance) {
    node.acceptance = acceptance;
  }
  return node;
}

/**
 * Generic verbs/articles that carry no retrieval signal: they appear in
 * almost every task text, so they must not end up in a --grep pattern or a
 * symbol-query assertion derived from the task.
 */
const GENERIC_TASK_TOKENS = new Set([
  "the", "a", "an", "and", "or", "in", "on", "of", "to", "for", "with", "without",
  "is", "are", "be", "that", "this", "it", "its", "into", "from", "by", "at", "as",
  "when", "should", "must", "not", "no", "we", "you", "use", "using",
  "add", "update", "fix", "fixes", "fixed", "implement", "create", "write", "build",
  "make", "remove", "delete", "refactor", "improve", "change", "support", "enable",
  "disable", "test", "tests", "bug", "error", "issue", "problem", "task", "please",
]);

/** CJK runs too generic to be distinctive in a grep/assertion string. */
const GENERIC_CJK_RUNS = new Set(["修复", "报错", "错误", "问题", "任务", "实现", "添加", "更新", "测试", "验证"]);

/** Max distinctive tokens folded into one derived command/assertion string. */
const MAX_DISTINCTIVE_TOKENS = 3;

/**
 * Distinctive tokens of a task text, in order of first appearance:
 * symbol-name-style ASCII tokens (camelCase/snake/kebab split, via
 * tokenizeTaskText) plus whole CJK runs (≥2 chars), with generic verbs and
 * articles filtered out. Used to derive suggestion-only --grep patterns and
 * graph-assertion queries — never executed automatically.
 */
export function deriveDistinctiveTokens(task: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (token: string) => {
    const trimmed = token.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  for (const token of tokenizeTaskText(task)) {
    if (token.length < 3) continue; // bigrams/single letters are noise for ASCII
    if (GENERIC_TASK_TOKENS.has(token)) continue;
    push(token);
  }
  // tokenizeTaskText emits CJK bigrams; whole CJK runs read better inside a
  // quoted grep/assertion string, so extract them directly as well.
  for (const run of task.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (GENERIC_CJK_RUNS.has(run)) continue;
    push(run);
  }
  return out.slice(0, MAX_DISTINCTIVE_TOKENS);
}

/**
 * Suggested regression command for the bugfix template: run the tests whose
 * names overlap the task's distinctive tokens. SUGGESTION ONLY — never
 * executed by the planner; the executing agent/human reviews it first.
 */
function deriveRegressionAcceptance(task: string): TaskAcceptance {
  const tokens = deriveDistinctiveTokens(task);
  const command = tokens.length > 0 ? `npm test -- --grep "${tokens.join(" ")}"` : "npm test";
  return {
    kind: "test",
    command,
    description: "Run the existing tests closest to this defect (suggested command — review before running).",
  };
}

/** Minimal acceptance for the default template's final verify node. */
function defaultVerifyAcceptance(): TaskAcceptance {
  return {
    kind: "test",
    command: "npm test",
    description: "Full test suite must pass after implementation.",
  };
}

/**
 * Symbol-query acceptance for the research template's citation-check node:
 * the analysis must be anchored to symbols that actually exist in the graph.
 */
function graphAssertionAcceptance(task: string): TaskAcceptance {
  const tokens = deriveDistinctiveTokens(task);
  const assertion = tokens.length > 0 ? tokens.join(" ") : task.trim();
  return {
    kind: "graph-assertion",
    assertion,
    description: "Cited code entities must resolve to ≥1 symbol in the code graph.",
  };
}

export function planTasks(task: string, skillHints?: string[]): TaskNode[] {
  const parts = splitTaskClauses(task);

  if (parts.length <= 1) {
    const baseTask = task.trim();
    // Task-profile template routing: multi-clause splitting stays authoritative
    // (checked above), a single intent is routed by its profile.
    const profile = classifyTaskTemplate(baseTask);

    if (profile === "research") {
      // Research/analysis: synthesis + citation-check template, no 实现 node.
      return [
        toNode("task-1", withSkillHints(`分析与综合: ${baseTask}`, skillHints), [], skillHints),
        toNode(
          "task-2",
          withSkillHints(`验证与引用核对: ${baseTask}`, skillHints),
          ["task-1"],
          skillHints,
          graphAssertionAcceptance(baseTask)
        ),
      ];
    }

    if (profile === "bugfix") {
      // Bug report: reproduce & locate → fix → regression chain.
      return [
        toNode("task-1", withSkillHints(`复现与定位: ${baseTask}`, skillHints), [], skillHints),
        toNode("task-2", withSkillHints(`修复实现: ${baseTask}`, skillHints), ["task-1"], skillHints),
        toNode(
          "task-3",
          withSkillHints(`回归验证: ${baseTask}`, skillHints),
          ["task-2"],
          skillHints,
          deriveRegressionAcceptance(baseTask)
        ),
      ];
    }

    return [
      toNode("task-1", withSkillHints(`分析与设计: ${baseTask}`, skillHints), [], skillHints),
      toNode("task-2", withSkillHints(`实现: ${baseTask}`, skillHints), ["task-1"], skillHints),
      toNode("task-2b", withSkillHints(`测试设计: ${baseTask}`, skillHints), ["task-1"], skillHints),
      toNode(
        "task-3",
        withSkillHints(`验证: ${baseTask}`, skillHints),
        ["task-2", "task-2b"],
        skillHints,
        defaultVerifyAcceptance()
      ),
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
  /** Similar past episodes injected into the prompt (case-based planning). */
  episodes?: RetrievedEpisode[];
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
        toNode(
          item.id,
          withSkillHints(item.description, options.skillHints),
          item.dependencies,
          options.skillHints,
          item.acceptance
        )
      );
    }
  }
  return null;
}

/**
 * Assemble the planner role prompt. Exported for tests and for callers that
 * need to inspect the exact prompt (e.g. verifying episode injection).
 */
export function buildPlannerPrompt(task: string, options: PlanTasksLlmOptions): string {
  const lines: string[] = [];
  lines.push("You are a task planner. Decompose the task into a small DAG.");
  lines.push("Return ONLY a JSON array of items shaped as {id, description, dependencies}.");
  lines.push("- id: short string like task-1");
  lines.push("- description: concrete actionable subtask");
  lines.push("- dependencies: array of ids this task depends on (may be empty)");
  lines.push(
    '- Optional: on verification nodes add "acceptance": {"kind": "test", "command": "<safe test-runner command>"} or {"kind": "graph-assertion", "assertion": "<symbol query string>"}. Skip when unsure.'
  );
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
  if (options.episodes && options.episodes.length > 0) {
    lines.push("Past episodes (similar tasks already executed in this project):");
    for (const episode of options.episodes) {
      const outcome = episode.success ? "pass" : "fail";
      const deviation = episode.deviation ? `, deviation=${episode.deviation}` : "";
      lines.push(`- [outcome=${outcome}${deviation}] task: ${episode.taskPreview}`);
      for (const lesson of episode.lessons.slice(0, 3)) {
        lines.push(`  lesson: ${truncateLesson(lesson)}`);
      }
    }
    lines.push(
      "Prefer steps that worked in passed episodes; avoid the recorded failure lessons when decomposing."
    );
  }
  return lines.join("\n");
}

const MAX_LESSON_CHARS = 200;

function truncateLesson(lesson: string): string {
  return lesson.length <= MAX_LESSON_CHARS ? lesson : `${lesson.slice(0, MAX_LESSON_CHARS - 3)}...`;
}

interface PlannerJsonItem {
  id: string;
  description: string;
  dependencies: string[];
  acceptance?: TaskAcceptance;
}

/**
 * Normalize an LLM-emitted `acceptance` field: keep it only when the shape is
 * usable (known kind + the kind's required payload non-empty), so malformed
 * extra fields never reach TaskNode.acceptance.
 */
function parseAcceptanceField(value: unknown): TaskAcceptance | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "test" && record.kind !== "graph-assertion") {
    return undefined;
  }
  const command = typeof record.command === "string" && record.command.trim() ? record.command.trim() : undefined;
  const assertion =
    typeof record.assertion === "string" && record.assertion.trim() ? record.assertion.trim() : undefined;
  const description =
    typeof record.description === "string" && record.description.trim() ? record.description.trim() : undefined;
  if (record.kind === "test" && !command) {
    return undefined;
  }
  if (record.kind === "graph-assertion" && !assertion) {
    return undefined;
  }
  return {
    kind: record.kind,
    ...(command ? { command } : {}),
    ...(assertion ? { assertion } : {}),
    ...(description ? { description } : {}),
  };
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
    const acceptance = parseAcceptanceField(record.acceptance);
    items.push({ id, description, dependencies, ...(acceptance ? { acceptance } : {}) });
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
