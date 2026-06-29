import type { EmbeddingProvider } from "./embeddings.js";

export function createLocalEmbeddingProvider(
  modelName: string = "Xenova/bge-base-zh-v1.5"
): EmbeddingProvider {
  let pipelinePromise: Promise<
    (text: string, options: { pooling: "mean"; normalize: boolean }) => Promise<{ data: ArrayLike<number> }>
  > | null = null;

  // 预热标记：确保本地模型的懒加载管线只触发一次
  let warmupStarted = false;

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
    // 预热：用 dummy 文本 "warmup" 触发一次推理，提前完成模型权重加载与管线初始化，
    // 避免首个真实请求承担冷启动延迟。幂等：仅触发一次实际加载。
    async warmup(): Promise<void> {
      if (warmupStarted) {
        // 等待已在进行的加载完成即可
        if (pipelinePromise) {
          await pipelinePromise.catch(() => undefined);
        }
        return;
      }
      warmupStarted = true;
      // embed 内部会初始化 pipelinePromise 并执行一次推理
      await this.embed("warmup").catch(() => undefined);
    },
  };
}
