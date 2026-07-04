import { createEmbeddingProviderFromConfig } from "../../../config/embedding-factory";
import type { GraphFlowConfig } from "../../../config/schema";

export function buildEmbeddingOptions(config: GraphFlowConfig) {
  const embeddingProvider = createEmbeddingProviderFromConfig(config);
  if (!embeddingProvider) {
    return {};
  }
  return {
    embeddingProvider,
    enableVectorRecall: true as const,
    ...(config.embeddingPolicy?.topK !== undefined ? { vectorTopK: config.embeddingPolicy.topK } : {}),
    ...(config.embeddingPolicy?.minSimilarity !== undefined
      ? { vectorMinSimilarity: config.embeddingPolicy.minSimilarity }
      : {}),
  };
}
