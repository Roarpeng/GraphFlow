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
    ...(config.embeddingPolicy?.enableFullGraphVectorRecall === true
      ? { enableFullGraphVectorRecall: true as const }
      : {}),
    ...(config.embeddingPolicy?.topK !== undefined ? { vectorTopK: config.embeddingPolicy.topK } : {}),
    ...(config.embeddingPolicy?.minSimilarity !== undefined
      ? { vectorMinSimilarity: config.embeddingPolicy.minSimilarity }
      : {}),
    // Persist vector recall index to disk for faster startup on large repos.
    ...(config.embeddingPolicy?.vectorStorePath
      ? { hnswIndexPath: config.embeddingPolicy.vectorStorePath.replace(/\.\w+$/, ".hnsw") }
      : {}),
  };
}
