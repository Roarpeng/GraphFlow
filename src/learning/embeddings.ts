import type { GraphNode } from "../core/types";

export const EMBEDDING_DIM = 384;

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  /**
   * 预热：用一段简短的 dummy 文本（如 "warmup"）做一次推理，
   * 避免首个真实请求的冷启动延迟（尤其是本地模型懒加载场景）。
   * 异步执行，不应阻塞主流程。可选实现。
   */
  warmup?(): Promise<void>;
}

/**
 * 安全地预热 embedding provider。不会抛出异常，适合用 `void warmupEmbeddingProvider(p)` 非阻塞调用。
 * 预热失败不影响主流程，首个真实请求会再次尝试加载/推理。
 */
export async function warmupEmbeddingProvider(provider: EmbeddingProvider): Promise<void> {
  if (typeof provider.warmup !== "function") {
    return;
  }
  try {
    await provider.warmup();
  } catch {
    // 预热失败静默处理：不阻断 provider 创建与后续真实请求
  }
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

export function createTransformersEmbeddingProvider(): EmbeddingProvider {
  let extractor: ((texts: string | string[], options: { pooling: "mean"; normalize: boolean }) => Promise<unknown>) | null = null;

  async function getExtractor() {
    if (extractor) return extractor;
    const { pipeline } = await import("@xenova/transformers");
    extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    return extractor;
  }

  return {
    async embed(text: string): Promise<number[]> {
      const ext = await getExtractor();
      const output = await ext!(text, { pooling: "mean", normalize: true });
      const data = (output as { data: Float32Array | number[] }).data;
      if (data instanceof Float32Array) {
        return Array.from(data);
      }
      return Array.from(data as number[]);
    },
    async warmup(): Promise<void> {
      await this.embed("warmup");
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
    // 远程 API 无本地冷启动，预热为空操作以避免初始化时产生不必要的网络请求与计费
    async warmup(): Promise<void> {
      /* no-op: 远程 provider 无需本地预热 */
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
