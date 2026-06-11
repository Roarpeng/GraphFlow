import type { EmbeddingProvider } from "./embeddings.js";

export function createLocalEmbeddingProvider(
  modelName: string = "Xenova/bge-base-zh-v1.5"
): EmbeddingProvider {
  let pipelinePromise: Promise<
    (text: string, options: { pooling: "mean"; normalize: boolean }) => Promise<{ data: ArrayLike<number> }>
  > | null = null;

  return {
    async embed(text: string): Promise<number[]> {
      if (!pipelinePromise) {
        pipelinePromise = (async () => {
          const { pipeline } = await import("@xenova/transformers");
          const extractor = await pipeline("feature-extraction", modelName);
          return extractor as (
            text: string,
            options: { pooling: "mean"; normalize: boolean }
          ) => Promise<{ data: ArrayLike<number> }>;
        })();
      }

      const extractor = await pipelinePromise;
      const output = await extractor(text, { pooling: "mean", normalize: true });
      return Array.from(output.data);
    },
  };
}
