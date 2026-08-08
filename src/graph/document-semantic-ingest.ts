/**
 * Upsert document-domain Concept/Requirement nodes and cross-layer edges
 * after a document-semantic bridge submission.
 *
 * Logical Engineering KG (single store):
 *   code ←documents/implements→ doc ←derived_from→ experience(insight)
 */

import type { GraphClient } from "./client-factory.js";
import type { GraphEdge, GraphNode } from "../core/types.js";
import { hashText } from "../utils/hash.js";

export interface DocumentSemanticPayload {
  relPath?: string;
  title?: string;
  summary?: string;
  keyEntities?: string[];
  keyClaims?: string[];
  /** Prefer explicit requirements when present; else keyClaims are used. */
  requirements?: string[];
  relatedCodeHints?: string[];
  tags?: string[];
}

export interface DocumentSemanticIngestResult {
  conceptIds: string[];
  requirementIds: string[];
  edgeCount: number;
  linkedCodeNodeIds: string[];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asString(item))
    .filter((item) => item.length > 0);
}

export function parseDocumentSemanticPayload(
  parsed: Record<string, unknown>
): DocumentSemanticPayload {
  const payload: DocumentSemanticPayload = {
    keyEntities: asStringArray(parsed.keyEntities),
    keyClaims: asStringArray(parsed.keyClaims),
    requirements: asStringArray(parsed.requirements),
    relatedCodeHints: asStringArray(parsed.relatedCodeHints),
    tags: asStringArray(parsed.tags),
  };
  const relPath = asString(parsed.relPath);
  if (relPath) {
    payload.relPath = relPath;
  }
  const title = asString(parsed.title);
  if (title) {
    payload.title = title;
  }
  const summary = asString(parsed.summary);
  if (summary) {
    payload.summary = summary;
  }
  return payload;
}

function conceptNodeId(relPath: string, name: string): string {
  return `concept:${hashText(`${relPath}|${name.toLowerCase()}`)}`;
}

function requirementNodeId(relPath: string, claim: string): string {
  return `requirement:${hashText(`${relPath}|${claim.toLowerCase()}`)}`;
}

/**
 * Resolve relatedCodeHints against existing File/Symbol nodes.
 * Paths prefer file: ids; bare names match Symbol metadata.name or content.
 */
export function resolveCodeHintTargets(
  hints: string[],
  nodes: GraphNode[],
  maxLinks = 12
): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const symbols = nodes.filter((n) => n.type === "Symbol");
  const files = nodes.filter((n) => n.type === "File");
  const found: string[] = [];
  const seen = new Set<string>();

  const push = (id: string): void => {
    if (seen.has(id) || found.length >= maxLinks) {
      return;
    }
    if (!byId.has(id)) {
      return;
    }
    seen.add(id);
    found.push(id);
  };

  for (const raw of hints) {
    if (found.length >= maxLinks) {
      break;
    }
    const hint = raw.trim();
    if (!hint) {
      continue;
    }

    if (hint.startsWith("file:") || hint.startsWith("symbol:")) {
      push(hint);
      continue;
    }

    const normalized = hint.replace(/\\/g, "/");
    const asFileId = `file:${normalized.replace(/^\.\//, "")}`;
    if (byId.has(asFileId)) {
      push(asFileId);
      continue;
    }

    const lower = normalized.toLowerCase();
    const fileHit = files.find((f) => {
      const path = f.id.slice("file:".length).toLowerCase();
      return path === lower || path.endsWith(`/${lower}`) || path.endsWith(lower);
    });
    if (fileHit) {
      push(fileHit.id);
      continue;
    }

    const name = normalized.includes("/")
      ? (normalized.split("/").pop() ?? normalized)
      : normalized;
    const nameLower = name.toLowerCase().replace(/\.(ts|tsx|js|jsx|py|go|rs|java)$/i, "");
    const symbolHit = symbols.find((s) => {
      const metaName = asString(s.metadata?.name).toLowerCase();
      if (metaName && metaName === nameLower) {
        return true;
      }
      return s.content.toLowerCase().includes(nameLower);
    });
    if (symbolHit) {
      push(symbolHit.id);
    }
  }

  return found;
}

/**
 * Build Concept/Requirement nodes + cross-layer edges from a bridge payload.
 */
export function buildDocumentSemanticGraphFragment(
  payload: DocumentSemanticPayload,
  options: {
    insightNodeId: string;
    existingNodes?: GraphNode[];
    maxConcepts?: number;
    maxRequirements?: number;
  }
): { nodes: GraphNode[]; edges: GraphEdge[]; linkedCodeNodeIds: string[] } {
  const relPath = payload.relPath?.trim();
  if (!relPath) {
    return { nodes: [], edges: [], linkedCodeNodeIds: [] };
  }

  const maxConcepts = options.maxConcepts ?? 12;
  const maxRequirements = options.maxRequirements ?? 12;
  const fileNodeId = `file:${relPath}`;
  const entities = (payload.keyEntities ?? []).slice(0, maxConcepts);
  const requirements = (
    (payload.requirements?.length ? payload.requirements : payload.keyClaims) ?? []
  ).slice(0, maxRequirements);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const conceptIds: string[] = [];
  const requirementIds: string[] = [];

  for (const name of entities) {
    const id = conceptNodeId(relPath, name);
    conceptIds.push(id);
    nodes.push({
      id,
      type: "Concept",
      content: name,
      metadata: {
        domain: "doc",
        kind: "concept",
        sourcePath: relPath,
        title: payload.title,
        tags: payload.tags ?? [],
      },
    });
    edges.push({ from: fileNodeId, to: id, relation: "documents" });
    edges.push({ from: id, to: fileNodeId, relation: "derived_from" });
    edges.push({ from: id, to: options.insightNodeId, relation: "derived_from" });
  }

  for (const claim of requirements) {
    const id = requirementNodeId(relPath, claim);
    requirementIds.push(id);
    nodes.push({
      id,
      type: "Requirement",
      content: claim.slice(0, 500),
      metadata: {
        domain: "doc",
        kind: "requirement",
        sourcePath: relPath,
        title: payload.title,
        tags: payload.tags ?? [],
      },
    });
    edges.push({ from: fileNodeId, to: id, relation: "documents" });
    edges.push({ from: id, to: fileNodeId, relation: "derived_from" });
    edges.push({ from: id, to: options.insightNodeId, relation: "derived_from" });
  }

  // Optional: enrich the File node summary via a lightweight Decision-adjacent metadata node —
  // skip; File already exists from indexing.

  const linkedCodeNodeIds = resolveCodeHintTargets(
    payload.relatedCodeHints ?? [],
    options.existingNodes ?? []
  );

  for (const codeId of linkedCodeNodeIds) {
    for (const reqId of requirementIds) {
      edges.push({ from: codeId, to: reqId, relation: "implements" });
    }
    edges.push({ from: fileNodeId, to: codeId, relation: "references" });
  }

  // If summary present, attach as a Concept titled by document title
  const title = payload.title?.trim();
  const summary = payload.summary?.trim();
  if (title && summary && !entities.some((e) => e.toLowerCase() === title.toLowerCase())) {
    const id = conceptNodeId(relPath, `title:${title}`);
    nodes.push({
      id,
      type: "Concept",
      content: `${title} — ${summary}`.slice(0, 500),
      metadata: {
        domain: "doc",
        kind: "document-summary",
        sourcePath: relPath,
        title,
        tags: payload.tags ?? [],
      },
    });
    edges.push({ from: fileNodeId, to: id, relation: "documents" });
    edges.push({ from: id, to: fileNodeId, relation: "derived_from" });
    edges.push({ from: id, to: options.insightNodeId, relation: "derived_from" });
  }

  return { nodes, edges, linkedCodeNodeIds };
}

export async function ingestDocumentSemanticInsight(
  client: GraphClient,
  parsed: Record<string, unknown>,
  insightNodeId: string
): Promise<DocumentSemanticIngestResult> {
  const payload = parseDocumentSemanticPayload(parsed);
  const snapshot = client.readSnapshot?.();
  const fragment = buildDocumentSemanticGraphFragment(payload, {
    insightNodeId,
    existingNodes: snapshot?.nodes ?? [],
  });

  if (fragment.nodes.length > 0) {
    await client.upsertNodes(fragment.nodes);
  }
  if (fragment.edges.length > 0 && client.upsertEdges) {
    await client.upsertEdges(fragment.edges);
  }

  return {
    conceptIds: fragment.nodes.filter((n) => n.type === "Concept").map((n) => n.id),
    requirementIds: fragment.nodes.filter((n) => n.type === "Requirement").map((n) => n.id),
    edgeCount: fragment.edges.length,
    linkedCodeNodeIds: fragment.linkedCodeNodeIds,
  };
}

export function isDocumentSemanticWorkItemId(workItemId: string): boolean {
  return workItemId.startsWith("document-semantic");
}
