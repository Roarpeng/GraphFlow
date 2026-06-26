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
  kind: "six-hats" | "five-whys" | "plan-refinement";
  hat?: string;
  prompt: string;
  expectedFormat: "json";
  responseSchema: Record<string, unknown>;
}

export type AgentDelegationMode = "llm" | "agent-delegated" | "heuristic";

export interface AgentDelegatedPlanInsight {
  mode: AgentDelegationMode;
  insight: SixHatsInsight;
  plan: TaskNode[];
  agentWorkItems?: AgentWorkItem[];
  agentInstructions?: string;
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

  return items;
}

export function buildAgentDelegationInstructions(
  task: string,
  workItems: AgentWorkItem[]
): string {
  const lines = [
    "[AGENT-DELEGATED LLM] No external GraphFlow API key is configured.",
    "Use your own model to complete the analysis prompts below, then execute the heuristic plan.",
    "Optional: incorporate your answers into implementation; call graphflow_report_outcome when done.",
    "",
    `Task: ${task}`,
    "",
    "Work items:",
  ];

  for (const item of workItems) {
    lines.push(`- ${item.id} (${item.kind}${item.hat ? ` / ${item.hat}` : ""})`);
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
  const plan = buildHeuristicPlanFromInsight(task, insight);

  return {
    mode: "agent-delegated",
    insight,
    plan,
    agentWorkItems,
    agentInstructions: buildAgentDelegationInstructions(task, agentWorkItems),
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
