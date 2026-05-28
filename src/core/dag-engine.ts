import type { TaskNode } from "./types";

export type TaskExecutor = (task: TaskNode) => Promise<boolean>;

export interface DagExecutionResult {
  completed: string[];
  failed: string[];
  rounds: string[][];
}

export async function executeDag(plan: TaskNode[], executor: TaskExecutor): Promise<DagExecutionResult> {
  const tasks = new Map(plan.map((task) => [task.id, task]));
  const completed = new Set<string>();
  const failed = new Set<string>();
  const rounds: string[][] = [];

  while (completed.size + failed.size < tasks.size) {
    const ready = Array.from(tasks.values()).filter((task) => {
      if (completed.has(task.id) || failed.has(task.id)) {
        return false;
      }

      return task.dependencies.every((depId) => completed.has(depId));
    });

    if (ready.length === 0) {
      break;
    }

    rounds.push(ready.map((task) => task.id));

    const results = await Promise.all(
      ready.map(async (task) => ({ task, ok: await executor(task) }))
    );

    for (const result of results) {
      if (result.ok) {
        completed.add(result.task.id);
      } else {
        failed.add(result.task.id);
      }
    }
  }

  return {
    completed: Array.from(completed),
    failed: Array.from(failed),
    rounds,
  };
}
