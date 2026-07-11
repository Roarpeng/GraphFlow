/**
 * Decision Engine — First Principles Analysis + Decision Matrix.
 *
 * These two modules form the core of ATP v1.0's analytical depth:
 * - First Principles: strip away assumptions, decompose to fundamental
 *   truths, and challenge every belief about the problem.
 * - Decision Matrix: generate viable options, score them across
 *   multiple dimensions, and recommend the best path forward.
 *
 * Each module has an LLM-powered version (calls executeRolePrompt) and
 * a heuristic fallback (rule-based, no LLM dependency). The LLM version
 * always falls back to the heuristic when the call fails or the JSON
 * response is unparseable.
 */

import type { SixHatsInsight, PlanInsightOptions } from "./insight";
import type {
  FirstPrinciplesAnalysis,
  DecisionMatrixResult,
  DecisionMatrixOption,
} from "./atp-schema";
import { executeRolePrompt } from "../routing/provider-executor";
import { logger } from "../utils/logger";

/** === First Principles Analysis === */

/**
 * Apply first principles thinking to the task using LLM.
 *
 * Asks the LLM to:
 * 1. List current assumptions (assumptions)
 * 2. Decompose to irreducible facts (facts)
 * 3. Identify fundamental elements (deconstructedTo)
 * 4. Challenge each assumption (challenges)
 *
 * Falls back to heuristic on LLM failure or unparseable response.
 */
export async function applyFirstPrinciples(
  task: string,
  insight: SixHatsInsight,
  options: PlanInsightOptions
): Promise<FirstPrinciplesAnalysis> {
  const prompt = [
    `You are performing a First Principles analysis on the following task.`,
    ``,
    `Task: "${task}"`,
    ``,
    `Prior analysis context:`,
    `- Root causes identified: ${insight.rootCauses.length > 0 ? insight.rootCauses.join("; ") : "(none)"}`,
    `- Critical risks: ${insight.criticalRisks.length > 0 ? insight.criticalRisks.join("; ") : "(none)"}`,
    `- Core value: ${insight.coreValue || "(not yet identified)"}`,
    `- Refined task statement: ${insight.refinedTaskStatement}`,
    ``,
    `Your job:`,
    `1. List the assumptions currently held about this task (things believed to be true but not verified).`,
    `2. Identify the irreducible facts — fundamental truths that cannot be broken down further.`,
    `3. Decompose the problem into its most basic elements.`,
    `4. Challenge each assumption: is it truly valid, or is it based on convention?`,
    ``,
    `Return ONLY a JSON object:`,
    `{`,
    `  "assumptions": ["assumption 1", "assumption 2", ...],`,
    `  "facts": ["irreducible fact 1", "fact 2", ...],`,
    `  "deconstructedTo": ["fundamental element 1", "element 2", ...],`,
    `  "challenges": ["challenge to assumption 1", "challenge to assumption 2", ...]`,
    `}`,
    ``,
    `Each array should contain 2-6 concise items. Be specific and analytical.`,
  ].join("\n");

  let raw = "";
  try {
    raw = await executeRolePrompt("planner", prompt, options.selection, options.context);
  } catch (error) {
    logger.warn({ error }, "First principles LLM call failed, using heuristic fallback");
    return applyFirstPrinciplesHeuristic(task, insight);
  }

  const parsed = parseFirstPrinciplesResponse(raw);
  if (parsed === null) {
    logger.warn({ raw }, "First principles response unparseable, using heuristic fallback");
    return applyFirstPrinciplesHeuristic(task, insight);
  }

  return parsed;
}

/**
 * Heuristic first principles analysis — no LLM calls.
 * Derives assumptions, facts, decomposition, and challenges from
 * the Six Hats insight using rule-based logic.
 */
export function applyFirstPrinciplesHeuristic(
  task: string,
  insight: SixHatsInsight
): FirstPrinciplesAnalysis {
  return {
    assumptions:
      insight.criticalRisks.length > 0
        ? ["Assumption: identified risks are addressable within scope"]
        : ["Assumption: no significant risks identified means the task is straightforward"],
    facts: [
      `Task: ${task}`,
      `Root causes found: ${insight.rootCauses.length}`,
      `Critical risks: ${insight.criticalRisks.length}`,
      `Core value: ${insight.coreValue}`,
    ],
    deconstructedTo: [
      "Problem decomposed into: context gathering, analysis, implementation, verification",
      `Root cause driven: ${insight.rootCauses.slice(0, 2).join("; ")}`,
    ],
    challenges: insight.criticalRisks.map(
      (r) => `Challenge: "${r}" — is this risk real or based on assumption?`
    ),
  };
}

/** === Decision Matrix Evaluation === */

/**
 * Evaluate solution options using a decision matrix with LLM.
 *
 * Asks the LLM to:
 * 1. Generate 2-3 viable options based on first principles analysis
 * 2. Score each option on complexity, cost, risk, maintainability, impact (1-10)
 * 3. List pros and cons for each option
 * 4. Recommend one option with rationale
 *
 * Falls back to heuristic on LLM failure or unparseable response.
 */
export async function evaluateOptions(
  task: string,
  insight: SixHatsInsight,
  firstPrinciples: FirstPrinciplesAnalysis,
  options: PlanInsightOptions
): Promise<DecisionMatrixResult> {
  const prompt = [
    `You are evaluating solution options for a task using a Decision Matrix.`,
    ``,
    `Task: "${task}"`,
    ``,
    `First Principles Analysis:`,
    `- Assumptions: ${firstPrinciples.assumptions.join("; ")}`,
    `- Facts: ${firstPrinciples.facts.join("; ")}`,
    `- Decomposed to: ${firstPrinciples.deconstructedTo.join("; ")}`,
    `- Challenges: ${firstPrinciples.challenges.join("; ")}`,
    ``,
    `Six Hats Insight:`,
    `- Root causes: ${insight.rootCauses.join("; ") || "(none)"}`,
    `- Critical risks: ${insight.criticalRisks.join("; ") || "(none)"}`,
    `- Core value: ${insight.coreValue || "(not identified)"}`,
    ``,
    `Your job:`,
    `1. Based on the analysis above, generate 2-3 viable solution options.`,
    `2. Score each option on these dimensions (1-10, where 1 is best/lowest and 10 is worst/highest):`,
    `   - complexity: how technically complex (1=simple, 10=very complex)`,
    `   - cost: resource cost (1=low, 10=high)`,
    `   - risk: level of risk (1=low, 10=high)`,
    `   - maintainability: ease of maintenance (1=easy, 10=hard — INVERTED: high score means hard to maintain)`,
    `   - impact: potential impact (1=low, 10=high — high score is GOOD)`,
    `3. List pros and cons for each option.`,
    `4. Recommend the best option and explain your rationale.`,
    ``,
    `Return ONLY a JSON object:`,
    `{`,
    `  "options": [`,
    `    {`,
    `      "name": "Option Name",`,
    `      "description": "Brief description of the approach",`,
    `      "scores": {`,
    `        "complexity": 1-10,`,
    `        "cost": 1-10,`,
    `        "risk": 1-10,`,
    `        "maintainability": 1-10,`,
    `        "impact": 1-10`,
    `      },`,
    `      "pros": ["pro 1", "pro 2", ...],`,
    `      "cons": ["con 1", "con 2", ...]`,
    `    }`,
    `  ],`,
    `  "recommendedOption": "Name of the recommended option",`,
    `  "rationale": "Why this option is recommended over the others"`,
    `}`,
  ].join("\n");

  let raw = "";
  try {
    raw = await executeRolePrompt("planner", prompt, options.selection, options.context);
  } catch (error) {
    logger.warn({ error }, "Decision matrix LLM call failed, using heuristic fallback");
    return evaluateOptionsHeuristic(task, insight);
  }

  const parsed = parseDecisionMatrixResponse(raw);
  if (parsed === null) {
    logger.warn({ raw }, "Decision matrix response unparseable, using heuristic fallback");
    return evaluateOptionsHeuristic(task, insight);
  }

  return parsed;
}

/**
 * Heuristic decision matrix evaluation — no LLM calls.
 * Generates two standard options (Incremental vs Comprehensive)
 * and recommends based on risk count.
 */
export function evaluateOptionsHeuristic(
  _task: string,
  insight: SixHatsInsight
): DecisionMatrixResult {
  const optionA: DecisionMatrixOption = {
    name: "Incremental Approach",
    description: "Build incrementally, addressing root causes one by one",
    scores: { complexity: 4, cost: 3, risk: 3, maintainability: 8, impact: 6 },
    pros: ["Low risk", "Easy to validate", "Quick feedback"],
    cons: ["May take longer overall", "Requires more iterations"],
  };
  const optionB: DecisionMatrixOption = {
    name: "Comprehensive Approach",
    description: "Address all root causes and risks in a single coordinated effort",
    scores: { complexity: 7, cost: 6, risk: 6, maintainability: 7, impact: 9 },
    pros: ["Higher impact", "Complete solution", "Single deployment"],
    cons: ["Higher complexity", "More risk", "Longer initial timeline"],
  };
  return {
    options: [optionA, optionB],
    recommendedOption:
      insight.criticalRisks.length > 2 ? "Incremental Approach" : "Comprehensive Approach",
    rationale:
      insight.criticalRisks.length > 2
        ? "High risk count suggests incremental approach to manage exposure"
        : "Low risk count allows comprehensive approach for maximum impact",
  };
}

/** === JSON Parsing Helpers === */

/**
 * Parse a First Principles JSON response from the LLM.
 * Returns null if the response cannot be parsed into a valid
 * FirstPrinciplesAnalysis object.
 */
function parseFirstPrinciplesResponse(raw: string): FirstPrinciplesAnalysis | null {
  const text = stripCodeFence(raw).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const assumptions = extractStringArray(parsed, "assumptions");
  const facts = extractStringArray(parsed, "facts");
  const deconstructedTo = extractStringArray(parsed, "deconstructedTo");
  const challenges = extractStringArray(parsed, "challenges");

  // Require at least some meaningful content
  if (assumptions.length === 0 && facts.length === 0) {
    return null;
  }

  return { assumptions, facts, deconstructedTo, challenges };
}

/**
 * Parse a Decision Matrix JSON response from the LLM.
 * Returns null if the response cannot be parsed into a valid
 * DecisionMatrixResult object.
 */
function parseDecisionMatrixResponse(raw: string): DecisionMatrixResult | null {
  const text = stripCodeFence(raw).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Parse options array
  const optionsRaw = parsed.options;
  if (!Array.isArray(optionsRaw) || optionsRaw.length === 0) {
    return null;
  }

  const options: DecisionMatrixOption[] = [];
  for (const entry of optionsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const description = typeof obj.description === "string" ? obj.description.trim() : "";
    if (!name) continue;

    const scoresRaw = obj.scores;
    const scores = scoresRaw && typeof scoresRaw === "object"
      ? (scoresRaw as Record<string, unknown>)
      : {};

    options.push({
      name,
      description,
      scores: {
        complexity: clampScore(scores.complexity),
        cost: clampScore(scores.cost),
        risk: clampScore(scores.risk),
        maintainability: clampScore(scores.maintainability),
        impact: clampScore(scores.impact),
      },
      pros: extractStringArray(obj, "pros"),
      cons: extractStringArray(obj, "cons"),
    });
  }

  if (options.length === 0) {
    return null;
  }

  const recommendedOption =
    typeof parsed.recommendedOption === "string" ? parsed.recommendedOption.trim() : "";
  const rationale =
    typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";

  // Validate that recommendedOption matches one of the option names
  const firstOption = options[0];
  if (!recommendedOption || !options.some((o) => o.name === recommendedOption)) {
    // If recommendation doesn't match, pick the first option as fallback
    return {
      options,
      recommendedOption: firstOption?.name ?? recommendedOption,
      rationale: rationale || "Default recommendation: first viable option",
    };
  }

  return { options, recommendedOption, rationale };
}

/** === Utility Functions === */

/**
 * Strip markdown code fences (```json ... ```) from a raw LLM response.
 */
function stripCodeFence(raw: string): string {
  const text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }
  return text;
}

/**
 * Extract a string array from a parsed JSON object field.
 * Returns an empty array if the field is missing or invalid.
 */
function extractStringArray(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Clamp a score value to the 1-10 range.
 * Returns 5 (midpoint) if the value is not a valid number.
 */
function clampScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 5;
  }
  return Math.max(1, Math.min(10, Math.round(value)));
}
