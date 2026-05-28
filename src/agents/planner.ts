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

export function planTasks(task: string, skillHints?: string[]): TaskNode[] {
  const parts = task
    .split(/\band\b|,|;/i)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (parts.length <= 1) {
    return [toNode("task-1", withSkillHints(task.trim(), skillHints), [])];
  }

  const parallelTasks = parts.map((part, index) =>
    toNode(`task-${index + 1}`, withSkillHints(part, skillHints), [])
  );
  const finalTask = toNode(
    `task-${parts.length + 1}`,
    withSkillHints(`integrate and verify: ${parts.join("; ")}`, skillHints),
    parallelTasks.map((item) => item.id)
  );

  return [...parallelTasks, finalTask];
}

function withSkillHints(task: string, skillHints?: string[]): string {
  if (!skillHints || skillHints.length === 0) {
    return task;
  }

  return `${task} | use skills: ${skillHints.join(", ")}`;
}
