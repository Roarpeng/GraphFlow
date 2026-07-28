/** Strong delimiters usually mark independent work items. */
const STRONG_TASK_SPLIT = /\band\b|;|并且|以及|然后|接着|同时|；|。/i;

/**
 * Weak delimiters often mark list items inside one intent
 * (e.g. "evaluate X: assumptions、failure modes、validation gates").
 */
const WEAK_TASK_SPLIT = /,|、|，/;

const ACTION_HINT =
  /\b(update|add|fix|refactor|implement|create|write|test|build|remove|delete|migrate|analyze|analyse|evaluate|review|design|improve|optimize|install|configure|document|validate|verify|investigate|compare|rank)\b|(更新|添加|增加|修复|重构|实现|创建|编写|测试|构建|删除|迁移|分析|评估|审查|设计|改进|优化|安装|配置|校验|验证|调研|对比)/i;

/**
 * True when a clause looks like an actionable subtask rather than a noun-phrase
 * dimension of a single analysis request.
 */
export function looksLikeActionableTaskClause(part: string): boolean {
  const text = part.trim().replace(/^[:：\-–—]\s*/, "");
  if (text.length < 6) {
    return false;
  }
  if (ACTION_HINT.test(text)) {
    return true;
  }
  // Short noun phrases ("failure modes", "validation gates") are not tasks.
  return false;
}

/**
 * Split a user task into independent work clauses for heuristic planning.
 * Prefer conjunction-style separators; only use commas/顿号 when every part
 * looks actionable so analytical lists stay one intent.
 */
export function splitTaskClauses(task: string): string[] {
  const normalized = task.trim();
  if (!normalized) {
    return [];
  }

  const strongParts = normalized
    .split(STRONG_TASK_SPLIT)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (strongParts.length > 1) {
    return strongParts;
  }

  const weakParts = normalized
    .split(WEAK_TASK_SPLIT)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (weakParts.length > 1 && weakParts.every((part) => looksLikeActionableTaskClause(part))) {
    return weakParts;
  }

  return [normalized];
}
