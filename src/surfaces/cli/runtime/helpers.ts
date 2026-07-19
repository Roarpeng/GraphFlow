import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import type { GraphEdge, GraphNode } from "../../../core/types";
import type { GraphFlowConfig } from "../../../config/schema";
import { resolveGraphStorePath } from "../../../config/paths";
import { GraphifySqliteClient } from "../../../graph/sqlite-client";
import type { GraphClient } from "../../../graph/client-factory";
import type { SkillInsightItem } from "./types.js";

export function extractTokenCost(feedback: string): number {
  const match = feedback.match(/tokens=(\d+)/);
  if (match && match[1]) {
    return Number(match[1]);
  }

  return Math.max(1, Math.ceil(feedback.length / 4));
}

export function loadGraphStore(config: GraphFlowConfig): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const transport = config.graphPolicy.transport;

  if (transport === "memory") {
    return { nodes: [], edges: [] };
  }

  if (transport === "sqlite") {
    const dbPath = resolveGraphStorePath(config);
    try {
      const client = new GraphifySqliteClient(dbPath);
      const snapshot = client.readSnapshot();
      client.close();
      return snapshot;
    } catch {
      const fallbackPath = dbPath.replace(/\.sqlite$/i, ".json");
      return readFileGraphStore(fallbackPath);
    }
  }

  return readFileGraphStore(resolveGraphStorePath(config));
}

export async function resolveGraphStoreAfterIndex(
  config: GraphFlowConfig,
  graphClient: GraphClient
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  if (config.graphPolicy.transport === "memory" && graphClient.readSnapshot) {
    return graphClient.readSnapshot();
  }

  return loadGraphStore(config);
}

export function readFileGraphStore(storePath: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!storePath || !existsSync(storePath)) {
    return { nodes: [], edges: [] };
  }

  try {
    const raw = readFileSync(storePath, "utf8");
    if (!raw.trim()) {
      return { nodes: [], edges: [] };
    }

    const parsed = JSON.parse(raw) as Partial<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
    return {
      nodes: parsed.nodes ?? [],
      edges: parsed.edges ?? [],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

export function getFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function readRawConfig(configPath: string): Partial<GraphFlowConfig> | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as Partial<GraphFlowConfig>;
  } catch {
    return undefined;
  }
}

export function estimateRawContextTokens(
  store: { nodes: GraphNode[]; edges: GraphEdge[] },
  query: string,
  compressedTokens: number
): number {
  const matching = store.nodes.filter((node) => {
    const haystack = `${node.id} ${node.type} ${node.content}`.toLowerCase();
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .filter((item) => item.length >= 2);
    return terms.length === 0 || terms.some((term) => haystack.includes(term));
  });
  const nodes = matching.length > 0 ? matching : store.nodes;
  const rawTokens = nodes.reduce(
    (sum, node) => sum + estimateTokenCount(`${node.id}\n${node.type}\n${node.content}`),
    0
  );

  return Math.max(compressedTokens, rawTokens, estimateTokenCount(query));
}

export function calculateSavingsPercent(rawTokens: number, compressedTokens: number): number {
  if (rawTokens <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(((rawTokens - compressedTokens) / rawTokens) * 100)));
}

export function calculateBudgetUsedPercent(compressedTokens: number, maxContextTokens: number): number {
  if (maxContextTokens <= 0) {
    return 0;
  }

  return Math.max(0, Math.round((compressedTokens / maxContextTokens) * 100));
}

export function estimateTokenCount(text: string): number {
  try {
    const { encode } = require("gpt-tokenizer/model/gpt-4o") as { encode: (t: string) => number[] };
    return Math.max(1, encode(text).length);
  } catch {
    return Math.max(1, Math.ceil(text.replace(/\s+/g, " ").trim().length / 4));
  }
}

export function compactPreview(content: string, maxLength: number): string {
  const compacted = content.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

export function parseSkillInsight(node: GraphNode): SkillInsightItem | undefined {
  try {
    const parsed = JSON.parse(node.content) as Partial<SkillInsightItem> & { hidden?: boolean };
    if (!parsed.id || !parsed.name) {
      return undefined;
    }
    // Soft-hidden toxic skills (pruneFailedSkills) stay out of insights listings.
    if (parsed.hidden === true) {
      return undefined;
    }

    return {
      id: parsed.id,
      name: parsed.name,
      score: parsed.score ?? 0,
      uses: parsed.uses ?? 0,
      lastOutcome: parsed.lastOutcome === "fail" ? "fail" : "pass",
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch {
    return undefined;
  }
}
