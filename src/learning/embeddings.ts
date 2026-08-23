import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GraphNode } from "../core/types";
import { CANONICAL_EMBEDDING_MODEL } from "../config/embedding-model";
import { logger } from "../utils/logger";

export const EMBEDDING_DIM = 384;
export const HASH_EMBEDDING_MODEL = "fnv1a-384";
export const GRAPHFLOW_EMBEDDING_CACHE_DIR_ENV = "GRAPHFLOW_EMBEDDING_CACHE_DIR";
export const GRAPHFLOW_EMBEDDING_TIMEOUT_MS_ENV = "GRAPHFLOW_EMBEDDING_TIMEOUT_MS";
export const HF_ENDPOINT_ENV = "HF_ENDPOINT";
export const GRAPHFLOW_HF_ENDPOINT_ENV = "GRAPHFLOW_HF_ENDPOINT";

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
  /** Null unless the provider fell back to hash. */
  getFallbackReason(): string | null;
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
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
    message.includes("Cannot find module '@xenova/transformers'") ||
    message.includes("Cannot find package '@huggingface/transformers'") ||
    message.includes("Cannot find module '@huggingface/transformers'")
  );
}

type TransformersModule = {
  env?: {
    cacheDir?: string;
    remoteHost?: string;
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
    // Try @huggingface/transformers (v3) first, fall back to legacy @xenova/transformers
    for (const pkg of ["@huggingface/transformers", "@xenova/transformers"]) {
      try {
        const resolved = requireFromRoot.resolve(pkg);
        return (await import(pathToFileURL(resolved).href)) as TransformersModule;
      } catch {
        // try next
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Load transformers, preferring `@huggingface/transformers` (v3, in dependencies)
 * with legacy fallback to `@xenova/transformers`. Both read `HF_ENDPOINT` from
 * `process.env` natively to configure the Hugging Face model hub endpoint / mirror.
 */
export async function loadTransformersModule(resolveRoots: string[] = []): Promise<TransformersModule> {
  // @huggingface/transformers v3 is a direct dependency and should always resolve.
  // Keep @xenova/transformers as legacy fallback for workspace node_modules.
  let lastError: unknown = null;
  for (const pkg of ["@huggingface/transformers", "@xenova/transformers"]) {
    try {
      return (await import(pkg)) as TransformersModule;
    } catch (error) {
      lastError = error;
    }
  }
  const roots = [...new Set(resolveRoots.filter((r) => typeof r === "string" && r.length > 0))];
  for (const root of roots) {
    const loaded = await importTransformersFromRoot(root);
    if (loaded) {
      logger.info({ root }, "Loaded transformers from workspace resolve root");
      return loaded;
    }
  }
  throw lastError;
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
      const mirror = process.env[HF_ENDPOINT_ENV] || process.env[GRAPHFLOW_HF_ENDPOINT_ENV];
      if (mirror && transformers.env) {
        transformers.env.remoteHost = mirror;
      }
      const { pipeline } = transformers;
      const timeoutMs = parseInt(process.env[GRAPHFLOW_EMBEDDING_TIMEOUT_MS_ENV] ?? "", 10) || 60000;
      extractor = await withTimeout(
        pipeline("feature-extraction", CANONICAL_EMBEDDING_MODEL),
        timeoutMs,
        `pipeline('feature-extraction', '${CANONICAL_EMBEDDING_MODEL}')`
      );
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
  let fallbackReason: string | null = null;

  return {
    getBackend() {
      return backend;
    },
    getFallbackReason() {
      return fallbackReason;
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
        fallbackReason = isModuleNotFoundError(error) ? "module-not-found" : "load-or-inference-failed";
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

/**
 * 量化 embedding 的存储格式版本号。
 * int8-v1：单向量对称量化，original[i] ≈ data[i] * scale，data 为 [-127, 127] 整数。
 * 选型依据（见 benchmarks/run-embedding-storage-benchmark.ts）：int8 与 float16 的
 * top-k 召回排序重合度相当（≈95%+），但 int8 的 JSON 体积更小（约 -33% vs float32）。
 */
export const QUANTIZED_EMBEDDING_FORMAT = "int8-v1";
/** 量化 embedding 的 metadata 键；遗留 float32 键为 `embedding`（只读兼容，不再写入）。 */
export const QUANTIZED_EMBEDDING_METADATA_KEY = "embeddingQ";

export interface QuantizedEmbedding {
  format: typeof QUANTIZED_EMBEDDING_FORMAT;
  /** 反量化系数：original[i] ≈ data[i] * scale */
  scale: number;
  data: number[];
}

export function quantizeEmbedding(embedding: number[]): QuantizedEmbedding {
  let maxAbs = 0;
  for (const v of embedding) {
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 0 ? maxAbs / 127 : 0;
  const data = new Array<number>(embedding.length);
  for (let i = 0; i < embedding.length; i += 1) {
    const v = embedding[i] ?? 0;
    data[i] = scale === 0 ? 0 : Math.max(-127, Math.min(127, Math.round(v / scale)));
  }
  return { format: QUANTIZED_EMBEDDING_FORMAT, scale, data };
}

export function dequantizeEmbedding(quantized: QuantizedEmbedding): number[] {
  return quantized.data.map((v) => v * quantized.scale);
}

function isQuantizedEmbedding(raw: unknown): raw is QuantizedEmbedding {
  if (!raw || typeof raw !== "object") return false;
  const q = raw as QuantizedEmbedding;
  if (q.format !== QUANTIZED_EMBEDDING_FORMAT) return false;
  if (typeof q.scale !== "number" || !Number.isFinite(q.scale) || q.scale < 0) return false;
  if (!Array.isArray(q.data) || q.data.length === 0) return false;
  for (const v of q.data) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return true;
}

/**
 * 读取节点 embedding。优先读取量化格式 `metadata.embeddingQ`（新写入路径）并反量化；
 * 否则回退读取遗留的 float32 `metadata.embedding`。下游消费者（cosineSimilarity、RRF 等）
 * 拿到的始终是 float 向量，无需感知存储格式。
 */
export function extractEmbedding(node: GraphNode): number[] | null {
  const quantized = node.metadata?.[QUANTIZED_EMBEDDING_METADATA_KEY];
  if (isQuantizedEmbedding(quantized)) {
    return dequantizeEmbedding(quantized);
  }
  const raw = node.metadata?.embedding;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
  }
  return raw as number[];
}

export function attachEmbedding(node: GraphNode, embedding: number[]): GraphNode {
  const metadata = { ...(node.metadata ?? {}) };
  // 新写入统一使用量化键，并移除遗留 float32 键以避免双份存储
  delete metadata.embedding;
  metadata[QUANTIZED_EMBEDDING_METADATA_KEY] = quantizeEmbedding(embedding);
  return { ...node, metadata };
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
