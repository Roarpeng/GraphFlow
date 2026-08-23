import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { GraphEdge, GraphNode } from "../src/core/types";
import type { GraphClient } from "../src/graph/client-factory";
import {
  normalizeOutcomeEvidence,
  verifyOutcomeEvidence,
} from "../src/learning/evidence";
import { decryptJson, encryptJson } from "../src/security/secure-store";
import {
  issueLocalJwt,
  verifyAccessToken,
} from "../src/security/token-auth";
import { recordEpisode, updateEpisodeOutcome } from "../src/learning/episodic-memory";
import {
  listKnowledgeReviewQueue,
  upsertKnowledgeNode,
} from "../src/graph/engineering-knowledge";
import {
  applyRetentionPolicy,
  mergeGraphArtifacts,
  signArtifact,
  verifyArtifactSignature,
} from "../src/graph/team-governance";

class MemoryGraphClient implements GraphClient {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    for (const node of nodes) this.nodes.set(node.id, node);
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    for (const edge of edges) {
      this.edges.set(`${edge.from}|${edge.relation}|${edge.to}`, edge);
    }
  }

  async queryByKeyword(query: string): Promise<GraphNode[]> {
    return [...this.nodes.values()].filter((node) =>
      node.id.includes(query) || node.content.includes(query)
    );
  }

  readSnapshot() {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }

  async getNodesByIds(ids: string[]): Promise<GraphNode[]> {
    return ids.map((id) => this.nodes.get(id)).filter((node): node is GraphNode => Boolean(node));
  }

  async getNeighbors(nodeIds: string[]) {
    const roots = new Set(nodeIds);
    const out: Array<{ node: GraphNode; via: GraphEdge["relation"] }> = [];
    for (const edge of this.edges.values()) {
      if (roots.has(edge.from)) {
        const node = this.nodes.get(edge.to);
        if (node) out.push({ node, via: edge.relation });
      }
      if (roots.has(edge.to)) {
        const node = this.nodes.get(edge.from);
        if (node) out.push({ node, via: edge.relation });
      }
    }
    return out;
  }
}

describe("P0-P2 governance foundation", () => {
  it("normalizes outcome evidence and distinguishes verified from partial evidence", () => {
    const verified = normalizeOutcomeEvidence({
      repository: "example/repo",
      commit: "abc123",
      diff: "changed src/auth.ts",
      testCommand: "npm test",
      testResult: "pass",
      userConfirmed: true,
      source: "ci",
    });
    expect(verified?.testResult).toBe("pass");
    expect(verifyOutcomeEvidence(verified)).toEqual({ level: "verified", reasons: [] });
    expect(verifyOutcomeEvidence(normalizeOutcomeEvidence({
      commit: "abc123",
      diff: "",
      testCommand: "npm test",
      testResult: "unknown",
    })).level).toBe("partial");
    expect(verifyOutcomeEvidence(undefined).level).toBe("unverified");
  });

  it("stores an evidence package on a closed episode", async () => {
    const client = new MemoryGraphClient();
    const episode = await recordEpisode(client, {
      task: "harden the evidence runtime in src/learning/evidence.ts",
      plan: [],
      outcome: "pending",
      keyDecisions: [],
      lessons: [],
      attempts: 1,
    });
    const updated = await updateEpisodeOutcome(
      client,
      episode.id,
      "pass",
      ["use OutcomeEvidence in episodic-memory"],
      undefined,
      {
        commit: "abc123",
        diff: "modified src/learning/evidence.ts",
        testCommand: "npx vitest run tests/p0-p2-governance.test.ts",
        testResult: "pass",
        userConfirmed: true,
      }
    );
    expect(updated?.evidence?.commit).toBe("abc123");
    expect(await client.getNodesByIds([episode.id])).toHaveLength(1);
  });

  it("versions approved engineering knowledge and supersedes the prior version", async () => {
    const client = new MemoryGraphClient();
    const first = await upsertKnowledgeNode(client, {
      kind: "adr",
      key: "memory-plane",
      title: "Use local-first memory",
      content: "Keep code and experience local by default.",
      status: "approved",
    });
    const second = await upsertKnowledgeNode(client, {
      kind: "adr",
      key: "memory-plane",
      title: "Use governed local-first memory",
      content: "Add review, retention and audit controls.",
      status: "approved",
    });
    const oldRecord = client.nodes.get(first.nodeId)?.metadata?.record as {
      status?: string;
      supersededBy?: string;
    };
    expect(second.record.version).toBe(2);
    expect(second.supersededNodeId).toBe(first.nodeId);
    expect(oldRecord.status).toBe("superseded");
    expect(oldRecord.supersededBy).toBe(second.nodeId);
    expect(listKnowledgeReviewQueue(client.readSnapshot().nodes)).toHaveLength(0);
  });

  it("reports graph merge conflicts and supports signed artifacts plus retention", () => {
    const base = {
      nodes: [{ id: "file:a", type: "File" as const, content: "one", metadata: {} }],
      edges: [],
    };
    const local = {
      nodes: [{ id: "file:a", type: "File" as const, content: "local", metadata: {} }],
      edges: [],
    };
    const remote = {
      nodes: [
        { id: "file:a", type: "File" as const, content: "remote", metadata: {} },
        { id: "file:b", type: "File" as const, content: "new remote", metadata: {} },
      ],
      edges: [],
    };
    const merged = mergeGraphArtifacts(base, local, remote);
    expect(merged.merged.nodes).toHaveLength(2);
    expect(merged.conflicts).toHaveLength(1);

    const payload = { sha256: "abc" };
    const signature = signArtifact(payload, "secret");
    expect(verifyArtifactSignature(payload, signature.signature, "secret")).toBe(true);
    expect(verifyArtifactSignature(payload, signature.signature, "wrong")).toBe(false);

    const now = Date.now();
    const retained = applyRetentionPolicy([
      { id: "keep", type: "Decision" as const, content: "", metadata: {} },
      { id: "expire", type: "Decision" as const, content: "", metadata: { retentionUntil: new Date(now - 1).toISOString() } },
    ], now);
    expect(retained.retained.map((node) => node.id)).toEqual(["keep"]);
    expect(retained.expired.map((node) => node.id)).toEqual(["expire"]);
  });

  it("round-trips encrypted governance snapshots and verifies OIDC-compatible JWT claims", async () => {
    const envelope = encryptJson({ nodes: [1, 2, 3] }, "passphrase");
    expect(decryptJson<{ nodes: number[] }>(envelope, "passphrase").nodes).toEqual([1, 2, 3]);
    expect(() => decryptJson(envelope, "wrong")).toThrow();

    const secret = "jwt-secret";
    const token = issueLocalJwt("user-1", secret, {
      issuer: "https://issuer.example",
      audience: "graphflow-mcp",
      scope: "memory:read memory:write",
    });
    const accepted = await verifyAccessToken(`Bearer ${token}`, {
      jwtSecret: secret,
      issuer: "https://issuer.example",
      audience: "graphflow-mcp",
      requiredScope: "memory:write",
    });
    expect(accepted).toMatchObject({ authenticated: true, subject: "user-1" });
    const rejected = await verifyAccessToken(`Bearer ${token}`, {
      jwtSecret: createHmac("sha256", "other").update("x").digest("hex"),
    });
    expect(rejected.authenticated).toBe(false);
  });
});
