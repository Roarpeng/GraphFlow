/**
 * Adaptive token budget allocation based on task complexity heuristics.
 *
 * Instead of a fixed maxContextTokens (e.g., 1500), we dynamically predict
 * how much context a task needs by analyzing its description.
 */

export type TaskMode = "simple" | "complex";

export interface BudgetEstimate {
  tokens: number;
  rationale: string;
  mode: TaskMode;
}

/**
 * Estimates required context tokens for a given task. Returns a budget
 * recommendation based on heuristic signals (refactor, multi-file, etc.).
 */
export function estimateContextBudget(task: string, mode: TaskMode): BudgetEstimate {
  let base = mode === "simple" ? 800 : 1500;
  const signals: string[] = [];

  // Signal 1: Refactoring / migration tasks need more context.
  if (/refactor|migrate|rewrite|reorganize/i.test(task)) {
    base *= 1.5;
    signals.push("refactor (+50%)");
  }

  // Signal 2: Multi-file coordination ("and", commas, semicolons).
  const splitCount = (task.match(/\band\b|,|;/gi) || []).length;
  if (splitCount > 2) {
    base *= 1.2;
    signals.push(`multi-part (${splitCount} splits, +20%)`);
  }

  // Signal 3: Architecture / design tasks need broader context.
  if (/architect|design|structure|module|component/i.test(task)) {
    base *= 1.3;
    signals.push("architecture (+30%)");
  }

  // Signal 4: Bug fix / localized changes need less context.
  if (/fix\s+bug|patch|hotfix|typo/i.test(task)) {
    base *= 0.7;
    signals.push("localized fix (-30%)");
  }

  // Signal 5: Adding tests usually needs implementation + existing test patterns.
  if (/add\s+test|write\s+test|test\s+coverage/i.test(task)) {
    base *= 1.15;
    signals.push("test addition (+15%)");
  }

  // Cap at reasonable limits.
  const tokens = Math.max(400, Math.min(Math.round(base), 4000));

  const rationale =
    signals.length > 0
      ? `Base ${mode === "simple" ? 800 : 1500} → ${signals.join(", ")} → ${tokens}`
      : `Default ${tokens} for ${mode} task`;

  return { tokens, rationale, mode };
}
