import type { GraphNode } from "../core/types";
import type { GraphClient } from "./client-factory";

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
}

export async function buildContextSlice(
  client: GraphClient,
  query: string,
  maxTokens: number
): Promise<ContextSlice> {
  const pkg = await buildLayeredContextPackage(client, query, maxTokens);
  return { items: pkg.summaryChannel, tokenEstimate: pkg.tokenEstimate };
}

export async function buildLayeredContextPackage(
  client: GraphClient,
  query: string,
  maxTokens: number,
  options?: LayeredPackageOptions
): Promise<LayeredContextPackage> {
  const hits = await client.queryByKeyword(query);
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
    tokens += estimate;
    markLayerUsed(layer, used);
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
