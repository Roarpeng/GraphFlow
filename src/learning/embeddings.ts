import type { GraphNode } from "../core/types";

export const EMBEDDING_DIM = 256;

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

export function hashEmbedding(text: string, dim: number = EMBEDDING_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  if (!text) return vec;
  const tokens = text.toLowerCase().split(/[^a-z0-9_]+/g).filter((t) => t.length > 0);
  for (const tok of tokens) {
    const idx = fnv1a(tok) % dim;
    vec[idx] = (vec[idx] ?? 0) + 1;
  }
  let norm = 0;
  for (let i = 0; i < dim; i += 1) norm += (vec[i] ?? 0) * (vec[i] ?? 0);
  if (norm === 0) return vec;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < dim; i += 1) vec[i] = (vec[i] ?? 0) * inv;
  return vec;
}

export function createHashEmbeddingProvider(dim: number = EMBEDDING_DIM): EmbeddingProvider {
  return {
    async embed(text: string): Promise<number[]> {
      return hashEmbedding(text, dim);
    },
  };
}

export function createOpenAiEmbeddingProvider(options: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}): EmbeddingProvider {
  const base = options.baseUrl ?? "https://api.openai.com/v1";
  const model = options.model ?? "text-embedding-3-small";
  return {
    async embed(text: string): Promise<number[]> {
      const res = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ input: text, model }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI embeddings failed: HTTP ${res.status}`);
      }
      const json = (await res.json()) as { data?: { embedding?: number[] }[] };
      const emb = json?.data?.[0]?.embedding;
      if (!Array.isArray(emb) || emb.length === 0) {
        throw new Error("OpenAI embeddings response missing data[0].embedding");
      }
      return emb;
    },
  };
}

export function extractEmbedding(node: GraphNode): number[] | null {
  const raw = node.metadata?.embedding;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
  }
  return raw as number[];
}

export function attachEmbedding(node: GraphNode, embedding: number[]): GraphNode {
  return {
    ...node,
    metadata: { ...(node.metadata ?? {}), embedding },
  };
}

export async function embedAndAttachNodes(
  nodes: GraphNode[],
  provider: EmbeddingProvider
): Promise<GraphNode[]> {
  const out: GraphNode[] = [];
  for (const node of nodes) {
    if (!node.content) {
      out.push(node);
      continue;
    }
    const emb = await provider.embed(node.content);
    out.push(attachEmbedding(node, emb));
  }
  return out;
}

export function reciprocalRankFusion(rankings: GraphNode[][], k: number = 60): GraphNode[] {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, { node: GraphNode; order: number }>();
  let order = 0;
  for (const list of rankings) {
    for (let rank = 0; rank < list.length; rank += 1) {
      const node = list[rank];
      if (!node) continue;
      scores.set(node.id, (scores.get(node.id) ?? 0) + 1 / (k + rank + 1));
      if (!firstSeen.has(node.id)) {
        firstSeen.set(node.id, { node, order: order++ });
      }
    }
  }
  const entries = Array.from(firstSeen.values()).map(({ node, order: o }) => ({
    node,
    score: scores.get(node.id) ?? 0,
    order: o,
  }));
  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.order - b.order;
  });
  return entries.map((e) => e.node);
}
