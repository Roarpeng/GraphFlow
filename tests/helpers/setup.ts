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
import { isMainThread } from "node:worker_threads";

// Installer tests sandbox HOME/USERPROFILE/APPDATA through process.env. In a
// worker thread that copy never reaches os.homedir(), so they write the real
// user's host configs (observed: ~/.claude.json pointing at a deleted temp build).
if (!isMainThread) {
  throw new Error("GraphFlow tests must run in the forks pool; --pool=threads writes to the real home directory.");
}

process.env.GRAPHFLOW_EMBEDDING_TIMEOUT_MS ??= "2000";
process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS ??= "2000";
// The Windows registry env fallback would leak the developer's real
// credentials into assertions about "no key configured".
process.env.GRAPHFLOW_NO_REGISTRY_ENV ??= "1";
// Real credentials inherited from the developer shell turn "no LLM" scenarios
// into live ones (e.g. TYPESAFE_API_KEY sends gray-zone reuse advisories to
// api.typesafe.ai from every runTaskResult). Tests that need a key set a fake
// one explicitly.
for (const name of [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "BAILIAN_API_KEY",
  "BAILIAN_BASE_URL",
  "DOUBAO_API_KEY",
  "DOUBAO_BASE_URL",
  "TYPESAFE_API_KEY",
  "TYPESAFE_BASE_URL",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "API_KEY",
]) {
  delete process.env[name];
}
