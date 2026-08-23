import { createHmac, timingSafeEqual } from "node:crypto";

import type { GraphEdge, GraphNode } from "../core/types";
import type { GraphClient } from "./client-factory";
import {
  verifyAuditChain,
} from "../learning/evidence";

export type GovernanceRole = "viewer" | "editor" | "approver" | "admin";
export const ROLE_RANK: Record<GovernanceRole, number> = {
  viewer: 0,
  editor: 1,
  approver: 2,
  admin: 3,
};

export function assertRole(actual: string | undefined, required: GovernanceRole): void {
  const role = (actual ?? "viewer") as GovernanceRole;
  if (!(role in ROLE_RANK) || ROLE_RANK[role] < ROLE_RANK[required]) {
    throw new Error(`requires ${required} role`);
  }
}

function canonicalNode(node: GraphNode): string {
  return JSON.stringify({ id: node.id, type: node.type, content: node.content, metadata: node.metadata });
}

function canonicalEdge(edge: GraphEdge): string {
  return `${edge.from}\u0000${edge.relation}\u0000${edge.to}`;
}

export interface GraphArtifactData {
  version?: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ArtifactMergeConflict {
  kind: "node" | "edge";
  id: string;
  base?: string;
  local?: string;
  remote?: string;
}

export interface ArtifactMergeResult {
  merged: GraphArtifactData;
  conflicts: ArtifactMergeConflict[];
}

/**
 * Deterministic three-way graph merge. Same-key edits become explicit review
 * conflicts instead of letting a timestamp silently overwrite engineering
 * decisions.
 */
export function mergeGraphArtifacts(
  base: GraphArtifactData,
  local: GraphArtifactData,
  remote: GraphArtifactData
): ArtifactMergeResult {
  const byId = <T extends { id: string }>(items: readonly T[]) => new Map(items.map((item) => [item.id, item]));
  const baseNodes = byId(base.nodes);
  const localNodes = byId(local.nodes);
  const remoteNodes = byId(remote.nodes);
  const nodes = new Map<string, GraphNode>();
  const conflicts: ArtifactMergeConflict[] = [];

  for (const id of new Set([...baseNodes.keys(), ...localNodes.keys(), ...remoteNodes.keys()])) {
    const b = baseNodes.get(id);
    const l = localNodes.get(id);
    const r = remoteNodes.get(id);
    if (l && r) {
      if (canonicalNode(l) === canonicalNode(r)) nodes.set(id, l);
      else if (b && canonicalNode(b) === canonicalNode(l)) nodes.set(id, r);
      else if (b && canonicalNode(b) === canonicalNode(r)) nodes.set(id, l);
      else {
        conflicts.push({
          kind: "node",
          id,
          ...(b ? { base: canonicalNode(b) } : {}),
          local: canonicalNode(l),
          remote: canonicalNode(r),
        });
        nodes.set(id, r);
      }
      continue;
    }
    if (l) nodes.set(id, l);
    else if (r) nodes.set(id, r);
  }

  const edgeKey = (edge: GraphEdge) => canonicalEdge(edge);
  const byEdge = <T extends GraphEdge>(edges: readonly T[]) => new Map(edges.map((edge) => [edgeKey(edge), edge]));
  const baseEdges = byEdge(base.edges);
  const localEdges = byEdge(local.edges);
  const remoteEdges = byEdge(remote.edges);
  const edges = new Map<string, GraphEdge>();
  for (const key of new Set([...baseEdges.keys(), ...localEdges.keys(), ...remoteEdges.keys()])) {
    const l = localEdges.get(key)!;
    const r = remoteEdges.get(key)!;
    if (l && r) edges.set(key, r);
    else if (l) edges.set(key, l);
    else if (r) edges.set(key, r);
  }

  return { merged: { nodes: [...nodes.values()], edges: [...edges.values()] }, conflicts };
}

export function signArtifact(payload: unknown, secret: string): { signature: string; algorithm: "hmac-sha256" } {
  return { signature: createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex"), algorithm: "hmac-sha256" };
}

export function verifyArtifactSignature(
  payload: unknown,
  signature: string,
  secret: string
): boolean {
  const expected = Buffer.from(signArtifact(payload, secret).signature, "hex");
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function approveGraphNode(
  client: GraphClient,
  nodeId: string,
  role: string,
  decision: "approved" | "rejected",
  reason?: string
): Promise<{ updated: boolean }> {
  assertRole(role, "approver");
  const direct = client.getNodesByIds ? await client.getNodesByIds([nodeId]) : [];
  const node = direct.find((item) => item.id === nodeId)
    ?? (await client.queryByKeyword(nodeId)).find((item) => item.id === nodeId);
  if (!node) return { updated: false };
  await client.upsertNodes([{
    ...node,
    metadata: {
      ...node.metadata,
      review: { state: decision, at: new Date().toISOString(), ...(reason ? { reason } : {}) },
    },
  }]);
  return { updated: true };
}

export function applyRetentionPolicy(nodes: GraphNode[], now = Date.now()): {
  retained: GraphNode[];
  expired: GraphNode[];
} {
  const retained: GraphNode[] = [];
  const expired: GraphNode[] = [];
  for (const node of nodes) {
    const until = typeof node.metadata?.retentionUntil === "string"
      ? Date.parse(node.metadata.retentionUntil as string)
      : Number.NaN;
    if (Number.isFinite(until) && until <= now) expired.push(node);
    else retained.push(node);
  }
  return { retained, expired };
}


export async function propagateQuarantine(
  client: GraphClient,
  rootIds: readonly string[],
  options: { actor?: string; auditPath?: string; reason?: string } = {}
): Promise<{ quarantined: string[]; auditValid: boolean }> {
  const snapshot = client.readSnapshot?.();
  if (!snapshot) return { quarantined: [], auditValid: true };
  const roots = new Set(rootIds);
  const adjacent = new Set<string>();
  if (!client.getNeighbors) return { quarantined: [], auditValid: true };
  for (const item of await client.getNeighbors([...roots], undefined, "both")) {
    if (!roots.has(item.node.id)) adjacent.add(item.node.id);
  }
  const updates: GraphNode[] = [];
  for (const node of snapshot.nodes) {
    const provenance = (node.metadata?.provenance ?? {}) as { episodeId?: string };
    if (!adjacent.has(node.id) && !(provenance.episodeId && roots.has(provenance.episodeId))) continue;
    if (node.metadata?.governanceQuarantined === true) continue;
    updates.push({
      ...node,
      metadata: {
        ...node.metadata,
        governanceQuarantined: true,
        review: {
          state: "rejected",
          actor: options.actor ?? "quarantine-propagation",
          at: new Date().toISOString(),
          ...(options.reason ? { reason: options.reason } : {}),
        },
      },
    });
  }
  if (updates.length > 0) await client.upsertNodes(updates);
  let auditEvents: Parameters<typeof verifyAuditChain>[0] = [];
  if (options.auditPath) {
    try {
      const { readAuditEvents } = await import("../learning/evidence.js");
      auditEvents = readAuditEvents(options.auditPath);
    } catch {
      auditEvents = [{ seq: -1, at: "", actor: "", action: "", subject: "", tenant: "", prevHash: "", hash: "invalid" }];
    }
  }
  return { quarantined: updates.map((node) => node.id), auditValid: verifyAuditChain(auditEvents) };
}
