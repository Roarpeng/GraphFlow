import type { GraphNode, TaskNode } from "./types";
import type { GraphClient } from "../graph/client-factory";
import type { SixHatsInsight } from "../agents/insight";
import { mergeAgentInsightsFromGraph } from "./merge-agent-insight";
import { hashText } from "../utils/hash";

export interface SubmitAgentInsightInput {
  task: string;
  workItemId: string;
  response: string;
  episodeId?: string;
  hat?: string;
}

export type SubmitAgentInsightResult =
  | {
      ok: true;
      nodeId: string;
      parsed: Record<string, unknown>;
      merge?: {
        complete: boolean;
        insight: SixHatsInsight;
        plan: TaskNode[];
        missing: string[];
      };
    }
  | { ok: false; reason: string };

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export function parseAgentInsightResponse(raw: string):
  | { ok: true; parsed: Record<string, unknown> }
  | { ok: false; reason: string } {
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch?.[1]) {
    text = fenceMatch[1].trim();
  }

  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");

  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart && (objStart === -1 || arrStart < objStart)) {
    try {
      const parsed = JSON.parse(text.slice(arrStart, arrEnd + 1));
      return { ok: true, parsed: { items: parsed } };
    } catch {
      return { ok: false, reason: "Invalid JSON response" };
    }
  }

  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    try {
      const parsed = JSON.parse(text.slice(objStart, objEnd + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, parsed: parsed as Record<string, unknown> };
      }
    } catch {
      return { ok: false, reason: "Invalid JSON response" };
    }
  }

  return { ok: false, reason: "Invalid JSON response" };
}

function buildDecisionContent(workItemId: string, parsed: Record<string, unknown>): string {
  const observation =
    typeof parsed.observation === "string" ? parsed.observation.trim() : undefined;
  const summary = observation ?? truncate(JSON.stringify(parsed), 120);
  return truncate(`agent-insight ${workItemId}: ${summary}`, 200);
}

export async function submitAgentInsight(
  client: GraphClient,
  input: SubmitAgentInsightInput
): Promise<SubmitAgentInsightResult> {
  const parsedResult = parseAgentInsightResponse(input.response);
  if (!parsedResult.ok) {
    return parsedResult;
  }

  const nodeId = `decision:agent-insight:${hashText(`${input.task}|${input.workItemId}`)}`;
  const metadata: Record<string, unknown> = {
    kind: "agent-insight",
    workItemId: input.workItemId,
    task: input.task,
    response: input.response,
  };
  if (input.hat) {
    metadata.hat = input.hat;
  }
  if (input.episodeId) {
    metadata.episodeId = input.episodeId;
  }

  const node: GraphNode = {
    id: nodeId,
    type: "Decision",
    content: buildDecisionContent(input.workItemId, parsedResult.parsed),
    metadata,
  };

  await client.upsertNodes([node]);

  const merged = await mergeAgentInsightsFromGraph(client, input.task);
  const result: Extract<SubmitAgentInsightResult, { ok: true }> = {
    ok: true,
    nodeId,
    parsed: parsedResult.parsed,
  };
  if (merged.complete) {
    result.merge = {
      complete: merged.complete,
      insight: merged.insight,
      plan: merged.plan,
      missing: merged.missing,
    };
  }
  return result;
}
