import {
  SIX_HATS,
  analyzeWithSixHatsHeuristic,
  buildHatAnalysisPrompt,
  type SixHatsInsight,
} from "../agents/insight";
import { planTasks } from "../agents/planner";
import type { TaskNode } from "./types";

export interface AgentWorkItem {
  id: string;
  kind: "six-hats" | "five-whys" | "plan-refinement" | "query-translate" | "intent" | "requirement" | "first-principles" | "decision-matrix" | "reflection";
  hat?: string;
  prompt: string;
  expectedFormat: "json";
  responseSchema: Record<string, unknown>;
  optional?: boolean;
}

export type AgentDelegationMode = "llm" | "agent-delegated" | "heuristic";

export interface AgentDelegatedPlanInsight {
  mode: AgentDelegationMode;
  insight: SixHatsInsight;
  plan: TaskNode[] | null;
  agentWorkItems?: AgentWorkItem[];
  agentInstructions?: string;
  /** ATP (Advanced Task Protocol) analysis result, when full ATP flow is enabled. */
  atp?: unknown;
  /** Agent-bridge lifecycle: incomplete until work items are submitted + merged. */
  status?: "awaiting-agent" | "complete";
  complete?: boolean;
  requiresAgentBridge?: boolean;
}

const HAT_RESPONSE_SCHEMA = {
  observation: "string — single key observation from this hat",
  certainty: "number 0.0-1.0",
  criticalInsight: "string — what this hat contributes",
};

export function buildAgentInsightWorkItems(task: string): AgentWorkItem[] {
  const items: AgentWorkItem[] = SIX_HATS.map((hat, index) => ({
    id: `hat-${index + 1}-${hat.color}`,
    kind: "six-hats" as const,
    hat: hat.name,
    prompt: buildHatAnalysisPrompt(task, hat),
    expectedFormat: "json" as const,
    responseSchema: HAT_RESPONSE_SCHEMA,
  }));

  items.unshift({
    id: "intent-analysis",
    kind: "intent",
    prompt: [
      `Task: ${task}`,
      "",
      "Analyze the intent behind this task.",
      "Return ONLY a JSON object:",
      "{",
      '  "explicitIntent": "what the user explicitly asked for",',
      '  "implicitIntent": "the underlying need",',
      '  "coreProblem": "the core problem to solve",',
      '  "nonGoals": ["things out of scope"],',
      '  "successDefinition": "how to know the task is done"',
      "}",
    ].join("\n"),
    expectedFormat: "json",
    responseSchema: {
      explicitIntent: "string",
      implicitIntent: "string",
      coreProblem: "string",
      nonGoals: "string[]",
      successDefinition: "string",
    },
  });

  items.splice(1, 0, {
    id: "requirement-analysis",
    kind: "requirement",
    prompt: [
      `Task: ${task}`,
      "",
      "Extract structured requirements.",
      "Return ONLY a JSON object:",
      "{",
      '  "functional": ["functional requirements"],',
      '  "nonFunctional": ["non-functional requirements"],',
      '  "constraints": ["known constraints"],',
      '  "priority": "Low|Medium|High|Critical",',
      '  "scope": {"included": ["in scope"], "excluded": ["out of scope"]}',
      "}",
    ].join("\n"),
    expectedFormat: "json",
    responseSchema: {
      functional: "string[]",
      nonFunctional: "string[]",
      constraints: "string[]",
      priority: "string",
      scope: "object",
    },
  });

  SIX_HATS.forEach((hat, index) => {
    items.push({
      id: `why-${index + 1}-${hat.color}`,
      kind: "five-whys",
      hat: hat.name,
      optional: true,
      prompt: [
        `Task: ${task}`,
        "",
        `[OPTIONAL — only answer if your ${hat.name} observation had certainty < 0.6]`,
        `You are drilling into your ${hat.name} observation with a 5-Why chain.`,
        `Focus per step: ${hat.whyFocus}`,
        `Final convergence: ${hat.whyRootFocus}`,
        "",
        "Produce up to 5 Why steps, each a {question, answer}, then the converged rootCause.",
        "Return ONLY a JSON object:",
        "{",
        '  "steps": [{"question": "Why ...?", "answer": "..."}],',
        '  "rootCause": "the single root cause this chain converges to"',
        "}",
        "If the hat's certainty was >= 0.6, skip this item (do not submit).",
      ].join("\n"),
      expectedFormat: "json",
      responseSchema: {
        steps: "Array<{question:string, answer:string}>",
        rootCause: "string — the converged root cause",
      },
    });
  });

  items.push({
    id: "first-principles",
    kind: "first-principles",
    optional: true,
    prompt: [
      `Task: ${task}`,
      "",
      "[OPTIONAL — answer if you completed the Six Hats analysis]",
      "Apply First Principles thinking to this task.",
      "Return ONLY a JSON object:",
      "{",
      '  "assumptions": ["current assumptions"],',
      '  "facts": ["irreducible facts"],',
      '  "deconstructedTo": ["basic elements the problem breaks down to"],',
      '  "challenges": ["challenges to assumptions"]',
      "}",
    ].join("\n"),
    expectedFormat: "json",
    responseSchema: {
      assumptions: "string[]",
      facts: "string[]",
      deconstructedTo: "string[]",
      challenges: "string[]",
    },
  });

  items.push({
    id: "decision-matrix",
    kind: "decision-matrix",
    prompt: [
      `Task: ${task}`,
      "",
      "Generate 2-3 solution options and score each.",
      "Return ONLY a JSON object:",
      "{",
      '  "options": [{"name":"...","description":"...","scores":{"complexity":1-10,"cost":1-10,"risk":1-10,"maintainability":1-10,"impact":1-10},"pros":["..."],"cons":["..."]}],',
      '  "recommendedOption": "name of recommended option",',
      '  "rationale": "why this option is recommended"',
      "}",
    ].join("\n"),
    expectedFormat: "json",
    responseSchema: {
      options: "Array<object>",
      recommendedOption: "string",
      rationale: "string",
    },
  });

  items.push({
    id: "plan-refinement",
    kind: "plan-refinement",
    prompt: [
      `Task: ${task}`,
      "",
      "Using your Six Hats analysis (if completed), refine the DAG plan.",
      "Return ONLY a JSON array: [{id, description, dependencies}]",
      "- Max 8 tasks",
      "- Address black-hat risks and yellow-hat value explicitly",
    ].join("\n"),
    expectedFormat: "json",
    responseSchema: {
      items: { id: "string", description: "string", dependencies: "string[]" },
    },
  });

  items.push({
    id: "plan-reflection",
    kind: "reflection",
    prompt: [
      `Task: ${task}`,
      "",
      "Reflect on the quality of the plan you produced.",
      "Return ONLY a JSON object:",
      "{",
      '  "confidence": 0.0-1.0,',
      '  "uncertainties": ["things you are unsure about"],',
      '  "missingInformation": ["information that would improve the plan"],',
      '  "improvementDirections": ["how the plan could be improved"]',
      "}",
    ].join("\n"),
    expectedFormat: "json",
    responseSchema: {
      confidence: "number",
      uncertainties: "string[]",
      missingInformation: "string[]",
      improvementDirections: "string[]",
    },
  });

  return items;
}

export function buildAgentDelegationInstructions(
  task: string,
  workItems: AgentWorkItem[]
): string {
  const required = workItems.filter((item) => !item.optional);
  const lines = [
    "[AGENT-BRIDGE REQUIRED] No GraphFlow LLM API key is configured.",
    "YOU (the connected coding agent) must complete the insight analysis with your own model.",
    "The insight/plan fields in this response are PLACEHOLDERS — not a finished analysis. Do not execute them as the final plan.",
    "",
    "Protocol:",
    '1. Answer each required work item prompt with your model (JSON only).',
    '2. Submit each via graphflow_insight({ mode: "submit", task, workItemId, response }).',
    '3. After all required items are submitted, call graphflow_insight({ mode: "merge", task }).',
    "4. Use the merged insight + plan as the real result, then implement / report_outcome as needed.",
    "",
    `Task: ${task}`,
    "",
    `Required work items (${required.length}): ${required.map((item) => item.id).join(", ")}`,
    "Suggested order: (1) intent-analysis, (2) requirement-analysis, (3-8) six-hats, (9-14) five-whys [optional if hat certainty>=0.6], (15) first-principles [optional], (16) decision-matrix, (17) plan-refinement, (18) plan-reflection.",
    "",
    "Work items:",
  ];

  for (const item of workItems) {
    lines.push(
      `- ${item.id} (${item.kind}${item.hat ? ` / ${item.hat}` : ""})${item.optional ? " [optional]" : ""}`
    );
  }

  return lines.join("\n");
}

export function buildHeuristicPlanFromInsight(task: string, insight: SixHatsInsight): TaskNode[] {
  const baseTask = insight.refinedTaskStatement || task;
  const base = planTasks(baseTask);

  if (insight.criticalRisks.length === 0 && insight.rootCauses.length === 0) {
    return base;
  }

  const riskTask: TaskNode = {
    id: "task-risk-mitigation",
    description: `Mitigate risks: ${insight.criticalRisks.join("; ") || insight.rootCauses.join("; ")}`,
    dependencies: base.filter((n) => n.id !== `task-${base.length}`).map((n) => n.id),
    status: "PENDING",
    contextQuery: "risk mitigation",
    retryCount: 0,
  };

  const integrate = base[base.length - 1];
  if (!integrate) {
    return [...base, riskTask];
  }

  integrate.dependencies = [...new Set([...integrate.dependencies, riskTask.id])];
  return [...base.slice(0, -1), riskTask, integrate];
}

export function buildAgentDelegatedPlanInsight(task: string): AgentDelegatedPlanInsight {
  const insight = analyzeWithSixHatsHeuristic(task);
  const agentWorkItems = buildAgentInsightWorkItems(task);
  // Do not invent a DAG from placeholders — agent must submit plan-refinement then merge.
  const plan: TaskNode[] = [];

  return {
    mode: "agent-delegated",
    insight,
    plan,
    agentWorkItems,
    agentInstructions: buildAgentDelegationInstructions(task, agentWorkItems),
    status: "awaiting-agent",
    complete: false,
    requiresAgentBridge: true,
  };
}

export function summarizeInsightForContext(insight: SixHatsInsight): string {
  return [
    `refined=${insight.refinedTaskStatement}`,
    `risks=${insight.criticalRisks.join("|") || "none"}`,
    `roots=${insight.rootCauses.join("|") || "none"}`,
    `value=${insight.coreValue || "none"}`,
  ].join("; ");
}
