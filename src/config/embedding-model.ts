import type { EmbeddingDtype } from "./schema";

/**
 * Canonical local semantic embedding model. Keeping this in one module prevents
 * the historical split-brain between graphPolicy defaults and the runtime
 * transformers loader.
 */
export const CANONICAL_EMBEDDING_MODEL = "Xenova/bge-base-zh-v1.5";
/** bge-base hidden size. */
export const CANONICAL_EMBEDDING_DIM = 768;
/** onnx/model_quantized.onnx (~100MB) instead of onnx/model.onnx (~400MB). */
export const CANONICAL_EMBEDDING_DTYPE: EmbeddingDtype = "q8";
export const GRAPHFLOW_EMBEDDING_DTYPE_ENV = "GRAPHFLOW_EMBEDDING_DTYPE";

const EMBEDDING_DTYPES: readonly EmbeddingDtype[] = ["fp32", "fp16", "q8", "q4"];

export function isEmbeddingDtype(value: unknown): value is EmbeddingDtype {
  return typeof value === "string" && (EMBEDDING_DTYPES as readonly string[]).includes(value);
}

/** Env override > config > canonical default. Unknown values fall back to the default. */
export function resolveEmbeddingDtype(configured?: string): EmbeddingDtype {
  const fromEnv = process.env[GRAPHFLOW_EMBEDDING_DTYPE_ENV]?.trim().toLowerCase();
  if (isEmbeddingDtype(fromEnv)) return fromEnv;
  if (isEmbeddingDtype(configured)) return configured;
  return CANONICAL_EMBEDDING_DTYPE;
}

/** Stored next to every vector so a model / precision switch is detectable. */
export function embeddingFingerprint(model: string, dtype?: string): string {
  return dtype ? `${model}@${dtype}` : model;
}
