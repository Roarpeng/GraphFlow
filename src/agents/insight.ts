/**
 * Six Thinking Hats + Five Whys Insight Engine.
 *
 * Borrowed from Edward de Bono's "Six Thinking Hats" framework —
 * before planning a task, analyze it through 6 distinct perspectives,
 * and auto-apply 5-level Why chains to key observations that fall
 * below a confidence threshold.
 *
 * The 5 Why triggers are automatic: whenever a hat produces an
 * observation with low certainty (< 0.6), the chain is applied to
 * drill toward root cause.
 */

import type { TaskNode } from "../core/types";
import type { ModelSelection } from "../routing/model-router";
import { executeRolePrompt, type PromptContext } from "../routing/provider-executor";
import { logger } from "../utils/logger";

/** === Hat Definitions === */

export interface HatDefinition {
  name: string;
  color: "white" | "red" | "black" | "yellow" | "green" | "blue";
  role: string;
  focus: string;
  question: string;
  whyFocus: string;
  whyRootFocus: string;
}

export const SIX_HATS: HatDefinition[] = [
  {
    name: "White Hat",
    color: "white",
    role: "客观分析者",
    focus: "事实与数据",
    question: "我们目前有哪些事实和数据？还缺少什么信息？",
    whyFocus: "为什么这个事实/数据是相关的？",
    whyRootFocus: "这个事实反映了什么系统性问题？",
  },
  {
    name: "Red Hat",
    color: "red",
    role: "情感体验者",
    focus: "直觉与情感",
    question: "我对这个方案的第一直觉和感受是什么？有哪些隐藏的情绪信号？",
    whyFocus: "为什么我有这个直觉？是什么经历或预感在驱动？",
    whyRootFocus: "这个情感背后的核心需求或恐惧是什么？",
  },
  {
    name: "Black Hat",
    color: "black",
    role: "风险评估者",
    focus: "谨慎与批判",
    question: "这个计划哪里可能会失败？有哪些潜在风险和逻辑漏洞？",
    whyFocus: "为什么这个问题会导致计划失败？它的严重程度如何？",
    whyRootFocus: "这个缺陷揭示了什么系统性弱点？",
  },
  {
    name: "Yellow Hat",
    color: "yellow",
    role: "价值发现者",
    focus: "乐观与收益",
    question: "这个想法的核心价值是什么？它为什么能起作用？",
    whyFocus: "为什么这个价值对目标受众重要？",
    whyRootFocus: "这个价值满足了什么更深层的人的需求？",
  },
  {
    name: "Green Hat",
    color: "green",
    role: "创新探索者",
    focus: "创造力与备选",
    question: "我们还有其他不同的解决路径吗？有哪些打破常规的想法？",
    whyFocus: "为什么这个替代方案目前没有被选择？有什么阻力？",
    whyRootFocus: "什么思维框架限制了我们看到更多选项？",
  },
  {
    name: "Blue Hat",
    color: "blue",
    role: "过程管理者",
    focus: "全局与协调",
    question: "我们的问题定义是否清晰？哪些帽子还需要深入分析？",
    whyFocus: "为什么当前的思考过程需要这个调整？",
    whyRootFocus: "我们真正需要解决的核心问题是什么？",
  },
];

/** === Five Whys Chain === */

export interface WhyStep {
  level: 1 | 2 | 3 | 4 | 5;
  question: string;
  answer: string;
  certainty: number; // 0-1, lower = more uncertain = trigger recursive why
}

export interface FiveWhyResult {
  initialObservation: string;
  certainty: number; // 0-1
  steps: WhyStep[];
  rootCause: string;
}

export interface WhyChainSection {
  hat: HatDefinition;
  /** Key observation produced by this hat */
  observation: string;
  certainty: number;
  /** 5-level why chain (only non-trivial ones are expanded) */
  whyChain: FiveWhyResult | null;
  /** Critical findings that should influence the plan */
  criticalInsight: string;
}

/** === Six Hats Analysis Result === */

export interface SixHatsInsight {
  task: string;
  hats: WhyChainSection[];
  blueHatSynthesis: string;
  rootCauses: string[];
  criticalRisks: string[];
  coreValue: string;
  refinedTaskStatement: string;
}

/** === Main Entry Points === */

export interface PlanInsightOptions {
  selection: ModelSelection;
  context?: PromptContext;
}

/**
 * Run the full Six Thinking Hats + Five Whys analysis on a task,
 * then generate a DAG-style plan that incorporates the insights.
 *
 * @param task The task to analyze
 * @param options Model selection and context options
 */
export async function planInsight(
  task: string,
  options: PlanInsightOptions
): Promise<{
  insight: SixHatsInsight;
  plan: TaskNode[];
}> {
  const insight = await analyzeWithSixHats(task, options);
  const plan = await buildPlanFromInsight(task, insight, options);
  return { insight, plan };
}

/**
 * Run the Six Thinking Hats analysis with automatic 5 Why triggers.
 *
 * Each hat produces an observation. If the observation's certainty
 * is below THRESHOLD (0.6), a 5 Why chain is automatically applied.
 */
export async function analyzeWithSixHats(
  task: string,
  options: PlanInsightOptions
): Promise<SixHatsInsight> {
  const hatResults: WhyChainSection[] = [];

  for (const hat of SIX_HATS) {
    const section = await analyzeSingleHat(task, hat, options);
    hatResults.push(section);
  }

  const blueSynthesis = hatResults.find((h) => h.hat.color === "blue")?.criticalInsight ?? "";
  const rootCauses = hatResults
    .filter((h) => h.whyChain !== null)
    .map((h) => h.whyChain!.rootCause)
    .filter((s) => s.length > 0);
  const criticalRisks = hatResults
    .filter((h) => h.hat.color === "black")
    .map((h) => h.observation)
    .filter((s) => s.length > 0);
  const coreValue = hatResults
    .filter((h) => h.hat.color === "yellow")
    .map((h) => h.observation)
    .join("; ");

  // Refined task statement from Blue Hat synthesis
  const refinedTaskStatement = buildRefinedStatement(task, hatResults);

  return {
    task,
    hats: hatResults,
    blueHatSynthesis: blueSynthesis,
    rootCauses: [...new Set(rootCauses)],
    criticalRisks,
    coreValue,
    refinedTaskStatement,
  };
}

/**
 * Rule-based Six Hats analysis without LLM calls.
 * Used when no API is configured — paired with agent work items for the connected agent.
 */
export function analyzeWithSixHatsHeuristic(task: string): SixHatsInsight {
  const hatResults: WhyChainSection[] = SIX_HATS.map((hat) => {
    const parsed = fallbackHatResponse(hat);
    return {
      hat,
      observation: parsed.observation,
      certainty: parsed.certainty,
      whyChain: null,
      criticalInsight: parsed.criticalInsight,
    };
  });

  const blueSynthesis = hatResults.find((h) => h.hat.color === "blue")?.criticalInsight ?? "";
  const rootCauses = hatResults
    .filter((h) => h.whyChain !== null)
    .map((h) => h.whyChain!.rootCause)
    .filter((s) => s.length > 0);
  const criticalRisks = hatResults
    .filter((h) => h.hat.color === "black")
    .map((h) => h.observation)
    .filter((s) => s.length > 0);
  const coreValue = hatResults
    .filter((h) => h.hat.color === "yellow")
    .map((h) => h.observation)
    .join("; ");

  return {
    task,
    hats: hatResults,
    blueHatSynthesis: blueSynthesis,
    rootCauses: [...new Set(rootCauses)],
    criticalRisks,
    coreValue,
    refinedTaskStatement: buildRefinedStatement(task, hatResults),
  };
}

const CERTAINTY_THRESHOLD = 0.6;

async function analyzeSingleHat(
  task: string,
  hat: HatDefinition,
  options: PlanInsightOptions
): Promise<WhyChainSection> {
  const prompt = buildHatPrompt(task, hat);
  let raw = "";
  try {
    raw = await executeRolePrompt("planner", prompt, options.selection, options.context);
  } catch (error) {
    logger.warn({ error, hat: hat.name }, "Hat analysis failed, using fallback");
  }

  const parsed = parseHatResponse(raw, hat);
  const whyChain: FiveWhyResult | null =
    parsed.certainty < CERTAINTY_THRESHOLD
      ? await applyFiveWhys(parsed.observation, hat, options)
      : null;

  return {
    hat,
    observation: parsed.observation,
    certainty: parsed.certainty,
    whyChain,
    criticalInsight: buildCriticalInsight(hat, parsed, whyChain),
  };
}

function buildHatPrompt(task: string, hat: HatDefinition): string {
  return buildHatAnalysisPrompt(task, hat);
}

/** Exported for agent-delegation work items (connected coding agent fills these prompts). */
export function buildHatAnalysisPrompt(task: string, hat: HatDefinition): string {
  return [
    `Task: ${task}`,
    ``,
    `You are wearing the ${hat.name} (${hat.role}).`,
    `Perspective: ${hat.focus}`,
    ``,
    `Your job:`,
    `1. Produce ONE key observation about this task from your ${hat.name} perspective.`,
    `2. Rate your certainty about this observation (0.0 = pure speculation, 1.0 = hard fact).`,
    `3. State the most critical insight this hat contributes to understanding the task.`,
    ``,
    `Return ONLY a JSON object:`,
    `{`,
    `  "observation": "your single most important observation from this hat's perspective",`,
    `  "certainty": 0.0-1.0,`,
    `  "criticalInsight": "what this hat tells us about the task"`,
    `}`,
    ``,
    `Example for Black Hat analyzing "add rust indexer":`,
    `{`,
    `  "observation": "Tree-sitter WASM grammars are platform-specific and may fail on ARM Windows",`,
    `  "certainty": 0.7,`,
    `  "criticalInsight": "Binary compatibility risk: tree-sitter WASM files must be downloaded per-platform"`,
    `}`,
  ].join("\n");
}

interface HatResponse {
  observation: string;
  certainty: number;
  criticalInsight: string;
}

function parseHatResponse(raw: string, hat: HatDefinition): HatResponse {
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    return fallbackHatResponse(hat);
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    return {
      observation:
        typeof parsed.observation === "string" ? parsed.observation.trim() : fallbackObs(hat),
      certainty:
        typeof parsed.certainty === "number"
          ? Math.max(0, Math.min(1, parsed.certainty))
          : 0.5,
      criticalInsight:
        typeof parsed.criticalInsight === "string"
          ? parsed.criticalInsight.trim()
          : fallbackInsight(hat),
    };
  } catch {
    return fallbackHatResponse(hat);
  }
}

function fallbackHatResponse(hat: HatDefinition): HatResponse {
  return {
    observation: fallbackObs(hat),
    certainty: 0.5,
    criticalInsight: fallbackInsight(hat),
  };
}

function fallbackObs(hat: HatDefinition): string {
  const fallbacks: Record<string, string> = {
    white: "缺乏足够的客观数据支持决策",
    red: "直觉上感觉这个方向有潜力但不确定",
    black: "存在未评估的潜在风险",
    yellow: "如果成功，收益显著",
    green: "可能存在未被探索的替代路径",
    blue: "需要先明确问题的本质",
  };
  return fallbacks[hat.color] ?? "无法从该视角得出有效观察";
}

function fallbackInsight(hat: HatDefinition): string {
  const insights: Record<string, string> = {
    white: "需要收集更多事实数据",
    red: "情感信号需要进一步验证",
    black: "风险需要被主动管理",
    yellow: "价值潜力需要被量化",
    green: "需要头脑风暴更多选项",
    blue: "思考过程需要被协调控制",
  };
  return insights[hat.color] ?? "该视角提供了有限的洞察";
}

async function applyFiveWhys(
  observation: string,
  hat: HatDefinition,
  options: PlanInsightOptions
): Promise<FiveWhyResult> {
  const steps: WhyStep[] = [];
  let currentObservation = observation;
  const question = hat.whyFocus;
  const rootFocus = hat.whyRootFocus;

  for (let level = 1; level <= 5; level++) {
    const whyQuestion =
      level === 5
        ? `最终 Why (收敛到根本): ${rootFocus}\nObservation: "${currentObservation}" → 根本原因是什么？`
        : `Why ${level}: ${question}\nObservation: "${currentObservation}" → 回答这个 Why（简短，1-2句）：`;

    let answer = "";
    try {
      answer = await executeRolePrompt(
        "planner",
        [
          `You are answering a "Why" question in a 5-Why chain.`,
          `The observation so far: "${currentObservation}"`,
          `The why question: ${whyQuestion}`,
          ``,
          `Answer in 1-2 sentences, be specific and causal.`,
          `If you cannot determine a cause, state "无法确定因果链" and stop.`,
        ].join("\n"),
        options.selection,
        options.context
      );
    } catch {
      answer = "无法确定因果链";
    }

    answer = answer.trim().replace(/^[""]+|[""]+$/g, "");
    const certainty = Math.min(0.95, 0.3 + level * 0.13);

    steps.push({
      level: level as 1 | 2 | 3 | 4 | 5,
      question: whyQuestion.replace(/^Why \d+: /, "").replace(/\n.*$/, ""),
      answer,
      certainty,
    });

    if (answer.includes("无法确定") || answer.length < 5) {
      break;
    }
    currentObservation = answer;
  }

  const rootCause = steps.length > 0 ? (steps[steps.length - 1]?.answer ?? observation) : observation;

  return {
    initialObservation: observation,
    certainty: steps[0]?.certainty ?? 0.5,
    steps,
    rootCause,
  };
}

function buildCriticalInsight(
  _hat: HatDefinition,
  parsed: HatResponse,
  whyChain: FiveWhyResult | null
): string {
  if (whyChain) {
    return `关键发现: ${whyChain.rootCause}`;
  }
  if (parsed.certainty < CERTAINTY_THRESHOLD) {
    return `观察置信度较低 (${(parsed.certainty * 100).toFixed(0)}%)，但未触发深度追问`;
  }
  return parsed.criticalInsight;
}

function buildRefinedStatement(task: string, hatResults: WhyChainSection[]): string {
  const rootCauses = hatResults
    .filter((h) => h.whyChain !== null)
    .map((h) => h.whyChain!.rootCause)
    .join("; ");
  const value = hatResults.find((h) => h.hat.color === "yellow")?.observation ?? "";
  if (!rootCauses && !value) {
    return task;
  }
  return `核心问题: ${rootCauses || "待探索"} | 核心价值: ${value || "待发现"}`;
}

/** === Plan Generation from Insight === */

async function buildPlanFromInsight(
  task: string,
  insight: SixHatsInsight,
  options: PlanInsightOptions
): Promise<TaskNode[]> {
  const criticalRisks = insight.criticalRisks
    .map((r) => `- Risk: ${r}`)
    .join("\n");
  const rootCauses = insight.rootCauses
    .map((rc) => `- Root cause: ${rc}`)
    .join("\n");
  const blueSynthesis = insight.blueHatSynthesis
    ? `- Synthesis: ${insight.blueHatSynthesis}`
    : "";

  const prompt = [
    `You are a task planner. Decompose a task into a DAG, informed by prior multi-perspective analysis.`,
    ``,
    `Return ONLY a JSON array: [{id, description, dependencies}]`,
    `- id: short string like task-1`,
    `- description: concrete actionable subtask`,
    `- dependencies: array of dependency ids (may be empty)`,
    ``,
    `Original task: ${task}`,
    ``,
    `Refined task statement: ${insight.refinedTaskStatement}`,
    ``,
    `Key insights from 6 Thinking Hats analysis:`,
    criticalRisks || "- (no critical risks identified)",
    rootCauses || "- (root causes under exploration)",
    blueSynthesis || "",
    ``,
    `Constraints for planning:`,
    `- Address each critical risk as a separate task`,
    `- If root causes are identified, include a task to resolve the root cause`,
    `- Max 8 tasks in the plan`,
    ``,
  ].join("\n");

  let raw = "";
  try {
    raw = await executeRolePrompt("planner", prompt, options.selection, options.context);
  } catch (error) {
    logger.error({ error }, "Insight-based planning failed");
    return [];
  }

  return parsePlannerJson(raw, []);
}

function parsePlannerJson(raw: string, _skillHints: string[]): TaskNode[] {
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1].trim();
  }
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) {
    return [];
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    const items: TaskNode[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i] as Record<string, unknown>;
      if (!entry || typeof entry !== "object") continue;
      const id = typeof entry.id === "string" ? entry.id.trim() : `task-${i + 1}`;
      const description =
        typeof entry.description === "string" ? entry.description.trim() : "";
      if (!description) continue;
      const depsRaw = entry.dependencies;
      const dependencies = Array.isArray(depsRaw)
        ? depsRaw.filter((d): d is string => typeof d === "string")
        : [];
      items.push({
        id,
        description,
        dependencies,
        status: "PENDING",
        contextQuery: description,
        retryCount: 0,
      });
    }
    return items.length > 0 ? items.slice(0, 8) : [];
  } catch {
    return [];
  }
}
