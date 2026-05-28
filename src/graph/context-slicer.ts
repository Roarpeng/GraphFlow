import type { GraphNode } from "../core/types";
import type { GraphClient } from "./client-factory";

export interface ContextSlice {
  items: string[];
  tokenEstimate: number;
}

export async function buildContextSlice(
  client: GraphClient,
  query: string,
  maxTokens: number
): Promise<ContextSlice> {
  const hits = await client.queryByKeyword(query);
  const items: string[] = [];
  let tokens = 0;

  for (const hit of hits) {
    const line = `${hit.type}: ${hit.content}`;
    const estimate = estimateTokens(line);
    if (tokens + estimate > maxTokens) {
      break;
    }

    items.push(line);
    tokens += estimate;
  }

  return { items, tokenEstimate: tokens };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function summarizeNodes(nodes: GraphNode[]): string[] {
  return nodes.map((node) => `${node.type}(${node.id})`);
}
