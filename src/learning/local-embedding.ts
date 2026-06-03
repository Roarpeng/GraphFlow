import type { EmbeddingProvider } from "./embeddings.js";

export function createLocalEmbeddingProvider(
  modelName: string = "Xenova/bge-base-zh-v1.5"
): EmbeddingProvider {
  let pipelinePromise: Promise<any> | null = null;

  return {
    async embed(text: string): Promise<number[]> {
      if (!pipelinePromise) {
        pipelinePromise = (async () => {
          // import dynamically to avoid blocking
          const { pipeline } = await import("@xenova/transformers");
          return await pipeline("feature-extraction", modelName);
        })();
      }

      const extractor = await pipelinePromise;
      const output = await extractor(text, { pooling: "mean", normalize: true });
      return Array.from(output.data);
    },
  };
}
