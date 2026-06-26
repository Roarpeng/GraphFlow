import { SIX_HATS, type SixHatsInsight, type WhyChainSection } from "../agents/insight";
import {
  buildAgentInsightWorkItems,
  buildHeuristicPlanFromInsight,
} from "./agent-delegation";
import type { GraphClient } from "../graph/client-factory";
import { GraphifyClient } from "../graph/graphify-client";
import type { GraphNode, TaskNode } from "./types";
import { parseAgentInsightResponse } from "./submit-agent-insight";

export interface AgentInsightRecord {
  workItemId: string;
  hat?: string;
  parsed: Record<string, unknown>;
  nodeId: string;
}

export interface MergeAgentInsightsResult {
  insight: SixHatsInsight;
  plan: TaskNode[];
  complete: boolean;
  missing: string[];
  submittedCount: number;
}

function normalizeTask(task: string): string {
  return task.trim().toLowerCase();
}

function parseRecord(node: GraphNode): AgentInsightRecord | null {
  const meta = node.metadata;
  if (!meta || meta.kind !== "agent-insight") {
    return null;
  }
  const workItemId = typeof meta.workItemId === "string" ? meta.workItemId : undefined;
  if (!workItemId) {
    return null;
  }
  const response = typeof meta.response === "string" ? meta.response : "";
  const parsedResult = parseAgentInsightResponse(response);
  if (!parsedResult.ok) {
    return null;
  }
  const hat = typeof meta.hat === "string" ? meta.hat : undefined;
  return {
    workItemId,
    ...(hat ? { hat } : {}),
    parsed: parsedResult.parsed,
    nodeId: node.id,
  };
}

async function loadAllNodes(client: GraphClient): Promise<GraphNode[]> {
  if (client instanceof GraphifyClient) {
    return client.snapshot().nodes;
  }
  if (client.readSnapshot) {
    return client.readSnapshot().nodes;
  }
  return client.queryByKeyword("agent-insight");
}

export async function loadAgentInsightRecords(
  client: GraphClient,
  task: string
): Promise<AgentInsightRecord[]> {
  const nodes = await loadAllNodes(client);
  const normalizedTask = normalizeTask(task);

  return nodes
    .filter(
      (node) =>
        node.type === "Decision" &&
        node.metadata?.kind === "agent-insight" &&
        typeof node.metadata.task === "string" &&
        normalizeTask(node.metadata.task) === normalizedTask
    )
    .map(parseRecord)
    .filter((record): record is AgentInsightRecord => record !== null);
}

function readHatFields(parsed: Record<string, unknown>): {
  observation: string;
  certainty: number;
  criticalInsight: string;
} {
  const observation =
    typeof parsed.observation === "string" ? parsed.observation.trim() : "";
  const certainty =
    typeof parsed.certainty === "number" && Number.isFinite(parsed.certainty)
      ? Math.min(1, Math.max(0, parsed.certainty))
      : 0.5;
  const criticalInsight =
    typeof parsed.criticalInsight === "string" ? parsed.criticalInsight.trim() : observation;
  return { observation, certainty, criticalInsight };
}

function buildRefinedStatement(task: string, hatResults: WhyChainSection[]): string {
  const rootCauses = hatResults
    .filter((hat) => hat.whyChain !== null)
    .map((hat) => hat.whyChain!.rootCause)
    .join("; ");
  const value = hatResults.find((hat) => hat.hat.color === "yellow")?.observation ?? "";
  if (!rootCauses && !value) {
    return task;
  }
  return `核心问题: ${rootCauses || "待探索"} | 核心价值: ${value || "待发现"}`;
}

function parsePlanItems(parsed: Record<string, unknown>): TaskNode[] {
  const raw = parsed.items;
  if (!Array.isArray(raw)) {
    return [];
  }

  const items: TaskNode[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as Record<string, unknown>;
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : `task-${i + 1}`;
    const description = typeof entry.description === "string" ? entry.description.trim() : "";
    if (!description) {
      continue;
    }
    const depsRaw = entry.dependencies;
    const dependencies = Array.isArray(depsRaw)
      ? depsRaw.filter((dep): dep is string => typeof dep === "string")
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
}

export function mergeAgentInsights(
  task: string,
  records: AgentInsightRecord[]
): MergeAgentInsightsResult {
  const expectedIds = buildAgentInsightWorkItems(task).map((item) => item.id);
  const byWorkItem = new Map<string, AgentInsightRecord>();
  for (const record of records) {
    byWorkItem.set(record.workItemId, record);
  }

  const submittedIds = expectedIds.filter((id) => byWorkItem.has(id));
  const missing = expectedIds.filter((id) => !byWorkItem.has(id));
  const complete = missing.length === 0;

  const hatResults: WhyChainSection[] = [];
  for (const hat of SIX_HATS) {
    const workItemId = `hat-${SIX_HATS.indexOf(hat) + 1}-${hat.color}`;
    const record = byWorkItem.get(workItemId);
    if (!record) {
      continue;
    }
    const fields = readHatFields(record.parsed);
    hatResults.push({
      hat,
      observation: fields.observation,
      certainty: fields.certainty,
      whyChain: null,
      criticalInsight: fields.criticalInsight,
    });
  }

  const blueHatSynthesis = hatResults.find((hat) => hat.hat.color === "blue")?.criticalInsight ?? "";
  const rootCauses = hatResults
    .filter((hat) => hat.whyChain !== null)
    .map((hat) => hat.whyChain!.rootCause)
    .filter((value) => value.length > 0);
  const criticalRisks = hatResults
    .filter((hat) => hat.hat.color === "black")
    .map((hat) => hat.observation)
    .filter((value) => value.length > 0);
  const coreValue = hatResults
    .filter((hat) => hat.hat.color === "yellow")
    .map((hat) => hat.observation)
    .join("; ");

  const insight: SixHatsInsight = {
    task,
    hats: hatResults,
    blueHatSynthesis,
    rootCauses: [...new Set(rootCauses)],
    criticalRisks,
    coreValue,
    refinedTaskStatement: buildRefinedStatement(task, hatResults),
  };

  const planRecord = byWorkItem.get("plan-refinement");
  const planFromAgent = planRecord ? parsePlanItems(planRecord.parsed) : [];
  const plan = planFromAgent.length > 0 ? planFromAgent : buildHeuristicPlanFromInsight(task, insight);

  return {
    insight,
    plan,
    complete,
    missing,
    submittedCount: submittedIds.length,
  };
}

export async function mergeAgentInsightsFromGraph(
  client: GraphClient,
  task: string
): Promise<MergeAgentInsightsResult> {
  const records = await loadAgentInsightRecords(client, task);
  return mergeAgentInsights(task, records);
}
