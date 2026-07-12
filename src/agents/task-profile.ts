/**
 * Shared task-profile detectors for ATP short-path and agent-bridge compact mode.
 * Keep this module dependency-light so both LLM ATP and agent-delegation can share it.
 */

/** Hat colors kept on the research/analysis short path. */
export const RESEARCH_KEY_HAT_COLORS = ["white", "black", "yellow", "blue"] as const;

export type ResearchKeyHatColor = (typeof RESEARCH_KEY_HAT_COLORS)[number];

const RESEARCH_ANALYSIS_PATTERNS: RegExp[] = [
  /调研/,
  /分析/,
  /架构评审/,
  /架构分析/,
  /代码审查/,
  /探查/,
  /梳理/,
  /\bresearch\b/i,
  /\banaly[sz]e\b/i,
  /\banalysis\b/i,
  /architecture\s+(research|review|analysis)/i,
  /review\s+(the\s+)?codebase/i,
  /codebase\s+review/i,
  /\binvestigate\b/i,
  /\baudit\b/i,
  /\bdeep\s+dive\b/i,
];

/**
 * Coding/refactor tasks should keep the full ATP / agent-bridge ceremony.
 * Matched first so phrases like "refactor architecture module" stay full.
 */
const CODING_TASK_PATTERN =
  /\b(refactor|implement|fix|bugfix|patch|migrate|coding|code change|add tests?|write code|edit files?)\b/i;

/**
 * Detect research / architecture-analysis style tasks that benefit from a shorter ATP path
 * (Intent + key hats + decision matrix + plan + reflection; skip First Principles / 5-Why spam).
 */
export function isResearchAnalysisTask(task: string): boolean {
  const trimmed = task.trim();
  if (!trimmed) {
    return false;
  }
  return RESEARCH_ANALYSIS_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * True when agent-bridge should use the compact work-item set.
 * Defaults to full for coding/refactor; compact for research/analysis.
 */
export function isCompactAgentInsightTask(task: string): boolean {
  const normalized = task.trim();
  if (!normalized) {
    return false;
  }
  if (CODING_TASK_PATTERN.test(normalized)) {
    return false;
  }
  return isResearchAnalysisTask(normalized);
}

export function isResearchKeyHatColor(color: string): color is ResearchKeyHatColor {
  return (RESEARCH_KEY_HAT_COLORS as readonly string[]).includes(color);
}
