import { logger } from "../utils/logger";
import type { TaskNode } from "./types";
import type { GraphClient } from "../graph/client-factory";
import { DagCheckpoint, computeDagId } from "./dag-checkpoint";
import {
  createMergedAbortSignal,
  createTimeoutSignal,
  emitRuntimeTimeline,
  waitWhilePaused,
} from "./cancellation";
import type { RuntimeController } from "./runtime-controller";

export type TaskExecutor = (task: TaskNode, signal?: AbortSignal) => Promise<boolean>;

export interface DagExecutionOptions {
  concurrencyLimit?: number;
  nodeTimeoutMs?: number;
  /** Parent cancel signal for the whole DAG run. */
  signal?: AbortSignal;
  /** Unified cancel/pause/resume controller (preferred over bare signal). */
  runtime?: RuntimeController;
  /** 图存储客户端，用于 DAG 执行状态持久化（checkpoint）。不提供时纯内存执行。 */
  graphClient?: GraphClient;
  /** DAG 检查点 ID，格式 dag:${taskHash}。不提供时根据 plan 自动计算。 */
  dagId?: string;
  /** 是否启用 checkpoint 持久化，默认当 graphClient 存在时启用。 */
  enableCheckpoint?: boolean;
}

export interface DagExecutionResult {
  completed: string[];
  failed: string[];
  blocked: string[];
  rounds: string[][];
  /** 从 checkpoint 恢复（跳过）的节点 id 列表 */
  restoredFromCheckpoint?: string[];
}

export async function executeDag(
  plan: TaskNode[],
  executor: TaskExecutor,
  options?: DagExecutionOptions,
): Promise<DagExecutionResult> {
  const tasks = new Map(plan.map((task) => [task.id, task]));
  const completed = new Set<string>();
  const failed = new Set<string>();
  const blocked = new Set<string>();
  const rounds: string[][] = [];
  const timeoutMs = options?.nodeTimeoutMs ?? 30_000;

  // ── Checkpoint 恢复：尝试加载已完成的节点，跳过重复执行 ──
  const graphClient = options?.graphClient;
  const enableCheckpoint = options?.enableCheckpoint ?? Boolean(graphClient);
  let checkpoint: DagCheckpoint | undefined;
  let dagId: string | undefined;
  const restoredFromCheckpoint: string[] = [];

  if (enableCheckpoint && graphClient) {
    try {
      checkpoint = new DagCheckpoint(graphClient);
      dagId = options?.dagId ?? computeDagId(plan);
      const restored = await checkpoint.loadCheckpoint(dagId);
      for (const [nodeId, state] of restored) {
        if (state.status === "COMPLETED") {
          completed.add(nodeId);
          restoredFromCheckpoint.push(nodeId);
        } else if (state.status === "FAILED") {
          failed.add(nodeId);
          restoredFromCheckpoint.push(nodeId);
        }
      }
      if (restoredFromCheckpoint.length > 0) {
        logger.info(
          { dagId, restored: restoredFromCheckpoint.length },
          "DAG checkpoint 命中，跳过已完成节点",
        );
      }
    } catch (error) {
      logger.warn({ error }, "DAG checkpoint 初始化失败，降级为纯内存执行");
      checkpoint = undefined;
      dagId = undefined;
    }
  }

  while (completed.size + failed.size + blocked.size < tasks.size) {
    const ready = Array.from(tasks.values()).filter((task) => {
      if (completed.has(task.id) || failed.has(task.id) || blocked.has(task.id)) {
        return false;
      }
      return task.dependencies.every((depId) => completed.has(depId));
    });

    if (ready.length === 0) {
      // 标记所有剩余未处理且依赖中有 failed/blocked 的节点为 blocked
      for (const task of tasks.values()) {
        if (completed.has(task.id) || failed.has(task.id) || blocked.has(task.id)) {
          continue;
        }
        const hasFailedDep = task.dependencies.some(
          (depId) => failed.has(depId) || blocked.has(depId),
        );
        if (hasFailedDep) {
          blocked.add(task.id);
        }
      }
      // 继续迭代直到没有新的 blocked 被添加或全部处理完
      const remaining = Array.from(tasks.values()).filter(
        (t) => !completed.has(t.id) && !failed.has(t.id) && !blocked.has(t.id),
      );
      if (remaining.length === 0) {
        break;
      }
      // 如果还有剩余但无法前进，再做一轮 blocked 传播
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of remaining) {
          if (blocked.has(task.id)) continue;
          const hasBlockedDep = task.dependencies.some(
            (depId) => failed.has(depId) || blocked.has(depId),
          );
          if (hasBlockedDep) {
            blocked.add(task.id);
            changed = true;
          }
        }
      }
      break;
    }

    rounds.push(ready.map((task) => task.id));

    // 应用并发限制：分批执行
    const limit = options?.concurrencyLimit;
    const batches: TaskNode[][] = [];
    if (limit && limit > 0) {
      for (let i = 0; i < ready.length; i += limit) {
        batches.push(ready.slice(i, i + limit));
      }
    } else {
      batches.push(ready);
    }

    for (const batch of batches) {
      try {
        await waitWhilePaused(options?.runtime);
      } catch (error) {
        for (const task of batch) {
          emitRuntimeTimeline({
            phase: "dag.node",
            status: "aborted",
            id: task.id,
            detail: error instanceof Error ? error.message : String(error),
          });
          failed.add(task.id);
        }
        continue;
      }

      const results = await Promise.all(
        batch.map(async (task) => {
          try {
            await waitWhilePaused(options?.runtime);
          } catch (error) {
            emitRuntimeTimeline({
              phase: "dag.node",
              status: "aborted",
              id: task.id,
              detail: error instanceof Error ? error.message : String(error),
            });
            return { task, ok: false };
          }

          const parentSignal = createMergedAbortSignal([options?.signal, options?.runtime?.signal]);
          const startedAt = Date.now();
          const { signal, abort, dispose } = createTimeoutSignal(timeoutMs, parentSignal.signal);
          emitRuntimeTimeline({ phase: "dag.node", status: "started", id: task.id });

          // Signal-aware executors cancel in-flight work (e.g. provider fetch).
          const taskPromise = Promise.resolve().then(() => executor(task, signal));
          // Prevent unhandled rejection after we stop awaiting (timeout/abort race).
          void taskPromise.catch(() => undefined);

          const abortWait = new Promise<never>((_, reject) => {
            if (signal.aborted) {
              reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted")),
              { once: true }
            );
          });

          let ok: boolean;
          try {
            ok = await Promise.race([taskPromise, abortWait]);
            emitRuntimeTimeline({
              phase: "dag.node",
              status: "completed",
              id: task.id,
              durationMs: Date.now() - startedAt,
            });
          } catch (error) {
            if (!signal.aborted) {
              abort(error);
            }
            const reasonText =
              signal.reason instanceof Error
                ? signal.reason.message
                : error instanceof Error
                  ? error.message
                  : String(signal.reason ?? error);
            const timedOut = signal.aborted && /timed out/i.test(reasonText);
            emitRuntimeTimeline({
              phase: "dag.node",
              status: timedOut ? "timeout" : signal.aborted ? "aborted" : "failed",
              id: task.id,
              detail: error instanceof Error ? error.message : String(error),
              durationMs: Date.now() - startedAt,
            });
            logger.error({ error, taskId: task.id }, "DAG task execution failed");
            ok = false;
          } finally {
            dispose();
            parentSignal.dispose();
          }
          return { task, ok };
        }),
      );

      for (const result of results) {
        if (result.ok) {
          completed.add(result.task.id);
        } else {
          failed.add(result.task.id);
        }
        // 持久化节点完成状态到 checkpoint（失败时优雅降级，不影响执行）
        if (checkpoint && dagId) {
          try {
            await checkpoint.saveNodeCompletion(dagId, result.task, result.ok);
          } catch (error) {
            logger.warn({ error, taskId: result.task.id }, "DAG checkpoint 持久化失败");
          }
        }
      }
    }
  }

  return {
    completed: Array.from(completed),
    failed: Array.from(failed),
    blocked: Array.from(blocked),
    rounds,
    ...(restoredFromCheckpoint.length > 0 ? { restoredFromCheckpoint } : {}),
  };
}
