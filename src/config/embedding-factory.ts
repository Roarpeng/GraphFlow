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

export function createEmbeddingProviderFromConfig(
  config: GraphFlowConfig
): EmbeddingProvider | undefined {
  const policy = config.embeddingPolicy;
  if (policy?.enabled === false) {
    return undefined;
  }

  const provider = policy?.provider ?? "transformers";
  const modelCacheDir = resolveConfiguredModelCacheDir(config);

  let embeddingProvider: EmbeddingProvider | undefined;
  let model = "Xenova/all-MiniLM-L6-v2";
  let dimensions = EMBEDDING_DIM;
  let resolvedProviderName = "transformers";

  if (provider === "hash") {
    model = HASH_EMBEDDING_MODEL;
    resolvedProviderName = "hash";
    embeddingProvider = createHashEmbeddingProvider();
  } else if (provider === "transformers") {
    resolvedProviderName = "transformers";
    embeddingProvider = createResilientLocalEmbeddingProvider({
      resolveRoots: collectResolveRoots(config),
      ...(modelCacheDir ? { modelCacheDir } : {}),
      onFallback: () => {
        configureEmbeddingQualityMeta({
          provider: "hash",
          model: HASH_EMBEDDING_MODEL,
          dimensions: EMBEDDING_DIM,
        });
      },
    });
  } else if (provider === "openai") {
    const apiKey =
      resolveConfigSecret(policy?.apiKey) ??
      resolveConfigSecret(config.providers.openai?.apiKey) ??
      process.env.OPENAI_API_KEY ??
      "";
    if (!apiKey) {
      resolvedProviderName = "transformers";
      embeddingProvider = createResilientLocalEmbeddingProvider({
        resolveRoots: collectResolveRoots(config),
        ...(modelCacheDir ? { modelCacheDir } : {}),
        onFallback: () => {
          configureEmbeddingQualityMeta({
            provider: "hash",
            model: HASH_EMBEDDING_MODEL,
            dimensions: EMBEDDING_DIM,
          });
        },
      });
    } else {
      model = policy?.model ?? "text-embedding-3-small";
      dimensions = 1536;
      resolvedProviderName = "openai";
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
  } else {
    // Unknown provider fallback to resilient local
    resolvedProviderName = "transformers";
    embeddingProvider = createResilientLocalEmbeddingProvider({
      resolveRoots: collectResolveRoots(config),
      ...(modelCacheDir ? { modelCacheDir } : {}),
      onFallback: () => {
        configureEmbeddingQualityMeta({
          provider: "hash",
          model: HASH_EMBEDDING_MODEL,
          dimensions: EMBEDDING_DIM,
        });
      },
    });
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
    // 创建后异步预热：避免首个真实请求的冷启动延迟。
    // 非阻塞：用 void 触发，预热失败由 warmupEmbeddingProvider 内部静默处理。
    // Resilient local provider will settle to hash on MODULE_NOT_FOUND without throwing.
    void warmupEmbeddingProvider(embeddingProvider);
  }

  return embeddingProvider;
}
