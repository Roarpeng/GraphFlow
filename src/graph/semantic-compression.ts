import type { GraphNode } from "../core/types";
import { cosineSimilarity, extractEmbedding, type EmbeddingProvider } from "../learning/embeddings";
import { openbmbGenerateText, type OpenBmbRuntimeOptions } from "../routing/provider-adapters/openbmb";
import type { CompressionModelHandle } from "./compression-model";

/**
 * Semantic compression via minicpm-1b: cluster similar nodes and generate
 * unified summaries, or condense verbose content into dense descriptions.
 *
 * This is the "Layer 1" compression that leverages the local LLM after graph-
 * structure pruning has already reduced the candidate set.
 */

export interface ClusteringOptions {
  embeddingProvider?: EmbeddingProvider;
  similarityThreshold?: number;
  maxClusterSize?: number;
}

export interface NodeCluster {
  representative: GraphNode;
  members: GraphNode[];
  avgSimilarity: number;
}

/**
 * Clusters nodes by embedding similarity. Nodes within a cluster can be
 * merged into a single summary line to save tokens.
 */
export async function clusterSimilarNodes(
  nodes: GraphNode[],
  options?: ClusteringOptions
): Promise<NodeCluster[]> {
  const threshold = options?.similarityThreshold ?? 0.75;
  const maxSize = options?.maxClusterSize ?? 5;

  // Ensure all nodes have embeddings.
  const withEmbedding = nodes.filter((n) => extractEmbedding(n) !== null);
  if (withEmbedding.length === 0) return [];

  const clusters: NodeCluster[] = [];
  const assigned = new Set<string>();

  for (const candidate of withEmbedding) {
    if (assigned.has(candidate.id)) continue;

    const cluster: GraphNode[] = [candidate];
    assigned.add(candidate.id);
    const candidateEmb = extractEmbedding(candidate)!;
    let simSum = 0;

    for (const other of withEmbedding) {
      if (assigned.has(other.id)) continue;
      if (cluster.length >= maxSize) break;

      const otherEmb = extractEmbedding(other);
      if (!otherEmb) continue;

      const sim = cosineSimilarity(candidateEmb, otherEmb);
      if (sim >= threshold) {
        cluster.push(other);
        assigned.add(other.id);
        simSum += sim;
      }
    }

    // Only create cluster if we found similar nodes (cluster size > 1).
    if (cluster.length > 1) {
      clusters.push({
        representative: candidate,
        members: cluster,
        avgSimilarity: simSum / (cluster.length - 1),
      });
    }
  }

  return clusters;
}

export interface SummarizerOptions extends OpenBmbRuntimeOptions {
  maxSummaryTokens?: number;
  /** Preferred: unified compression model handle (auto-selects external/embedded). */
  modelHandle?: CompressionModelHandle;
}

/**
 * Generates a unified summary for a cluster of similar nodes.
 * Uses the provided compression model handle (external or embedded) if given,
 * otherwise falls back to direct embedded openbmb invocation.
 * Example: 3 overloaded `login()` variants → "login function with 3 signatures".
 */
export async function summarizeCluster(
  cluster: NodeCluster,
  options?: SummarizerOptions
): Promise<string> {
  const memberContents = cluster.members.map((m) => m.content).slice(0, 5);
  const prompt = [
    "你是代码摘要生成器。多个相似的代码片段需要合并为一句统一描述。",
    "要求：",
    "1. 用一句话概括它们的共同功能（20字以内）",
    "2. 如果是重载/变体，说明有几个版本",
    "3. 不要逐个列举，只给出统一摘要",
    "",
    "代码片段：",
    ...memberContents.map((c, i) => `${i + 1}. ${c}`),
    "",
    "统一摘要：",
  ].join("\n");

  const maxTokens = options?.maxSummaryTokens ?? 64;

  try {
    const result = options?.modelHandle
      ? await options.modelHandle.generate(prompt, maxTokens)
      : await openbmbGenerateText(
          { prompt, model: options?.modelPath ?? "minicpm-1b" },
          { ...options, maxTokens }
        );

    return result.trim().replace(/^统一摘要[:：]?\s*/i, "");
  } catch {
    // Degrade gracefully: if no model is available, keep the representative's original content.
    return cluster.representative.content;
  }
}

export interface DensifierOptions extends OpenBmbRuntimeOptions {
  maxOutputTokens?: number;
  minInputTokens?: number;
  /** Preferred: unified compression model handle (auto-selects external/embedded). */
  modelHandle?: CompressionModelHandle;
}

/**
 * Rewrites verbose node content into dense summaries.
 * Uses the provided compression model handle if given, otherwise falls back to
 * direct embedded openbmb invocation. Only applies to nodes exceeding minInputTokens.
 */
export async function densifyNodeContent(
  node: GraphNode,
  options?: DensifierOptions
): Promise<string> {
  const content = node.content;
  const minInput = options?.minInputTokens ?? 150;
  const estimatedTokens = Math.ceil(content.length / 4);

  if (estimatedTokens < minInput) {
    // Already concise.
    return content;
  }

  const prompt = [
    "你是代码压缩专家。将以下代码签名/内容改写为极简版（保留核心信息，去掉冗余）。",
    "要求：",
    "1. 保留函数名、参数、返回类型",
    "2. 去掉注释、装饰器、冗长描述",
    "3. 输出格式：function_name(params) -> return_type | 核心功能",
    "",
    `原内容：\n${content.slice(0, 600)}`,
    "",
    "压缩版：",
  ].join("\n");

  const maxTokens = options?.maxOutputTokens ?? 80;

  try {
    const result = options?.modelHandle
      ? await options.modelHandle.generate(prompt, maxTokens)
      : await openbmbGenerateText(
          { prompt, model: options?.modelPath ?? "minicpm-1b" },
          { ...options, maxTokens }
        );

    return result.trim().replace(/^压缩版[:：]?\s*/i, "");
  } catch {
    // Degrade gracefully: if no model is available, keep the original content.
    return content;
  }
}

/**
 * High-level pipeline: cluster similar nodes, summarize each cluster, and
 * densify remaining verbose nodes. Returns compressed node set.
 *
 * When a compression model handle is provided, summarization/densification
 * route through it (external economy tier or embedded minicpm); otherwise they
 * fall back to direct embedded openbmb invocation.
 */
export async function applySemanticCompression(
  nodes: GraphNode[],
  options?: {
    clusteringOptions?: ClusteringOptions;
    summarizerOptions?: SummarizerOptions;
    densifierOptions?: DensifierOptions;
    modelHandle?: CompressionModelHandle;
  }
): Promise<GraphNode[]> {
  const clusters = await clusterSimilarNodes(nodes, options?.clusteringOptions);
  const clusterIds = new Set(clusters.flatMap((c) => c.members.map((m) => m.id)));

  const summarizerOptions: SummarizerOptions = {
    ...options?.summarizerOptions,
    ...(options?.modelHandle ? { modelHandle: options.modelHandle } : {}),
  };
  const densifierOptions: DensifierOptions = {
    ...options?.densifierOptions,
    ...(options?.modelHandle ? { modelHandle: options.modelHandle } : {}),
  };

  const compressed: GraphNode[] = [];

  // Replace each cluster with a single summarized node.
  for (const cluster of clusters) {
    const summary = await summarizeCluster(cluster, summarizerOptions);
    compressed.push({
      ...cluster.representative,
      content: summary,
      metadata: {
        ...cluster.representative.metadata,
        compressed: true,
        clusterSize: cluster.members.length,
        originalIds: cluster.members.map((m) => m.id),
      },
    });
  }

  // Densify non-clustered nodes if verbose.
  for (const node of nodes) {
    if (clusterIds.has(node.id)) continue;
    const dense = await densifyNodeContent(node, densifierOptions);
    compressed.push({
      ...node,
      content: dense,
      metadata: {
        ...node.metadata,
        ...(dense !== node.content ? { densified: true } : {}),
      },
    });
  }

  return compressed;
}
