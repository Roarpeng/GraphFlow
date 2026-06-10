import { resolveConfigSecret } from "./secrets";
import type { GraphFlowConfig } from "./schema";
import { DEFAULT_EMBEDDING_MODEL } from "./defaults";
import type { EmbeddingProvider } from "../learning/embeddings";
import {
  createHashEmbeddingProvider,
  createOpenAiEmbeddingProvider,
} from "../learning/embeddings";
import { createLocalEmbeddingProvider } from "../learning/local-embedding";

export function createEmbeddingProviderFromConfig(
  config: GraphFlowConfig
): EmbeddingProvider | undefined {
  const policy = config.embeddingPolicy;
  if (policy?.enabled === false) {
    return undefined;
  }

  const provider = policy?.provider ?? "local";

  if (provider === "hash") {
    return createHashEmbeddingProvider();
  }

  if (provider === "openai") {
    const apiKey =
      resolveConfigSecret(policy?.apiKey) ??
      resolveConfigSecret(config.providers.openai?.apiKey) ??
      process.env.OPENAI_API_KEY ??
      "";
    if (!apiKey) {
      return createHashEmbeddingProvider();
    }
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
    return createOpenAiEmbeddingProvider(openAiOptions);
  }

  return createLocalEmbeddingProvider(policy?.model ?? DEFAULT_EMBEDDING_MODEL);
}
