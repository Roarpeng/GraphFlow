import type { GraphNode, TaskNode } from "./types";
import type { GraphClient } from "../graph/client-factory";
import type { SixHatsInsight } from "../agents/insight";
import { mergeAgentInsightsFromGraph } from "./merge-agent-insight";
import {
  CLARIFICATION_CONFIDENCE_THRESHOLD,
  extractGoalFromIntentPayload,
  INTENT_GOAL_WORK_ITEM_IDS,
  upsertGoalAnchor,
  type GoalUpsertResult,
} from "./goal-anchor";
import { hashText } from "../utils/hash";
import {
  ingestDocumentSemanticInsight,
  isDocumentSemanticWorkItemId,
} from "../graph/document-semantic-ingest.js";
import { linkEpisodeToEngineeringNodes } from "../graph/episode-engineering-links.js";

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
        needsClarification?: boolean;
        intentConfidence?: number;
      };
      /** Present when the submission created/updated a goal anchor. */
      goal?: {
        goalId: string;
        version: number;
        versioned: boolean;
        changedFields: string[];
        staleEpisodes: number;
        confidence?: number;
      };
      /** Present when document-semantic work items upsert Concept/Requirement nodes. */
      documentGraph?: {
        conceptIds: string[];
        requirementIds: string[];
        edgeCount: number;
        linkedCodeNodeIds: string[];
      };
      /**
       * When episodeId is provided with document-semantic ingest, episode →
       * derived_from → Requirement/Concept/code edges (same provenance as report_outcome).
       */
      engineeringLinks?: {
        edgeCount: number;
        linkedRequirementIds: string[];
        linkedConceptIds: string[];
        linkedCodeNodeIds: string[];
      };
      /** True when the submitted intent confidence is below threshold. */
      needsClarification?: boolean;
    }
  | { ok: false; reason: string };

export const ALIGNMENT_CHECK_WORK_ITEM_ID = "alignment-check";
export const CLARIFICATION_WORK_ITEM_ID = "clarification";

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

function readConfidence(parsed: Record<string, unknown>): number | undefined {
  const raw = parsed.confidence;
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.min(1, Math.max(0, raw))
    : undefined;
}

function isIntentWorkItem(workItemId: string): boolean {
  return (INTENT_GOAL_WORK_ITEM_IDS as readonly string[]).includes(workItemId);
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

  const result: Extract<SubmitAgentInsightResult, { ok: true }> = {
    ok: true,
    nodeId,
    parsed: parsedResult.parsed,
  };

  if (isDocumentSemanticWorkItemId(input.workItemId)) {
    const documentGraph = await ingestDocumentSemanticInsight(
      client,
      parsedResult.parsed,
      nodeId
    );
    if (documentGraph.conceptIds.length > 0 || documentGraph.requirementIds.length > 0) {
      result.documentGraph = documentGraph;
    }
    // Keep experience↔eng provenance consistent with report_outcome wiring:
    // when the insight is tied to an episode, link episode → eng nodes.
    if (
      input.episodeId &&
      (documentGraph.requirementIds.length > 0 ||
        documentGraph.conceptIds.length > 0 ||
        documentGraph.linkedCodeNodeIds.length > 0)
    ) {
      const linked = await linkEpisodeToEngineeringNodes(client, input.episodeId, {
        requirementIds: documentGraph.requirementIds,
        conceptIds: documentGraph.conceptIds,
        codeHints: documentGraph.linkedCodeNodeIds,
      });
      if (linked.edgeCount > 0) {
        result.engineeringLinks = {
          edgeCount: linked.edgeCount,
          linkedRequirementIds: linked.linkedRequirementIds,
          linkedConceptIds: linked.linkedConceptIds,
          linkedCodeNodeIds: linked.linkedCodeNodeIds,
        };
      }
    }
  }

  // P0/P4: intent submissions (and clarifications) maintain the goal anchor.
  const confidence = readConfidence(parsedResult.parsed);
  if (isIntentWorkItem(input.workItemId) || input.workItemId === CLARIFICATION_WORK_ITEM_ID) {
    const goalFields = extractGoalFromIntentPayload(parsedResult.parsed);
    if (goalFields) {
      const upsert: GoalUpsertResult = await upsertGoalAnchor(
        client,
        input.task,
        goalFields,
        confidence
      );
      result.goal = {
        goalId: upsert.goalId,
        version: upsert.record.version,
        versioned: upsert.versioned,
        changedFields: upsert.changedFields,
        staleEpisodes: upsert.staleEpisodes,
        ...(upsert.record.confidence !== undefined
          ? { confidence: upsert.record.confidence }
          : {}),
      };
    }
    // P3: low-confidence intent should trigger a clarification round rather
    // than being silently planned over.
    if (confidence !== undefined && confidence < CLARIFICATION_CONFIDENCE_THRESHOLD) {
      result.needsClarification = true;
    }
  }

  const merged = await mergeAgentInsightsFromGraph(client, input.task);
  if (merged.complete) {
    result.merge = {
      complete: merged.complete,
      insight: merged.insight,
      plan: merged.plan,
      missing: merged.missing,
      ...(merged.needsClarification !== undefined
        ? { needsClarification: merged.needsClarification }
        : {}),
      ...(merged.intentConfidence !== undefined
        ? { intentConfidence: merged.intentConfidence }
        : {}),
    };
  }
  return result;
}
