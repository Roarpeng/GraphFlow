import { resolveConfigSecret } from "./secrets";
import type { GraphFlowConfig } from "./schema";
import type { EmbeddingProvider } from "../learning/embeddings";
import {
  createTransformersEmbeddingProvider,
  createOpenAiEmbeddingProvider,
  warmupEmbeddingProvider,
} from "../learning/embeddings";

export function createEmbeddingProviderFromConfig(
  config: GraphFlowConfig
): EmbeddingProvider | undefined {
  const policy = config.embeddingPolicy;
  if (policy?.enabled === false) {
    return undefined;
  }

  const provider = policy?.provider ?? "transformers";

  let embeddingProvider: EmbeddingProvider | undefined;

  if (provider === "transformers") {
    embeddingProvider = createTransformersEmbeddingProvider();
  } else if (provider === "openai") {
    const apiKey =
      resolveConfigSecret(policy?.apiKey) ??
      resolveConfigSecret(config.providers.openai?.apiKey) ??
      process.env.OPENAI_API_KEY ??
      "";
    if (!apiKey) {
      embeddingProvider = createTransformersEmbeddingProvider();
    } else {
      const openAiOptions: {
        apiKey: string;
        model?: string;
        baseUrl?: string;
      } = {
        apiKey,
        model: policy?.model ?? "text-embedding-3-small",
      };
      const baseUrl = policy?.baseUrl ?? config.providers.openai?.baseUrl;
      if (baseUrl) {
        openAiOptions.baseUrl = baseUrl;
      }
      embeddingProvider = createOpenAiEmbeddingProvider(openAiOptions);
    }
  } else {
    // Unknown provider fallback to transformers
    embeddingProvider = createTransformersEmbeddingProvider();
  }

  // 创建后异步预热：避免首个真实请求的冷启动延迟。
  // 非阻塞：用 void 触发，预热失败由 warmupEmbeddingProvider 内部静默处理。
  if (embeddingProvider) {
    void warmupEmbeddingProvider(embeddingProvider);
  }

  return embeddingProvider;
}
