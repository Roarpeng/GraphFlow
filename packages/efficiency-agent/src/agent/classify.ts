import type { HarnessComplexity } from "../dynamic-harness.js";

/**
 * Deterministic task classifiers (2.x plan §11 complexity classifier, §24
 * categories). Keyword rules only — the category drives cache eligibility
 * (result reuse is limited to read-only categories) and harness sizing.
 */

export type TaskCategory =
  | "query"
  | "docs"
  | "config"
  | "test"
  | "bugfix"
  | "refactor"
  | "single-file"
  | "multi-file"
  | "cross-module";

const RULES: ReadonlyArray<{ category: TaskCategory; pattern: RegExp }> = [
  { category: "cross-module", pattern: /\b(across|end to end|end-to-end|cross-module|architecture|design and implement)\b|跨模块|架构|端到端/i },
  { category: "refactor", pattern: /\b(refactor|restructure|consolidate|unify|extract|rename)\b|重构|统一|合并|抽取|重命名/i },
  { category: "bugfix", pattern: /\b(fix(es|ed|ing)?|bugs?|crash(es|ed|ing)?|broken|breaks|regressions?|errors?|fail(s|ed|ing|ure)?)\b|修复|错误|异常|崩溃|失败|故障/i },
  { category: "test", pattern: /\b(add|write)\s+(a\s+)?tests?\b|\bunit tests?\b|补测试|写测试|单元测试/i },
  { category: "docs", pattern: /\b(document|readme|changelog|docs?)\b|文档|说明/i },
  { category: "config", pattern: /\b(config(ure|uration)?|setting|env(ironment)? var)\b|配置|设置/i },
  { category: "query", pattern: /^(where|what|which|how|why|who|when|explain|list|show|find)\b|\?$|？$|哪里|哪个|什么|如何|怎么|为什么|解释|列出/i },
];

export function classifyTaskCategory(task: string): TaskCategory {
  const text = task.trim();
  // Questions are read-only even when they mention fix/config/etc.
  if (/^(where|what|which|how|why|who|when|explain)\b/i.test(text) || /[?？]$/.test(text)) {
    return "query";
  }
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }
  return "single-file";
}

/** Categories whose output is an answer, not a change. */
export function isReadOnlyCategory(category: string): boolean {
  return category === "query" || category === "docs" || category === "config";
}

/**
 * §11: trivial only for a replayable REUSE verdict; read-only answers are
 * simple; contained changes medium; cross-cutting work complex.
 */
export function classifyHarnessComplexity(input: {
  category: string;
  reuseMode: "REUSE" | "ADAPT" | "FRESH";
  relevantFileCount: number;
}): HarnessComplexity {
  if (input.reuseMode === "REUSE") return "trivial";
  if (isReadOnlyCategory(input.category)) return "simple";
  if (input.category === "cross-module" || input.category === "refactor" || input.category === "multi-file") {
    return "complex";
  }
  return input.relevantFileCount > 4 ? "complex" : "medium";
}
