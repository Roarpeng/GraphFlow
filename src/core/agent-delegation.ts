import { brainstormTask } from "../agents/brainstormer";
import {
  SIX_HATS,
  analyzeWithSixHatsHeuristic,
  buildHatAnalysisPrompt,
  type SixHatsInsight,
} from "../agents/insight";
import {
  isCompactAgentInsightTask,
  isResearchKeyHatColor,
} from "../agents/task-profile";
import { planTasks } from "../agents/planner";
import { triageTask } from "./triage";
import type { TaskNode } from "./types";

export { isCompactAgentInsightTask, isResearchAnalysisTask } from "../agents/task-profile";

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

function buildIntentWorkItem(task: string): AgentWorkItem {
  return {
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
  };
}

function buildRequirementWorkItem(task: string): AgentWorkItem {
  return {
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
  };
}

function buildHatWorkItem(task: string, hat: (typeof SIX_HATS)[number], index: number): AgentWorkItem {
  return {
    id: `hat-${index + 1}-${hat.color}`,
    kind: "six-hats",
    hat: hat.name,
    prompt: buildHatAnalysisPrompt(task, hat),
    expectedFormat: "json",
    responseSchema: HAT_RESPONSE_SCHEMA,
  };
}

function buildFiveWhyWorkItem(task: string, hat: (typeof SIX_HATS)[number], index: number): AgentWorkItem {
  return {
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
  };
}

function buildFirstPrinciplesWorkItem(task: string): AgentWorkItem {
  return {
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
  };
}

function buildDecisionMatrixWorkItem(task: string): AgentWorkItem {
  return {
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
  };
}

function buildPlanRefinementWorkItem(task: string): AgentWorkItem {
  return {
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
  };
}

/** Work-item IDs for lightweight simple-plan bridge (not full Six Hats). */
export const SIMPLE_PLAN_BRIDGE_REQUIRED_IDS = [
  "simple-plan-intent",
  "simple-plan-decomposition",
] as const;

export type SimplePlanNode = {
  id: string;
  description: string;
  dependencies: string[];
};

/**
 * Compact agent-bridge for default graphflow_plan when GraphFlow has no LLM.
 * Local heuristic DAG is attached as a non-final suggestion only.
 */
export function buildAgentDelegatedSimplePlan(task: string): {
  mode: "agent-delegated";
  triageMode: "simple" | "complex";
  ideas: string[];
  /** Provisional heuristic nodes — NOT final until agent submit+merge. */
  nodes: SimplePlanNode[];
  suggestedNodes: SimplePlanNode[];
  agentWorkItems: AgentWorkItem[];
  agentInstructions: string;
  status: "awaiting-agent";
  complete: false;
  requiresAgentBridge: true;
  nodesStatus: "suggested";
} {
  const triageMode = triageTask(task);
  const ideas = brainstormTask(task);
  const suggestedNodes = planTasks(task).map((node) => ({
    id: node.id,
    description: node.description,
    dependencies: node.dependencies,
  }));
  const suggestedJson = JSON.stringify(suggestedNodes, null, 2);

  const agentWorkItems: AgentWorkItem[] = [
    {
      id: "simple-plan-intent",
      kind: "intent",
      prompt: [
        `Task: ${task}`,
        "",
        "Before splitting into subtasks, understand the task as ONE intent.",
        "Do NOT treat colon-list evaluation dimensions (e.g. assumptions, failure modes) as separate work items.",
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
    },
    {
      id: "simple-plan-decomposition",
      kind: "plan-refinement",
      prompt: [
        `Task: ${task}`,
        "",
        "Produce the FINAL DAG task plan using your model.",
        "A local heuristic suggestion is provided below — use it only if it is high-quality;",
        "otherwise replace it with a better split grounded in your intent analysis.",
        "Rules:",
        "- Max 8 tasks; each description must be actionable (verb + object)",
        "- Do NOT invent parallel noun-phrase tasks from punctuation lists",
        "- Prefer sequential design → implement → verify when the request is one analytical intent",
        "",
        "Suggested local plan (non-authoritative):",
        suggestedJson,
        "",
        "Return ONLY a JSON array: [{id, description, dependencies}]",
      ].join("\n"),
      expectedFormat: "json",
      responseSchema: {
        items: { id: "string", description: "string", dependencies: "string[]" },
      },
    },
  ];

  const agentInstructions = [
    "[AGENT-BRIDGE REQUIRED] No GraphFlow LLM API key is configured.",
    "YOU (the connected coding agent) MUST decompose this task with your own model.",
    "The nodes/suggestedNodes fields are LOCAL HEURISTIC SUGGESTIONS — not a finished plan.",
    "Do NOT treat suggestedNodes as final. Prefer your own DAG after intent analysis.",
    "",
    "Protocol (MUST follow in order):",
    '1. Answer each REQUIRED work item with your model (JSON only).',
    '2. MUST submit each via graphflow_insight({ mode: "submit", task, workItemId, response }).',
    '3. After both required items are submitted, MUST call graphflow_insight({ mode: "merge", task }).',
    "4. Use the merged plan as the real DAG, then implement.",
    "",
    `Task: ${task}`,
    "",
    "Mode: simple-plan bridge (intent → decomposition)",
    `Required work items (2): ${SIMPLE_PLAN_BRIDGE_REQUIRED_IDS.join(", ")}`,
    "Suggested order: (1) simple-plan-intent, (2) simple-plan-decomposition.",
    "",
    "Work items:",
    ...agentWorkItems.map((item) => `- ${item.id} (${item.kind}) [REQUIRED]`),
  ].join("\n");

  return {
    mode: "agent-delegated",
    triageMode,
    ideas,
    nodes: suggestedNodes,
    suggestedNodes,
    agentWorkItems,
    agentInstructions,
    status: "awaiting-agent",
    complete: false,
    requiresAgentBridge: true,
    nodesStatus: "suggested",
  };
}

function buildPlanReflectionWorkItem(task: string, optional: boolean): AgentWorkItem {
  return {
    id: "plan-reflection",
    kind: "reflection",
    ...(optional ? { optional: true } : {}),
    prompt: [
      `Task: ${task}`,
      "",
      optional
        ? "[OPTIONAL for research/architecture compact mode]"
        : "Reflect on the quality of the plan you produced.",
      optional ? "Optionally reflect on the quality of the plan you produced." : "",
      "Return ONLY a JSON object:",
      "{",
      '  "confidence": 0.0-1.0,',
      '  "uncertainties": ["things you are unsure about"],',
      '  "missingInformation": ["information that would improve the plan"],',
      '  "improvementDirections": ["how the plan could be improved"]',
      "}",
    ]
      .filter(Boolean)
      .join("\n"),
    expectedFormat: "json",
    responseSchema: {
      confidence: "number",
      uncertainties: "string[]",
      missingInformation: "string[]",
      improvementDirections: "string[]",
    },
  };
}

/** Compact set for research/analysis: ~7 required (+ optional reflection). */
function buildCompactAgentInsightWorkItems(task: string): AgentWorkItem[] {
  const items: AgentWorkItem[] = [buildIntentWorkItem(task)];

  SIX_HATS.forEach((hat, index) => {
    if (!isResearchKeyHatColor(hat.color)) {
      return;
    }
    items.push(buildHatWorkItem(task, hat, index));
  });

  items.push(buildDecisionMatrixWorkItem(task));
  items.push(buildPlanRefinementWorkItem(task));
  // Reflection is optional in compact mode — merge only requires !optional IDs.
  items.push(buildPlanReflectionWorkItem(task, true));

  return items;
}

/** Full 18-item set for coding/refactor (default). */
function buildFullAgentInsightWorkItems(task: string): AgentWorkItem[] {
  const items: AgentWorkItem[] = [buildIntentWorkItem(task), buildRequirementWorkItem(task)];

  SIX_HATS.forEach((hat, index) => {
    items.push(buildHatWorkItem(task, hat, index));
  });

  SIX_HATS.forEach((hat, index) => {
    items.push(buildFiveWhyWorkItem(task, hat, index));
  });

  items.push(buildFirstPrinciplesWorkItem(task));
  items.push(buildDecisionMatrixWorkItem(task));
  items.push(buildPlanRefinementWorkItem(task));
  items.push(buildPlanReflectionWorkItem(task, false));

  return items;
}

export function buildAgentInsightWorkItems(task: string): AgentWorkItem[] {
  return isCompactAgentInsightTask(task)
    ? buildCompactAgentInsightWorkItems(task)
    : buildFullAgentInsightWorkItems(task);
}

export function buildAgentDelegationInstructions(
  task: string,
  workItems: AgentWorkItem[]
): string {
  const required = workItems.filter((item) => !item.optional);
  const compact = isCompactAgentInsightTask(task);
  const lines = [
    "[AGENT-BRIDGE REQUIRED] No GraphFlow LLM API key is configured.",
    "YOU (the connected coding agent) MUST complete the insight analysis with your own model.",
    "The insight/plan fields in this response are PLACEHOLDERS — not a finished analysis.",
    "Do NOT treat placeholder insight/plan as final. Do NOT skip submit+merge.",
    "",
    "Protocol (MUST follow in order):",
    '1. Answer each REQUIRED work item prompt with your model (JSON only).',
    '2. MUST submit each via graphflow_insight({ mode: "submit", task, workItemId, response }).',
    '3. After all required items are submitted, MUST call graphflow_insight({ mode: "merge", task }).',
    "4. Use the merged insight + plan as the real result, then implement / report_outcome as needed.",
    "",
    `Task: ${task}`,
    "",
    `Mode: ${compact ? "compact (research/architecture analysis)" : "full (coding/refactor)"}`,
    `Required work items (${required.length}): ${required.map((item) => item.id).join(", ")}`,
    compact
      ? "Suggested order: (1) intent-analysis, (2-5) hats white/black/yellow/blue, (6) decision-matrix, (7) plan-refinement, (8) plan-reflection [optional]."
      : "Suggested order: (1) intent-analysis, (2) requirement-analysis, (3-8) six-hats, (9-14) five-whys [optional if hat certainty>=0.6], (15) first-principles [optional], (16) decision-matrix, (17) plan-refinement, (18) plan-reflection.",
    "",
    "Work items:",
  ];

  for (const item of workItems) {
    lines.push(
      `- ${item.id} (${item.kind}${item.hat ? ` / ${item.hat}` : ""})${item.optional ? " [optional]" : " [REQUIRED]"}`
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
