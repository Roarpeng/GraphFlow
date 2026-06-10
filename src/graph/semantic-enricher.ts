import { logger } from "../utils/logger";
import type { GraphClient } from "./client-factory";
import { executeRolePrompt } from "../routing/provider-executor";
import { resolveModelForRole } from "../routing/model-router";
import type { GraphNode } from "../core/types";

export interface EnricherOptions {
  batchSize?: number;
  sleepMs?: number;
  /** Explicit model override; when omitted, routing uses semanticEnrichment/economy tier config. */
  model?: string;
  /** @deprecated Use `model` instead. */
  openbmbModel?: string;
  timeoutMs?: number;
}

/**
 * 后台静默富化图谱节点语义
 */
export async function enrichGraphSemanticsSilent(
  client: GraphClient,
  options?: EnricherOptions
): Promise<{ enrichedCount: number }> {
  if (!client.readSnapshot || typeof client.readSnapshot !== "function") {
    return { enrichedCount: 0 };
  }

  const batchSize = options?.batchSize ?? 5;
  const sleepMs = options?.sleepMs ?? 0;
  const modelOverride = options?.model ?? options?.openbmbModel;
  const timeoutMs = options?.timeoutMs;

  // 1. 读取当前图谱快照
  const snapshot = await client.readSnapshot();

  // 2. 筛选出缺乏自然语言摘要说明的 Symbol 节点
  const pendingNodes = snapshot.nodes.filter((node) => {
    if (node.type !== "Symbol") return false;
    const meta = (node.metadata || {}) as any;
    return !meta.summary || meta.summary.trim().length === 0;
  });

  if (pendingNodes.length === 0) {
    return { enrichedCount: 0 };
  }

  // 3. 小批量增量提取并分析
  const batch = pendingNodes.slice(0, batchSize);
  const updatedNodes: GraphNode[] = [];

  for (const node of batch) {
    const codeSignature = node.content; // 原有的代码签名行
    const fileSource = node.metadata?.file ?? "unknown";

    // 构建极度精炼、专为 1B 小模型设计的分类富化 prompt
    const prompt = [
      "你是一个卓越的代码语义分析器。",
      "请用一句话极其精炼地总结以下代码片段或函数签名的核心功能，限 20 字以内（使用中文）。",
      "绝不要输出任何解释、标点或引言，直接给出核心功能总结。",
      `代码签名: ${safeQuote(codeSignature)}`,
      `所在文件: ${fileSource}`,
      "功能总结:"
    ].join("\n");

    try {
      const selection = resolveModelForRole("enricher");
      if (modelOverride?.trim()) {
        selection.model = modelOverride.trim();
      }

      const previousTimeout = process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;
      if (timeoutMs !== undefined) {
        process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = String(timeoutMs);
      }

      let rawSummary = "";
      try {
        rawSummary = await executeRolePrompt("enricher", prompt, selection);
      } finally {
        if (timeoutMs !== undefined) {
          if (previousTimeout === undefined) {
            delete process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS;
          } else {
            process.env.GRAPHFLOW_PROVIDER_TIMEOUT_MS = previousTimeout;
          }
        }
      }

      const summary = rawSummary.trim().replace(/^功能总结[:：]?\s*/, "");

      // 5. 写入 metadata 存储
      updatedNodes.push({
        ...node,
        metadata: {
          ...node.metadata,
          summary: summary || "无描述",
          enrichedAt: Date.now()
        }
      });

      // 批次内微休眠，保护系统 IO 性能
      if (sleepMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
    } catch (error) {
    logger.error({ error }, "Caught error");
      // 异常保护，如果小模型离线或限流，跳过当前节点，保证后台线程绝对健壮
      continue;
    }
  }

  // 6. 增量写回图谱数据库 (SQLite 或 File 自动增量更新)
  if (updatedNodes.length > 0) {
    await client.upsertNodes(updatedNodes);
  }

  return { enrichedCount: updatedNodes.length };
}

function safeQuote(value: string): string {
  return "```\n" + value.replace(/```/g, "''").slice(0, 800) + "\n```";
}
