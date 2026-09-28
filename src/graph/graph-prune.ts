import type { GraphEdge, GraphNode } from "../core/types.js";
import type { GraphClient } from "./client-factory.js";
import { isWorkspaceEscapingPath } from "./workspace-containment.js";

/**
 * Graph hygiene: find and remove nodes that are not this project's.
 *
 * The write side is now guarded (see workspace-containment.ts), but every graph
 * in the wild predates that guard, and a graph is a durable store — nothing
 * else would ever remove what already got in. So the read side needs its own
 * answer to the same question.
 *
 * ## Why this is not a generic "delete orphans" pass
 *
 * An orphan node is not necessarily wrong: PLC structured-text program units
 * legitimately produce module nodes with no incoming edges, and a freshly
 * indexed project has plenty of unreferenced files. Deleting on "no edges" would
 * quietly damage real content.
 *
 * So each category has to be *provably* foreign or *provably* not a code
 * module. The three below are:
 *
 *  1. `workspace-escape` — the path leaves the project. Unambiguous, and the
 *     exact shape found in the wild (`../LightNav-0/...`).
 *  2. `link-module` — a `Module` node whose id is an http(s) URL. A URL is a
 *     link target scraped from a markdown badge or a serialized artifact, not a
 *     place in the repository. There is no project whose module is
 *     `https://img.shields.io/badge/...`.
 *  3. `foreign-artifact` — a node whose content is a serialized graph or another
 *     generator's output, i.e. it describes a build result rather than source.
 *
 * Everything is reported by category and by id, never deleted silently, and
 * nothing is deleted without a dry run first.
 */

export type PruneCategory = "workspace-escape" | "link-module" | "foreign-artifact";

export interface PruneClassification {
  nodeId: string;
  category: PruneCategory;
  reason: string;
}

export interface PrunePlan {
  classifications: PruneClassification[];
  byCategory: Record<PruneCategory, number>;
  /** Edges that would be dropped because an endpoint is being removed. */
  danglingEdges: number;
  /** Ids left alone, with a count. Reported so the plan is never a black box. */
  kept: number;
}

const URL_MODULE = /^module:https?:\/\//i;

/**
 * A serialized graph, or another generator's output, described as if it were
 * source. Matched on the *content* shape, not the path, so it catches artifacts
 * that live inside ordinary directories.
 */
const ARTIFACT_CONTENT = /^\s*\{[\s\S]*?"nodes"\s*:\s*\[/;

export function classifyPrunableNode(
  node: Pick<GraphNode, "id" | "type" | "content">
): PruneClassification | null {
  const pathFromId = stripNodePrefix(node.id);
  if (isWorkspaceEscapingPath(pathFromId)) {
    return {
      nodeId: node.id,
      category: "workspace-escape",
      reason: `path leaves the workspace: ${pathFromId}`,
    };
  }
  if (node.type === "Module" && URL_MODULE.test(node.id)) {
    return {
      nodeId: node.id,
      category: "link-module",
      reason: "module node is an http(s) URL — a link target scraped from markdown or an artifact, not a repository location",
    };
  }
  if (ARTIFACT_CONTENT.test(node.content)) {
    return {
      nodeId: node.id,
      category: "foreign-artifact",
      reason: "content is a serialized node collection (a graph snapshot), not source code",
    };
  }
  return null;
}

function stripNodePrefix(id: string): string {
  for (const prefix of ["file:", "symbol:", "module:"]) {
    if (id.startsWith(prefix)) return id.slice(prefix.length);
  }
  return id;
}

export function planGraphPrune(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): PrunePlan {
  const classifications: PruneClassification[] = [];
  for (const node of nodes) {
    const hit = classifyPrunableNode(node);
    if (hit) classifications.push(hit);
  }
  const removing = new Set(classifications.map((entry) => entry.nodeId));
  const danglingEdges = edges.filter(
    (edge) => removing.has(edge.from) || removing.has(edge.to)
  ).length;
  const byCategory: Record<PruneCategory, number> = {
    "workspace-escape": 0,
    "link-module": 0,
    "foreign-artifact": 0,
  };
  for (const entry of classifications) byCategory[entry.category] += 1;
  return {
    classifications,
    byCategory,
    danglingEdges,
    kept: nodes.length - classifications.length,
  };
}

export interface PruneResult extends PrunePlan {
  /** False for a dry run; nothing was deleted. */
  applied: boolean;
  deletedNodes: number;
  deletedEdges: number;
  /** Present when deletion failed — the graph is left untouched in that case. */
  error?: string;
}

/**
 * Plan, then optionally apply. The plan always comes back, so a dry run and a
 * real run report the same thing and the caller can log the dry run first.
 */
export async function pruneGraph(
  client: GraphClient,
  options: { apply?: boolean } = {}
): Promise<PruneResult> {
  const apply = options.apply === true;
  const snapshot = client.readSnapshot?.();
  if (!snapshot) {
    return {
      classifications: [],
      byCategory: { "workspace-escape": 0, "link-module": 0, "foreign-artifact": 0 },
      danglingEdges: 0,
      kept: 0,
      applied: false,
      deletedNodes: 0,
      deletedEdges: 0,
      error: "graph snapshot unavailable — nothing to prune",
    };
  }

  const plan = planGraphPrune(snapshot.nodes, snapshot.edges);
  if (!apply || plan.classifications.length === 0) {
    return { ...plan, applied: false, deletedNodes: 0, deletedEdges: 0 };
  }

  const ids = plan.classifications.map((entry) => entry.nodeId);
  try {
    if (!client.deleteNodes) {
      return {
        ...plan,
        applied: false,
        deletedNodes: 0,
        deletedEdges: 0,
        error: "graph backend does not support node deletion",
      };
    }
    // The sqlite and memory backends cascade dangling edges; the file backend
    // needs them removed explicitly.
    await client.deleteNodes(ids);
    let deletedEdges = plan.danglingEdges;
    if (client.deleteEdge) {
      const removing = new Set(ids);
      const edges = snapshot.edges.filter((edge) => removing.has(edge.from) || removing.has(edge.to));
      for (const edge of edges) {
        await client.deleteEdge(edge.from, edge.to, edge.relation);
      }
    } else {
      deletedEdges = 0;
    }
    return { ...plan, applied: true, deletedNodes: ids.length, deletedEdges };
  } catch (error) {
    return {
      ...plan,
      applied: false,
      deletedNodes: 0,
      deletedEdges: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
