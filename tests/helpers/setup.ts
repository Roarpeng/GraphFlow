/**
 * Global vitest setup: make environment-sensitive paths deterministic and fast.
 *
 * - Cap the embedding model load timeout at 2s (default 60s). Tests that
 *   accidentally hit the transformers provider fall back to hash embeddings
 *   almost immediately instead of stalling for a minute per call.
 * - Provider (LLM) network timeout capped at 2s as well, so a stray live call
 *   on a machine with API keys configured fails fast instead of hanging.
 *
 * Individual tests can still override these env vars explicitly.
 */
process.env.GRAPHFLOW_EMBEDDING_TIMEOUT_MS ??= "2000";
process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS ??= "2000";
