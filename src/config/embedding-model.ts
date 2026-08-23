/**
 * Canonical local semantic embedding model. Keeping this in one module prevents
 * the historical split-brain between graphPolicy defaults and the runtime
 * transformers loader.
 */
export const CANONICAL_EMBEDDING_MODEL = "Xenova/bge-base-zh-v1.5";
