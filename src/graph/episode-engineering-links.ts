/**
 * Link failure (or any) episode Decision nodes to Engineering KG
 * Requirement / Concept / code nodes via derived_from edges.
 *
 * Mirrors document-semantic provenance style (experience ↔ eng nodes),
 * with direction episode → derived_from → requirement|concept|code.
 */

import type { GraphClient } from "./client-factory.js";
import type { GraphEdge } from "../core/types.js";
import { resolveCodeHintTargets } from "./document-semantic-ingest.js";

export type EngineeringLinkHints = {
  requirementIds?: string[];
  conceptIds?: string[];
  /** File paths, symbol names, or file:/symbol: ids resolved against the graph. */
  codeHints?: string[];
};

export type LinkEpisodeResult = {
  episodeId: string;
  edgeCount: number;
  edges: GraphEdge[];
  linkedRequirementIds: string[];
  linkedConceptIds: string[];
  linkedCodeNodeIds: string[];
};

function uniqueNonEmpty(ids: string[] | undefined): string[] {
  if (!ids || ids.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Upsert `derived_from` edges from an episode to Requirement / Concept nodes
 * (and optionally to File/Symbol nodes resolved from codeHints).
 */
export async function linkEpisodeToEngineeringNodes(
  graphClient: GraphClient,
  episodeId: string,
  hints: EngineeringLinkHints
): Promise<LinkEpisodeResult> {
  const linkedRequirementIds = uniqueNonEmpty(hints.requirementIds);
  const linkedConceptIds = uniqueNonEmpty(hints.conceptIds);
  let linkedCodeNodeIds: string[] = [];

  const codeHints = uniqueNonEmpty(hints.codeHints);
  if (codeHints.length > 0) {
    const snapshot = graphClient.readSnapshot?.();
    linkedCodeNodeIds = resolveCodeHintTargets(codeHints, snapshot?.nodes ?? []);
  }

  const edges: GraphEdge[] = [];
  for (const to of linkedRequirementIds) {
    edges.push({ from: episodeId, to, relation: "derived_from" });
  }
  for (const to of linkedConceptIds) {
    edges.push({ from: episodeId, to, relation: "derived_from" });
  }
  for (const to of linkedCodeNodeIds) {
    edges.push({ from: episodeId, to, relation: "derived_from" });
  }

  if (edges.length > 0 && graphClient.upsertEdges) {
    await graphClient.upsertEdges(edges);
  }

  return {
    episodeId,
    edgeCount: edges.length,
    edges,
    linkedRequirementIds,
    linkedConceptIds,
    linkedCodeNodeIds,
  };
}
