import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GraphNode } from "../core/types";
import { logger } from "../utils/logger";

export const EMBEDDING_DIM = 384;
export const HASH_EMBEDDING_MODEL = "fnv1a-384";
export const GRAPHFLOW_EMBEDDING_CACHE_DIR_ENV = "GRAPHFLOW_EMBEDDING_CACHE_DIR";

export type LocalEmbeddingBackend = "transformers" | "hash";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  /**
   * 预热：用一段简短的 dummy 文本（如 "warmup"）做一次推理，
   * 避免首个真实请求的冷启动延迟（尤其是本地模型懒加载场景）。
   * 异步执行，不应阻塞主流程。可选实现。
   */
  warmup?(): Promise<void>;
}

export interface ResilientLocalEmbeddingProvider extends EmbeddingProvider {
  /** Resolved after first successful embed attempt (transformers or hash fallback). */
  getBackend(): LocalEmbeddingBackend | "pending";
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

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function l2Normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) {
    norm += v * v;
  }
  if (norm === 0) {
    return vec;
  }
  const inv = 1 / Math.sqrt(norm);
  return vec.map((v) => v * inv);
}

/**
 * Zero-cost deterministic embedding (FNV-1a bag-of-tokens).
 * Used when `@xenova/transformers` is unavailable (e.g. VS Code extension vendor bundle).
 */
export function createHashEmbeddingProvider(dimensions: number = EMBEDDING_DIM): EmbeddingProvider {
  const dim = dimensions > 0 ? dimensions : EMBEDDING_DIM;
  return {
    async embed(text: string): Promise<number[]> {
      const vec = new Array<number>(dim).fill(0);
      const normalized = text.toLowerCase();
      const tokens = normalized.split(/[^a-z0-9_\u4e00-\u9fff]+/).filter(Boolean);
      const parts = tokens.length > 0 ? tokens : [normalized || "empty"];
      for (const token of parts) {
        const h1 = fnv1a32(token);
        const h2 = fnv1a32(`${token}::2`);
        vec[h1 % dim] = (vec[h1 % dim] ?? 0) + 1;
        vec[h2 % dim] = (vec[h2 % dim] ?? 0) + 0.5;
      }
      return l2Normalize(vec);
    },
    async warmup(): Promise<void> {
      /* no-op: pure CPU hash */
    },
  };
}

function isModuleNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { code?: string; message?: string };
  if (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND") {
    return true;
  }
  const message = err.message ?? "";
  return (
    message.includes("Cannot find package '@xenova/transformers'") ||
    message.includes("Cannot find module '@xenova/transformers'")
  );
}

type TransformersModule = {
  env?: {
    cacheDir?: string;
  };
  pipeline: (
    task: "feature-extraction",
    model: string
  ) => Promise<(texts: string | string[], options: { pooling: "mean"; normalize: boolean }) => Promise<unknown>>;
};

function normalizeOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveTransformersCacheDir(modelCacheDir?: string): string | undefined {
  return normalizeOptionalPath(modelCacheDir) ?? normalizeOptionalPath(process.env[GRAPHFLOW_EMBEDDING_CACHE_DIR_ENV]);
}

export function applyTransformersCacheDir(transformers: TransformersModule, modelCacheDir?: string): string | undefined {
  const cacheDir = resolveTransformersCacheDir(modelCacheDir);
  if (!cacheDir) {
    return undefined;
  }
  transformers.env ??= {};
  transformers.env.cacheDir = cacheDir;
  return cacheDir;
}

async function importTransformersFromRoot(root: string): Promise<TransformersModule | null> {
  const pkgJson = join(root, "package.json");
  if (!existsSync(pkgJson)) {
    return null;
  }
  try {
    const requireFromRoot = createRequire(pkgJson);
    const resolved = requireFromRoot.resolve("@xenova/transformers");
    return (await import(pathToFileURL(resolved).href)) as TransformersModule;
  } catch {
    return null;
  }
}

/**
 * Load `@xenova/transformers`, optionally resolving from workspace node_modules
 * when the bundled runtime (extension vendor) does not include the package.
 */
export async function loadTransformersModule(resolveRoots: string[] = []): Promise<TransformersModule> {
  try {
    return (await import("@xenova/transformers")) as TransformersModule;
  } catch (primaryError) {
    const roots = [...new Set(resolveRoots.filter((r) => typeof r === "string" && r.length > 0))];
    for (const root of roots) {
      const loaded = await importTransformersFromRoot(root);
      if (loaded) {
        logger.info({ root }, "Loaded @xenova/transformers from workspace resolve root");
        return loaded;
      }
    }
    throw primaryError;
  }
}

export function createTransformersEmbeddingProvider(options?: {
  resolveRoots?: string[];
  modelCacheDir?: string;
  /** Test/injection hook — defaults to loadTransformersModule. */
  loadModule?: (resolveRoots: string[]) => Promise<TransformersModule>;
}): EmbeddingProvider {
  let extractor: ((texts: string | string[], options: { pooling: "mean"; normalize: boolean }) => Promise<unknown>) | null =
    null;
  let loadError: unknown = null;
  const resolveRoots = options?.resolveRoots ?? [];
  const loadModule = options?.loadModule ?? loadTransformersModule;

  async function getExtractor() {
    if (extractor) return extractor;
    if (loadError) throw loadError;
    try {
      const transformers = await loadModule(resolveRoots);
      applyTransformersCacheDir(transformers, options?.modelCacheDir);
      const { pipeline } = transformers;
      extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
      return extractor;
    } catch (error) {
      loadError = error;
      throw error;
    }
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

/**
 * Prefer transformers; on missing package / first load failure, permanently fall back to hash.
 * Prevents ERR_MODULE_NOT_FOUND spam from vector recall in extension vendor runtimes.
 */
export function createResilientLocalEmbeddingProvider(options?: {
  resolveRoots?: string[];
  modelCacheDir?: string;
  onFallback?: (error: unknown) => void;
  loadModule?: (resolveRoots: string[]) => Promise<TransformersModule>;
}): ResilientLocalEmbeddingProvider {
  const primary = createTransformersEmbeddingProvider({
    resolveRoots: options?.resolveRoots ?? [],
    ...(options?.modelCacheDir ? { modelCacheDir: options.modelCacheDir } : {}),
    ...(options?.loadModule ? { loadModule: options.loadModule } : {}),
  });
  const fallback = createHashEmbeddingProvider();
  let backend: LocalEmbeddingBackend | "pending" = "pending";

  return {
    getBackend() {
      return backend;
    },
    async embed(text: string): Promise<number[]> {
      if (backend === "hash") {
        return fallback.embed(text);
      }
      if (backend === "transformers") {
        return primary.embed(text);
      }
      try {
        const vector = await primary.embed(text);
        backend = "transformers";
        return vector;
      } catch (error) {
        backend = "hash";
        logger.warn(
          {
            error,
            fallback: HASH_EMBEDDING_MODEL,
            reason: isModuleNotFoundError(error) ? "module-not-found" : "load-or-inference-failed",
          },
          "Transformers embedding unavailable; falling back to hash embedding"
        );
        options?.onFallback?.(error);
        return fallback.embed(text);
      }
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
