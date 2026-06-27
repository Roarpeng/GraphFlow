/**
 * dag-checkpoint.ts — DAG 执行状态持久化（Checkpoint）
 *
 * 在每个 DAG 节点执行完成后，将节点状态（id, status, result, retryCount, executedAt）
 * 持久化到图存储中（作为 TaskRun 类型的 GraphNode）。
 *
 * Checkpoint ID 使用 `dag:${taskHash}` 格式：
 * - taskHash 由 DAG 计划（节点 id / 描述 / 依赖）计算得出，保证同一计划可恢复。
 * - 整个 DAG 的 checkpoint 以单个 TaskRun GraphNode 的形式存储，content 字段为 JSON。
 *
 * 向后兼容：当图存储不支持 checkpoint 所需操作（getNodesByIds / upsertNodes）时，
 * 所有 checkpoint 操作都会优雅降级为纯内存执行，不会抛出错误。
 */

import { logger } from "../utils/logger";
import type { GraphNode } from "./types";
import type { TaskNode } from "./types";
import type { GraphClient } from "../graph/client-factory";
import { hashText } from "../utils/hash";

/** 单个节点的 checkpoint 状态快照 */
export interface CheckpointNodeState {
  /** 节点 id */
  id: string;
  /** 节点最终状态 */
  status: "COMPLETED" | "FAILED";
  /** 执行结果（成功 / 失败） */
  result: boolean;
  /** 节点重试次数 */
  retryCount: number;
  /** 执行完成时间（ISO 字符串） */
  executedAt: string;
}

/** Checkpoint 持久化内容结构 */
interface DagCheckpointContent {
  dagId: string;
  nodes: Record<string, CheckpointNodeState>;
}

/**
 * 计算 DAG 计划的任务哈希。
 *
 * 哈希输入为所有节点的 id / description / dependencies 的规范化拼接，
 * 保证相同计划产生相同哈希，从而命中同一 checkpoint。
 */
export function computeTaskHash(plan: TaskNode[]): string {
  const normalized = plan
    .map((node) => `${node.id}|${node.description}|${[...node.dependencies].sort().join(",")}`)
    .sort()
    .join("||");
  return hashText(normalized);
}

/**
 * 根据计划生成 checkpoint ID，格式 `dag:${taskHash}`。
 */
export function computeDagId(plan: TaskNode[]): string {
  return `dag:${computeTaskHash(plan)}`;
}

/**
 * DAG Checkpoint 持久化管理器。
 *
 * 用法：
 * ```ts
 * const cp = new DagCheckpoint(graphClient);
 * const restored = await cp.loadCheckpoint(dagId);     // 恢复已完成节点
 * await cp.saveNodeCompletion(dagId, node, true);       // 持久化节点完成状态
 * ```
 *
 * 所有操作均吞掉错误并记录 warn 日志，确保图存储不可用时不影响 DAG 执行。
 */
export class DagCheckpoint {
  /** 内存缓存：nodeId -> 节点状态。避免每次保存都重复读取图存储。 */
  private readonly cache = new Map<string, CheckpointNodeState>();
  /** 是否已从图存储加载过一次 */
  private hydrated = false;

  constructor(private readonly graphClient: GraphClient) {}

  /**
   * 从图存储加载 checkpoint，返回已完成节点的状态映射。
   *
   * 多次调用只会读取一次图存储，后续返回内存缓存。
   * 如果图存储不支持 getNodesByIds 或读取失败，返回空映射（优雅降级）。
   */
  async loadCheckpoint(dagId: string): Promise<Map<string, CheckpointNodeState>> {
    if (!this.hydrated) {
      this.hydrated = true;
      try {
        await this.hydrate(dagId);
      } catch (error) {
        logger.warn({ error, dagId }, "DAG checkpoint 读取失败，降级为纯内存执行");
      }
    }
    return new Map(this.cache);
  }

  /**
   * 持久化单个节点的完成状态到图存储。
   *
   * 内部维护内存缓存，每次保存都会将完整 checkpoint 重新写入图存储，
   * 保证崩溃后可从最近一次保存点恢复。
   */
  async saveNodeCompletion(
    dagId: string,
    node: TaskNode,
    result: boolean,
  ): Promise<void> {
    const state: CheckpointNodeState = {
      id: node.id,
      status: result ? "COMPLETED" : "FAILED",
      result,
      retryCount: node.retryCount,
      executedAt: new Date().toISOString(),
    };
    this.cache.set(node.id, state);

    try {
      await this.persist(dagId);
    } catch (error) {
      // 持久化失败不影响内存执行，仅记录告警
      logger.warn({ error, dagId, nodeId: node.id }, "DAG checkpoint 持久化失败");
    }
  }

  /**
   * 清除指定 DAG 的 checkpoint（例如全部完成后清理）。
   * 图存储支持 deleteNode 时才生效。
   */
  async clearCheckpoint(dagId: string): Promise<void> {
    this.cache.clear();
    this.hydrated = true;
    try {
      if (this.graphClient.deleteNode) {
        await this.graphClient.deleteNode(dagId);
      }
    } catch (error) {
      logger.warn({ error, dagId }, "DAG checkpoint 清除失败");
    }
  }

  /** 从图存储读取 checkpoint 内容并填充内存缓存。 */
  private async hydrate(dagId: string): Promise<void> {
    if (!this.graphClient.getNodesByIds) {
      return;
    }
    const hits = await this.graphClient.getNodesByIds([dagId]);
    const node = hits.find((n) => n.id === dagId && n.type === "TaskRun");
    if (!node) {
      return;
    }
    const parsed = JSON.parse(node.content) as Partial<DagCheckpointContent>;
    if (!parsed || typeof parsed !== "object" || !parsed.nodes) {
      return;
    }
    for (const [nodeId, state] of Object.entries(parsed.nodes)) {
      if (state && typeof state.id === "string") {
        this.cache.set(nodeId, state);
      }
    }
    logger.info({ dagId, restored: this.cache.size }, "DAG checkpoint 恢复完成");
  }

  /** 将当前内存缓存写入图存储（单个 TaskRun GraphNode）。 */
  private async persist(dagId: string): Promise<void> {
    if (!this.graphClient.upsertNodes) {
      return;
    }
    const content: DagCheckpointContent = {
      dagId,
      nodes: Object.fromEntries(this.cache),
    };
    const graphNode: GraphNode = {
      id: dagId,
      type: "TaskRun",
      content: JSON.stringify(content),
      metadata: {
        kind: "dag-checkpoint",
        dagId,
        nodeCount: this.cache.size,
        completed: Array.from(this.cache.values()).filter((s) => s.status === "COMPLETED").length,
        failed: Array.from(this.cache.values()).filter((s) => s.status === "FAILED").length,
      },
    };
    await this.graphClient.upsertNodes([graphNode]);
  }
}
