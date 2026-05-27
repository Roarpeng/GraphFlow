export type TaskComplexity = "simple" | "complex";

const COMPLEX_HINTS = [
  "multi",
  "across",
  "refactor",
  "architecture",
  "module",
  "parallel",
  "dag",
  "graph",
  "and",
];

export function triageTask(task: string): TaskComplexity {
  const normalized = task.toLowerCase();
  const hitCount = COMPLEX_HINTS.filter((hint) => normalized.includes(hint)).length;

  if (task.length > 80 || hitCount >= 2) {
    return "complex";
  }

  return "simple";
}
