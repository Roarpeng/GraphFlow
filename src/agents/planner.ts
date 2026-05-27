import type { TaskNode } from "../core/types";

function toNode(id: string, description: string, dependencies: string[]): TaskNode {
  return {
    id,
    description,
    dependencies,
    status: "PENDING",
    contextQuery: description,
    retryCount: 0,
  };
}

export function planTasks(task: string): TaskNode[] {
  const parts = task
    .split(/\band\b|,|;/i)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (parts.length <= 1) {
    return [toNode("task-1", task.trim(), [])];
  }

  return parts.map((part, index) =>
    toNode(`task-${index + 1}`, part, index === 0 ? [] : [`task-${index}`])
  );
}
