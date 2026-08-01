import { resolveConfigSecret } from "./secrets";
import type { GraphFlowConfig } from "./schema";
import type { EmbeddingProvider } from "../learning/embeddings";
import {
  createHashEmbeddingProvider,
  createOpenAiEmbeddingProvider,
  createResilientLocalEmbeddingProvider,
  warmupEmbeddingProvider,
  EMBEDDING_DIM,
  HASH_EMBEDDING_MODEL,
} from "../learning/embeddings";
import {
  configureEmbeddingQualityMeta,
  configureEmbeddingQualityBackend,
  getEmbeddingQualitySummary,
  wrapEmbeddingProviderWithQualityMonitor,
} from "../learning/embedding-quality";

function collectResolveRoots(config: GraphFlowConfig): string[] {
  const roots: string[] = [];
  const workspaceRoot = config.graphPolicy?.workspaceRoot;
  if (typeof workspaceRoot === "string" && workspaceRoot.length > 0) {
    roots.push(workspaceRoot);
  }
  if (typeof process.cwd === "function") {
    roots.push(process.cwd());
  }
  return [...new Set(roots)];
}

function resolveConfiguredModelCacheDir(config: GraphFlowConfig): string | undefined {
  return config.embeddingPolicy?.modelCacheDir ?? config.embeddingPolicy?.transformersCachePath;
}

/**
 * Effective embedding backend for vector recall (P0-1):
 *   - "fnv"          offline-safe default — deterministic FNV-1a hash embeddings
 *   - "transformers" optional semantic backend — lazily loads all-MiniLM-L6-v2
 *                    via @huggingface/transformers, transparently falling back
 *                    to FNV-1a on any load/cache/timeout failure
 *   - "openai"       legacy remote embeddings (requires an API key)
 *
 * Resolution precedence: legacy explicit OpenAI (key present) wins over the new
 * switch so existing openai users keep working; otherwise the new
 * graphPolicy.embeddingProvider decides; finally the legacy embeddingPolicy
 * provider (hash → fnv) applies; the fallback default is the resilient local
 * transformers path (unchanged legacy behavior for configs without defaults).
 */
export function resolveEffectiveEmbeddingBackend(
  config: GraphFlowConfig
): "fnv" | "transformers" | "openai" {
  const policy = config.embeddingPolicy;
  const graphEmbedding = config.graphPolicy?.embeddingProvider;
  const hasOpenAiKey = Boolean(
    resolveConfigSecret(policy?.apiKey) ??
      resolveConfigSecret(config.providers.openai?.apiKey) ??
      process.env.OPENAI_API_KEY
  );
  if (policy?.provider === "openai" && hasOpenAiKey) {
    return "openai";
  }
  if (graphEmbedding === "fnv" || graphEmbedding === "transformers") {
    return graphEmbedding;
  }
  if (policy?.provider === "openai") {
    // Requested but no API key → resilient local (existing behavior)
    return "transformers";
  }
  if (policy?.provider === "hash") {
    return "fnv";
  }
  // Legacy default & unknown provider → resilient local
  return "transformers";
}

/**
 * Active semantic backend for diagnose: "semantic" when a real embedding model
 * (MiniLM / OpenAI) is active, "off" when FNV-1a hash (or none). Prefers the
 * settled quality-monitor backend (so a transformers→hash fallback reports
 * "off"), falling back to configured intent before the first embed.
 */
export function resolveActiveEmbeddingBackend(config: GraphFlowConfig): "semantic" | "off" {
  const summary = getEmbeddingQualitySummary();
  if (summary.backend === "transformers" || summary.backend === "openai") {
    return "semantic";
  }
  if (summary.backend === "hash") {
    return "off";
  }
  // Not settled yet → configured intent
  return resolveEffectiveEmbeddingBackend(config) === "fnv" ? "off" : "semantic";
}

export function createEmbeddingProviderFromConfig(
  config: GraphFlowConfig
): EmbeddingProvider | undefined {
  const policy = config.embeddingPolicy;
  if (policy?.enabled === false) {
    return undefined;
  }

  const backend = resolveEffectiveEmbeddingBackend(config);
  const modelCacheDir = resolveConfiguredModelCacheDir(config);

  let embeddingProvider: EmbeddingProvider | undefined;
  let model = "Xenova/all-MiniLM-L6-v2";
  let dimensions = EMBEDDING_DIM;
  let resolvedProviderName = "transformers";

  const createResilientLocal = (): EmbeddingProvider => {
    resolvedProviderName = "transformers";
    configureEmbeddingQualityBackend("pending");
    return createResilientLocalEmbeddingProvider({
      resolveRoots: collectResolveRoots(config),
      ...(modelCacheDir ? { modelCacheDir } : {}),
      onFallback: () => {
        configureEmbeddingQualityMeta({
          provider: "hash",
          model: HASH_EMBEDDING_MODEL,
          dimensions: EMBEDDING_DIM,
        });
        configureEmbeddingQualityBackend("hash");
      },
    });
  };

  if (backend === "fnv") {
    model = HASH_EMBEDDING_MODEL;
    resolvedProviderName = "hash";
    embeddingProvider = createHashEmbeddingProvider();
    configureEmbeddingQualityBackend("hash");
  } else if (backend === "transformers") {
    embeddingProvider = createResilientLocal();
  } else {
    // openai — key guaranteed present by resolveEffectiveEmbeddingBackend
    const apiKey =
      resolveConfigSecret(policy?.apiKey) ??
      resolveConfigSecret(config.providers.openai?.apiKey) ??
      process.env.OPENAI_API_KEY ??
      "";
    model = policy?.model ?? "text-embedding-3-small";
    dimensions = 1536;
    resolvedProviderName = "openai";
    configureEmbeddingQualityBackend("openai");
    const openAiOptions: {
      apiKey: string;
      model?: string;
      baseUrl?: string;
    } = {
      apiKey,
      model,
    };
    const baseUrl = policy?.baseUrl ?? config.providers.openai?.baseUrl;
    if (baseUrl) {
      openAiOptions.baseUrl = baseUrl;
    }
    embeddingProvider = createOpenAiEmbeddingProvider(openAiOptions);
  }

  if (embeddingProvider) {
    configureEmbeddingQualityMeta({
      provider: resolvedProviderName,
      model,
      dimensions,
    });
    embeddingProvider = wrapEmbeddingProviderWithQualityMonitor(embeddingProvider, {
      provider: resolvedProviderName,
      model,
      dimensions,
    });
    // Skip warmup in vitest / explicit CI flag. Background MiniLM download from
    // HuggingFace has no hard timeout and can keep the test process alive for 30m+.
    const skipWarmup =
      process.env.GRAPHFLOW_SKIP_EMBEDDING_WARMUP === "1" ||
      process.env.VITEST === "true" ||
      process.env.VITEST === "1" ||
      typeof process.env.VITEST_WORKER_ID === "string";
    if (!skipWarmup) {
      // 创建后异步预热：避免首个真实请求的冷启动延迟。
      // 非阻塞：用 void 触发，预热失败由 warmupEmbeddingProvider 内部静默处理。
      // Resilient local provider will settle to hash on MODULE_NOT_FOUND without throwing.
      void warmupEmbeddingProvider(embeddingProvider);
    }
  }

  return embeddingProvider;
}
