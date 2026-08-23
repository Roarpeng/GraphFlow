import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient } from "./client-factory";

export type KnowledgeGovernanceKind = "adr" | "invariant" | "api-contract" | "test";
export type KnowledgeGovernanceStatus = "draft" | "in_review" | "approved" | "superseded" | "rejected";

export interface KnowledgeGovernanceInput {
  kind: KnowledgeGovernanceKind;
  key: string;
  title: string;
  content: string;
  version?: number;
  status?: Exclude<KnowledgeGovernanceStatus, "superseded">;
  validFrom?: string;
  validUntil?: string;
  owner?: string;
  sourceIds?: readonly string[];
  requirementId?: string;
  retentionUntil?: string;
}

export interface KnowledgeGovernanceRecord {
  kind: KnowledgeGovernanceKind;
  key: string;
  title: string;
  version: number;
  status: KnowledgeGovernanceStatus;
  validFrom: string;
  validUntil?: string;
  owner?: string;
  supersededBy?: string;
  review?: {
    state: "none" | "requested" | "approved" | "rejected";
    actor?: string;
    at?: string;
    reason?: string;
  };
  retentionUntil?: string;
  updatedAt: number;
}

export interface KnowledgeUpsertResult {
  nodeId: string;
  record: KnowledgeGovernanceRecord;
  supersededNodeId?: string;
  edges: GraphEdge[];
}

const KINDS = new Set(["adr", "invariant", "api-contract", "test"]);
const NODE_TYPES: Record<KnowledgeGovernanceKind, GraphNode["type"]> = {
  adr: "ADR",
  invariant: "Invariant",
  "api-contract": "APIContract",
  test: "Test",
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function knowledgeId(
  kind: KnowledgeGovernanceKind,
  key: string,
  version: number
): string {
  return `knowledge:${kind}:${slug(key)}@v${version}`;
}

async function loadNode(client: GraphClient, id: string): Promise<GraphNode | undefined> {
  const direct = client.getNodesByIds ? (await client.getNodesByIds([id])).find((n) => n.id === id) : undefined;
  if (direct) return direct;
  return (await client.queryByKeyword(id)).find((n) => n.id === id);
}

export async function upsertKnowledgeNode(
  client: GraphClient,
  input: KnowledgeGovernanceInput
): Promise<KnowledgeUpsertResult> {
  if (!KINDS.has(input.kind)) throw new Error(`Unsupported knowledge kind: ${input.kind}`);
  const allNodes = client.readSnapshot?.().nodes ?? [];
  const priorVersions = allNodes.filter((node) => {
    const record = node.metadata?.record as Partial<KnowledgeGovernanceRecord> | undefined;
    return record?.kind === input.kind && record?.key === input.key;
  });
  const nextVersion = input.version ?? Math.max(0, ...priorVersions.map((node) => {
    const record = node.metadata?.record as Partial<KnowledgeGovernanceRecord> | undefined;
    return record?.version ?? 0;
  })) + 1;
  const id = knowledgeId(input.kind, input.key, nextVersion);
  const existing = await loadNode(client, id);
  const existingRecord = existing?.metadata?.record as Partial<KnowledgeGovernanceRecord> | undefined;
  const status: KnowledgeGovernanceStatus =
    input.status ?? (existingRecord?.status === "approved" ? "in_review" : "draft");
  const now = Date.now();
  const record: KnowledgeGovernanceRecord = {
    kind: input.kind,
    key: input.key,
    title: input.title,
    version: nextVersion,
    status,
    validFrom: input.validFrom ?? existingRecord?.validFrom ?? new Date().toISOString(),
    ...(input.validUntil || existingRecord?.validUntil
      ? { validUntil: input.validUntil ?? existingRecord!.validUntil }
      : {}),
    ...(input.owner || existingRecord?.owner
      ? { owner: input.owner ?? existingRecord!.owner }
      : {}),
    ...(input.retentionUntil || existingRecord?.retentionUntil
      ? { retentionUntil: input.retentionUntil ?? existingRecord!.retentionUntil }
      : {}),
    review: {
      state: status === "approved" ? "approved" : status === "in_review" ? "requested" : "none",
      ...(status === "approved" ? { at: new Date().toISOString() } : {}),
    },
    updatedAt: now,
  };

  const node: GraphNode = {
    id,
    type: NODE_TYPES[input.kind],
    content: `${input.title}\n${input.content}`,
    metadata: { record, governanceKind: input.kind },
  };
  await client.upsertNodes([node]);

  const edges: GraphEdge[] = [];
  let supersededNodeId: string | undefined;
  if (status === "approved") {
    for (const candidate of allNodes) {
      const candidateRecord = candidate.metadata?.record as Partial<KnowledgeGovernanceRecord> | undefined;
      if (
        candidate.id !== id &&
        candidateRecord?.kind === input.kind &&
        candidateRecord?.key === input.key &&
        candidateRecord?.status === "approved"
      ) {
        supersededNodeId = candidate.id;
        await client.upsertNodes([{
          ...candidate,
          metadata: {
            ...candidate.metadata,
            record: {
              ...candidateRecord,
              status: "superseded",
              supersededBy: id,
              updatedAt: Date.now(),
            } as KnowledgeGovernanceRecord,
          },
        }]);
        edges.push({ from: id, to: candidate.id, relation: "supersedes" });
        break;
      }
    }
  }

  for (const sourceId of input.sourceIds ?? []) {
    edges.push({ from: id, to: sourceId, relation: "derived_from" });
  }
  if (input.requirementId) {
    edges.push({ from: input.requirementId, to: id, relation: "governed_by" });
  }
  if (edges.length > 0) await client.upsertEdges(edges);

  return { nodeId: id, record, ...(supersededNodeId ? { supersededNodeId } : {}), edges };
}

export async function supersedeKnowledgeNode(
  client: GraphClient,
  oldId: string,
  newId: string
): Promise<{ updated: boolean }> {
  const oldNode = await loadNode(client, oldId);
  if (!oldNode) return { updated: false };
  const record = oldNode.metadata?.record as Partial<KnowledgeGovernanceRecord>;
  await client.upsertNodes([{
    ...oldNode,
    metadata: {
      ...oldNode.metadata,
      record: { ...record, status: "superseded", supersededBy: newId, updatedAt: Date.now() },
    },
  }]);
  await client.upsertEdges([{ from: newId, to: oldId, relation: "supersedes" }]);
  return { updated: true };
}

export interface KnowledgeReviewItem {
  nodeId: string;
  title: string;
  kind: KnowledgeGovernanceKind;
  status: KnowledgeGovernanceStatus;
  owner?: string;
}

export function listKnowledgeReviewQueue(nodes: GraphNode[]): KnowledgeReviewItem[] {
  return nodes.flatMap((node) => {
    const record = node.metadata?.record as Partial<KnowledgeGovernanceRecord> | undefined;
    if (!record || (record.status !== "draft" && record.status !== "in_review")) return [];
    return [{
      nodeId: node.id,
      title: record.title ?? node.content,
      kind: record.kind!,
      status: record.status,
      ...(record.owner ? { owner: record.owner } : {}),
    }];
  });
}

export interface RequirementTraceability {
  requirement?: GraphNode;
  code: Array<{ node: GraphNode; relation: GraphEdge["relation"] }>;
  tests: Array<{ node: GraphNode; relation: GraphEdge["relation"] }>;
  governance: Array<{ node: GraphNode; relation: GraphEdge["relation"] }>;
  episodes: Array<{ node: GraphNode; relation: GraphEdge["relation"] }>;
}

export async function buildRequirementTraceability(
  client: GraphClient,
  requirementId: string
): Promise<RequirementTraceability> {
  let requirement: GraphNode | undefined;
  const related: Array<{ node: GraphNode; relation: GraphEdge["relation"] }> = [];
  if (client.getNeighbors) {
    for (const item of await client.getNeighbors([requirementId], undefined, "both")) {
      if (!requirement && item.node.id === requirementId) requirement = item.node;
      else related.push({ node: item.node, relation: item.via });
    }
  } else {
    for (const node of await client.queryByKeyword(requirementId)) {
      if (node.id === requirementId) requirement = node;
    }
  }
  const classify = (node: GraphNode) =>
    node.type === "Test" || node.id.startsWith("test:")
      ? "tests" as const
      : ["ADR", "Invariant", "APIContract"].includes(node.type)
        ? "governance" as const
        : node.type === "Decision"
          ? "episodes" as const
          : "code" as const;
  return {
    ...(requirement ? { requirement } : {}),
    code: related.filter((item) => classify(item.node) === "code"),
    tests: related.filter((item) => classify(item.node) === "tests"),
    governance: related.filter((item) => classify(item.node) === "governance"),
    episodes: related.filter((item) => classify(item.node) === "episodes"),
  };
}
