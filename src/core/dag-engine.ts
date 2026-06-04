import { logger } from "../utils/logger";
import type { TaskNode } from "./types";

export type TaskExecutor = (task: TaskNode) => Promise<boolean>;

export interface DagExecutionOptions {
  concurrencyLimit?: number;
  nodeTimeoutMs?: number;
}

export interface DagExecutionResult {
  completed: string[];
  failed: string[];
  blocked: string[];
  rounds: string[][];
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
      const results = await Promise.all(
        batch.map(async (task) => {
          // 包裹 timeout
          const taskPromise = executor(task);
          const timeoutPromise = new Promise<boolean>((_, reject) => {
            setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs);
          });
          let ok: boolean;
          try {
            ok = await Promise.race([taskPromise, timeoutPromise]);
          } catch (error) {
    logger.error({ error }, "Caught error");
            ok = false;
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
      }
    }
  }

  return {
    completed: Array.from(completed),
    failed: Array.from(failed),
    blocked: Array.from(blocked),
    rounds,
  };
}
