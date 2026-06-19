import { existsSync } from "node:fs";
import { logger } from "../utils/logger";
import { resolveModelForRole, resolveCompressorSelection } from "../routing/model-router";
import { executeRolePrompt } from "../routing/provider-executor";
import type { GraphFlowConfig } from "../config/schema";

/**
 * Unified compression-model adapter.
 *
 * Product strategy (hybrid, zero extra config):
 *   1. backend="inherit" (default) → reuse config.tiers.economy
 *      - external API configured (openai/anthropic/bailian) → use it
 *      - provider=openbmb → use embedded minicpm-1b
 *   2. backend="network" → external API (optionally stronger model)
 *   3. backend="local" → force embedded minicpm-1b
 *
 * The compressor role resolution lives in model-router.ts; this module wraps
 * it with embedded-model auto-download and a single generate() entrypoint.
 */

export interface CompressionModelHandle {
  provider: string;
  model: string;
  isEmbedded: boolean;
  /** False when no usable model is reachable (no API key, no embedded file). */
  available: boolean;
  generate(prompt: string, maxTokens?: number): Promise<string>;
}

/**
 * Detects provider fallback placeholders like "[openai:gpt-4.1-mini] <prompt>".
 * These are returned by adapters when no real model is reachable; they must
 * never be written into the compressed context.
 */
export function isPlaceholderResponse(text: string): boolean {
  return /^\[(openai|anthropic|bailian|doubao|openbmb):[^\]]+\]/i.test(text.trim());
}

/**
 * Resolves the compression model based on config, auto-downloading the embedded
 * model if needed. Returns a handle with a unified generate() method.
 */
export async function resolveCompressionModel(
  config: GraphFlowConfig,
  configPath?: string
): Promise<CompressionModelHandle> {
  const selection = resolveModelForRole("compressor", configPath);
  const isEmbedded = selection.provider === "openbmb";
  const timeoutMs = config.graphPolicy.compression?.timeoutMs;

  // Probe availability: external providers need an API key, embedded needs a model file.
  let available = true;
  if (isEmbedded) {
    const autoDownload = config.graphPolicy.compression?.autoDownloadEmbedded !== false;
    if (autoDownload) {
      try {
        await ensureEmbeddedCompressionModel(config, configPath);
      } catch (error) {
        logger.warn({ error }, "Embedded model auto-download failed; compression will degrade to graph-only");
      }
    }
    const modelPath = process.env.GRAPHFLOW_OPENBMB_MODEL_PATH;
    available = Boolean(modelPath && existsSync(modelPath));
  } else {
    const providerConfig = config.providers[selection.provider as keyof typeof config.providers];
    const apiKey = providerConfig?.apiKey;
    // Unresolved "${ENV}" placeholders or missing keys mean no reachable model.
    available = Boolean(apiKey && !/^\$\{.*\}$/.test(apiKey.trim()) && apiKey.trim().length > 0);
  }

  if (!available) {
    logger.info(
      { provider: selection.provider, model: selection.model },
      "No usable compression model; semantic compression will be skipped (graph-structure compression still active)"
    );
  }

  return {
    provider: selection.provider,
    model: selection.model,
    isEmbedded,
    available,
    async generate(prompt: string, maxTokens?: number): Promise<string> {
      const previousMax = process.env.GRAPHFLOW_OPENBMB_MAX_TOKENS;
      const previousTimeout = process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;
      if (maxTokens !== undefined) {
        process.env.GRAPHFLOW_OPENBMB_MAX_TOKENS = String(maxTokens);
      }
      if (timeoutMs !== undefined) {
        process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = String(timeoutMs);
      }
      try {
        const result = await executeRolePrompt("compressor", prompt, selection);
        // Guard: never let a provider placeholder leak into compressed context.
        if (isPlaceholderResponse(result)) {
          throw new Error(`Compression model unavailable (${selection.provider}/${selection.model})`);
        }
        return result;
      } finally {
        restoreEnv("GRAPHFLOW_OPENBMB_MAX_TOKENS", previousMax);
        restoreEnv("GRAPHFLOW_PROVIDER_TIMEOUT_MS", previousTimeout);
      }
    },
  };
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = previous;
  }
}

/** Default embedded model: MiniCPM-1B Q4_K_M GGUF (~650MB). */
export const DEFAULT_EMBEDDED_MODEL = "minicpm-1b";
export const DEFAULT_EMBEDDED_MODEL_URL =
  "https://huggingface.co/openbmb/MiniCPM-2B-sft-bf16-llama-format-gguf/resolve/main/ggml-model-Q4_K_M.gguf";

/**
 * Ensures the embedded compression model is downloaded. Reuses the existing
 * robust downloader (resumable, sha256-verified, file-locked) from the CLI
 * runtime. Returns the resolved model path.
 */
export async function ensureEmbeddedCompressionModel(
  config: GraphFlowConfig,
  configPath?: string
): Promise<string> {
  const { downloadOpenBmbModel } = await import("../surfaces/cli/runtime/graph.js");
  const customPath = config.graphPolicy.compression?.embeddedModelPath;

  // Provide a default URL if user hasn't configured one via env.
  if (!process.env.GRAPHFLOW_MINICPM_MODEL_URL) {
    process.env.GRAPHFLOW_MINICPM_MODEL_URL = DEFAULT_EMBEDDED_MODEL_URL;
  }

  const result = await downloadOpenBmbModel(configPath, {
    model: DEFAULT_EMBEDDED_MODEL,
    ...(customPath ? { targetPath: customPath } : {}),
  });

  // Point the embedded runtime at the downloaded model.
  process.env.GRAPHFLOW_OPENBMB_MODEL_PATH = result.targetPath;
  return result.targetPath;
}

/**
 * Reports which compression backend is active, for diagnostics/UI.
 */
export function describeCompressionBackend(
  config: GraphFlowConfig,
  _configPath?: string
): { backend: string; provider: string; model: string; embedded: boolean } {
  const backend = config.graphPolicy.compression?.backend ?? "inherit";
  const selection = resolveCompressorSelection(config);
  return {
    backend,
    provider: selection.provider,
    model: selection.model,
    embedded: selection.provider === "openbmb",
  };
}
