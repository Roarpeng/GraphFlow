import { logger } from "../utils/logger";
import type { GraphEdge, GraphNode } from "../core/types";
import {
  cosineSimilarity,
  extractEmbedding,
  reciprocalRankFusion,
  type EmbeddingProvider,
} from "../learning/embeddings";
import type { GraphClient } from "./client-factory";

let encoderFn: ((text: string) => number[]) | null = null;
let encoderLoaded = false;

function getEncoder(): ((text: string) => number[]) | null {
  if (encoderLoaded) return encoderFn;
  encoderLoaded = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("gpt-tokenizer/encoding/o200k_base") as { encode: (t: string) => number[] };
    if (typeof mod.encode === "function") {
      encoderFn = mod.encode.bind(mod);
      return encoderFn;
    }
  } catch (error) {
    logger.error({ error }, "Caught error");
    // fall through
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("gpt-tokenizer") as { encode: (t: string) => number[] };
    if (typeof mod.encode === "function") {
      encoderFn = mod.encode.bind(mod);
      return encoderFn;
    }
  } catch (error) {
    logger.error({ error }, "Caught error");
    // fall through
  }
  encoderFn = null;
  return null;
}

export interface ContextSlice {
  items: string[];
  tokenEstimate: number;
}

export type ContextLayer = "L1" | "L2" | "L3";

export interface ContextAnchorItem {
  id: string;
  type: GraphNode["type"];
  layer: ContextLayer;
}

export interface LayeredContextPackage {
  summaryChannel: string[];
  anchorChannel: ContextAnchorItem[];
  tokenEstimate: number;
  truncated: boolean;
}

export interface LayeredPackageOptions {
  layerQuota?: {
    l1: number;
    l2: number;
    l3: number;
  };
  enableEdgeExpansion?: boolean;
  enableVectorRecall?: boolean;
  embeddingProvider?: EmbeddingProvider;
  vectorTopK?: number;
  vectorMinSimilarity?: number;
}

export interface SubgraphExpansionOptions {
  hops?: number;
  maxNodes?: number;
  relations?: GraphEdge["relation"][];
}

const DEFAULT_EXPANSION_RELATIONS: GraphEdge["relation"][] = [
  "references",
  "imports",
  "depends_on",
  "prerequisite",
];

export async function expandSubgraph(
  client: GraphClient,
  seedIds: string[],
  options?: SubgraphExpansionOptions
): Promise<GraphNode[]> {
  if (typeof client.getNeighbors !== "function") return [];
  const hops = options?.hops ?? 1;
  const maxNodes = options?.maxNodes ?? 20;
  const relations = options?.relations ?? DEFAULT_EXPANSION_RELATIONS;

  const excluded = new Set(seedIds);
  const collected = new Map<string, GraphNode>();
  let frontier = [...seedIds];

  for (let depth = 0; depth < hops; depth += 1) {
    if (frontier.length === 0) break;
    const neighbors = await client.getNeighbors(frontier, relations, "both");
    const nextFrontier: string[] = [];
    for (const { node } of neighbors) {
      if (excluded.has(node.id) || collected.has(node.id)) continue;
      collected.set(node.id, node);
      nextFrontier.push(node.id);
      if (collected.size >= maxNodes) break;
    }
    if (collected.size >= maxNodes) break;
    frontier = nextFrontier;
  }

  return Array.from(collected.values());
}

export async function buildContextSlice(
  client: GraphClient,
  query: string,
  maxTokens: number
): Promise<ContextSlice> {
  const pkg = await buildLayeredContextPackage(client, query, maxTokens);
  return { items: pkg.summaryChannel, tokenEstimate: pkg.tokenEstimate };
}

export function vectorRecall(
  nodes: GraphNode[],
  queryEmbedding: number[],
  topK: number,
  minSimilarity: number
): GraphNode[] {
  if (!queryEmbedding || queryEmbedding.length === 0) return [];
  const scored: { node: GraphNode; sim: number }[] = [];
  for (const node of nodes) {
    const emb = extractEmbedding(node);
    if (!emb) continue;
    const sim = cosineSimilarity(queryEmbedding, emb);
    if (sim >= minSimilarity) scored.push({ node, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, topK).map((s) => s.node);
}

export async function buildLayeredContextPackage(
  client: GraphClient,
  query: string,
  maxTokens: number,
  options?: LayeredPackageOptions
): Promise<LayeredContextPackage> {
  const keywordHits = await client.queryByKeyword(query);
  let hits: GraphNode[] = keywordHits;

  if (options?.enableVectorRecall === true && options.embeddingProvider) {
    try {
      const queryEmbedding = await options.embeddingProvider.embed(query);
      const topK = options.vectorTopK ?? 8;
      const minSim = options.vectorMinSimilarity ?? 0.05;
      const vectorHits = vectorRecall(keywordHits, queryEmbedding, topK, minSim);
      hits = reciprocalRankFusion([keywordHits, vectorHits]);
    } catch (error) {
    logger.error({ error }, "Caught error");
      hits = keywordHits;
    }
  }

  const summaryChannel: string[] = [];
  const anchorChannel: ContextAnchorItem[] = [];
  let tokens = 0;
  let truncated = false;

  const quota = {
    l1: options?.layerQuota?.l1 ?? Number.POSITIVE_INFINITY,
    l2: options?.layerQuota?.l2 ?? Number.POSITIVE_INFINITY,
    l3: options?.layerQuota?.l3 ?? Number.POSITIVE_INFINITY,
  };
  const used = { l1: 0, l2: 0, l3: 0 };
  const added = new Set<string>();

  for (const hit of hits) {
    const layer = classifyLayer(hit);
    if (!canUseLayer(layer, quota, used)) {
      continue;
    }

    const summary = `${hit.type}: ${hit.content}`;
    const estimate = estimateTokens(summary);
    if (tokens + estimate > maxTokens) {
      truncated = true;
      break;
    }

    summaryChannel.push(summary);
    anchorChannel.push({ id: hit.id, type: hit.type, layer });
    added.add(hit.id);
    tokens += estimate;
    markLayerUsed(layer, used);
  }

  const enableExpansion = options?.enableEdgeExpansion !== false;
  if (enableExpansion && !truncated && typeof client.getNeighbors === "function") {
    const seedIds = anchorChannel.slice(0, 5).map((a) => a.id);
    if (seedIds.length > 0) {
      const expanded = await expandSubgraph(client, seedIds, { hops: 1 });
      for (const node of expanded) {
        if (added.has(node.id)) continue;
        const layer = classifyLayer(node);
        if (!canUseLayer(layer, quota, used)) continue;

        const summary = `${node.type}: ${node.content}`;
        const estimate = estimateTokens(summary);
        if (tokens + estimate > maxTokens) {
          truncated = true;
          break;
        }

        summaryChannel.push(summary);
        anchorChannel.push({ id: node.id, type: node.type, layer });
        added.add(node.id);
        tokens += estimate;
        markLayerUsed(layer, used);
      }
    }
  }

  return { summaryChannel, anchorChannel, tokenEstimate: tokens, truncated };
}

export interface ContextRefillManager {
  initialPackage(query: string): Promise<LayeredContextPackage>;
  refill(evidenceHints: string[]): Promise<string[]>;
}

export function createContextRefillManager(
  client: GraphClient,
  maxTokens: number,
  options?: LayeredPackageOptions
): ContextRefillManager {
  const seenAnchors = new Set<string>();

  return {
    async initialPackage(query: string): Promise<LayeredContextPackage> {
      const pkg = await buildLayeredContextPackage(client, query, maxTokens, options);
      for (const anchor of pkg.anchorChannel) {
        seenAnchors.add(anchor.id);
      }
      return pkg;
    },
    async refill(evidenceHints: string[]): Promise<string[]> {
      const items: string[] = [];
      let tokens = 0;

      for (const hint of evidenceHints) {
        const hits = await client.queryByKeyword(hint);
        for (const hit of hits) {
          if (seenAnchors.has(hit.id)) {
            continue;
          }

          const line = `${hit.id} | ${hit.type}: ${hit.content}`;
          const estimate = estimateTokens(line);
          if (tokens + estimate > maxTokens) {
            return items;
          }

          seenAnchors.add(hit.id);
          tokens += estimate;
          items.push(line);
          break;
        }
      }

      return items;
    },
  };
}

function estimateTokens(text: string): number {
  const enc = getEncoder();
  if (enc) {
    try {
      const n = enc(text).length;
      return Math.max(1, n);
    } catch (error) {
    logger.error({ error }, "Caught error");
      // fall back below
    }
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

export function summarizeNodes(nodes: GraphNode[]): string[] {
  return nodes.map((node) => `${node.type}(${node.id})`);
}

function classifyLayer(node: GraphNode): ContextLayer {
  if (node.type === "File" || node.type === "Symbol") {
    return "L1";
  }

  if (node.type === "Module") {
    return "L2";
  }

  return "L3";
}

function canUseLayer(
  layer: ContextLayer,
  quota: { l1: number; l2: number; l3: number },
  used: { l1: number; l2: number; l3: number }
): boolean {
  if (layer === "L1") {
    return used.l1 < quota.l1;
  }

  if (layer === "L2") {
    return used.l2 < quota.l2;
  }

  return used.l3 < quota.l3;
}

function markLayerUsed(layer: ContextLayer, used: { l1: number; l2: number; l3: number }): void {
  if (layer === "L1") {
    used.l1 += 1;
    return;
  }

  if (layer === "L2") {
    used.l2 += 1;
    return;
  }

  used.l3 += 1;
}
