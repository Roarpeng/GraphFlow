/**
 * Turn distillation: offline, deterministic heuristics that shrink a raw
 * dialogue turn into a short title and a conclusion summary.
 *
 * Pure functions only — no LLM, no I/O, no side effects. Titles strip common
 * greeting/imperative prefixes and keep the first clause; summaries prefer the
 * sentence that carries a conclusion marker and otherwise fall back to the last
 * non-empty paragraph.
 */

/** Leading greeting / politeness / imperative prefixes stripped from a title. */
export const TITLE_STOP_PREFIXES: string[] = [
  "你好呀",
  "您好呀",
  "你好啊",
  "您好啊",
  "你好",
  "您好",
  "请问",
  "请",
  "帮我看看",
  "帮我看下",
  "帮我",
  "我想要",
  "我想",
  "我要",
  "麻烦你",
  "麻烦您",
  "嗨",
  "哈喽",
];

/** Conclusion markers whose sentence wins over the last-paragraph fallback. */
export const CONCLUSION_MARKERS: string[] = [
  "综上所述",
  "总而言之",
  "总之",
  "综上",
  "结论",
  "最终",
  "因此",
  "所以",
  "结果是",
  "已完成",
  "已实现",
  "建议",
];

const TITLE_MAX_CHARS = 30;
const SUMMARY_MAX_CHARS = 200;
const SENTENCE_SPLIT = /[。！？；!?;\n]+/;
const CLAUSE_SPLIT = /[，。！？；、]/;
const LEADING_PUNCT = /^[\s，。！？；、,.!?;:]+/;

/**
 * Characters that may follow the bare "请" prefix in a polite imperative.
 * This keeps "请帮我 / 请问 / 请说明" stripping while leaving compounds like
 * "请求" or "请假" intact.
 */
const IMPERATIVE_CONTINUATIONS = new Set([
  "你",
  "您",
  "我",
  "他",
  "她",
  "帮",
  "给",
  "问",
  "告",
  "回",
  "说",
  "解",
  "列",
  "写",
  "生",
  "提",
  "描",
  "处",
  "修",
  "分",
  "总",
  "概",
  "介",
  "查",
  "找",
]);

const SORTED_PREFIXES = [...TITLE_STOP_PREFIXES].sort((a, b) => b.length - a.length);

function hasContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function canStripPrefix(text: string, prefix: string): boolean {
  if (prefix.length === 0 || !text.startsWith(prefix)) return false;
  if (prefix.length > 1) return true;
  // Single-character prefix ("请"): require a polite-imperative continuation so
  // a compound root such as "请求"/"请假" is not mangled.
  const next = text[prefix.length];
  if (next === undefined) return true;
  return IMPERATIVE_CONTINUATIONS.has(next) || /[\s，。！？；、,.!?;]/.test(next);
}

function stripLeadingPrefixes(text: string): string {
  let current = text;
  let progress = true;
  while (progress) {
    progress = false;
    const withoutPunct = current.replace(LEADING_PUNCT, "");
    if (withoutPunct !== current) {
      current = withoutPunct;
      progress = true;
      continue;
    }
    for (const prefix of SORTED_PREFIXES) {
      if (canStripPrefix(current, prefix)) {
        current = current.slice(prefix.length);
        progress = true;
        break;
      }
    }
  }
  return current;
}

export function deriveTurnTitle(userQuery: string): string {
  const trimmed = userQuery.trim();
  if (!trimmed || !hasContent(trimmed)) return "";
  const stripped = stripLeadingPrefixes(trimmed);
  if (!stripped) return clip(trimmed, TITLE_MAX_CHARS);
  const firstClause = stripped.split(CLAUSE_SPLIT)[0]?.trim() ?? "";
  return clip(firstClause || stripped, TITLE_MAX_CHARS) || clip(trimmed, TITLE_MAX_CHARS);
}

export function deriveTurnSummary(assistantReply: string): string {
  const trimmed = assistantReply.trim();
  if (!trimmed || !hasContent(trimmed)) return "";

  const sentences = trimmed
    .split(SENTENCE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && hasContent(part));
  for (const sentence of sentences) {
    if (CONCLUSION_MARKERS.some((marker) => sentence.includes(marker))) {
      return clip(sentence, SUMMARY_MAX_CHARS);
    }
  }

  const paragraphs = trimmed
    .split(/\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && hasContent(part));
  const last = paragraphs[paragraphs.length - 1];
  return clip(last ?? trimmed, SUMMARY_MAX_CHARS);
}

// ───────────────── Conversation Graph 2.0: optional LLM distillation ─────────────────

/** Distillation result with provenance: which path produced the fields. */
export interface DistilledTurn {
  title: string;
  summary: string;
  /** True when a decision-relevant turn: the answer chooses between options / changes direction. */
  decisionTurn: boolean;
  /** "heuristic" (offline default) or "llm" (optional model path). */
  source: "heuristic" | "llm";
}

/** Minimal injected LLM call: prompt in, plain text out. The runtime wires this to the economy tier. */
export type DistillGenerateFn = (prompt: string) => Promise<string>;

/**
 * Decision markers that make a turn "decision-relevant" for the flywheel:
 * the answer/reply commits to a choice, correction, or direction change
 * rather than only describing facts. Feeds the skill-admission evidence
 * chain (turn-granularity learning signal).
 */
const DECISION_TURN_MARKERS: string[] = [
  "建议",
  "推荐",
  "选择",
  "决定",
  "方案",
  "更正",
  "修正",
  "改为",
  "放弃",
  "优先",
  "结论",
  "recommend",
  "suggest",
  "choose",
  "decide",
  "correction",
  "instead",
  "prefer",
  "conclusion",
  "we should",
  "let's go with",
];

export function isDecisionTurn(userQuery: string, assistantReply: string): boolean {
  const haystack = `${userQuery}\n${assistantReply}`.toLowerCase();
  return DECISION_TURN_MARKERS.some((marker) => haystack.includes(marker.toLowerCase()));
}

/** Heuristic distillation (existing behavior, now also reports decisionTurn). */
export function distillTurnHeuristic(userQuery: string, assistantReply: string): DistilledTurn {
  return {
    title: deriveTurnTitle(userQuery),
    summary: deriveTurnSummary(assistantReply),
    decisionTurn: isDecisionTurn(userQuery, assistantReply),
    source: "heuristic",
  };
}

const LLM_DISTILL_PROMPT_MAX_QUERY = 600;
const LLM_DISTILL_PROMPT_MAX_REPLY = 2_400;

/**
 * Optional LLM distillation path (Conversation Graph W1b).
 *
 * `generate` receives a compact Chinese+English instruction and must answer
 * with two lines: `Title: <short title>` and `Summary: <one-sentence
 * conclusion>`. Any missing/blank generation, missing `generate`, or a
 * thrown error falls back to the deterministic heuristic — no Key, no LLM,
 * no network ever breaks turn recording.
 */
export async function distillTurnWithLlm(
  userQuery: string,
  assistantReply: string,
  generate?: DistillGenerateFn
): Promise<DistilledTurn> {
  const fallback = distillTurnHeuristic(userQuery, assistantReply);
  if (typeof generate !== "function") return fallback;
  if (!userQuery.trim() || !assistantReply.trim()) return fallback;

  const prompt = [
    "你是对话蒸馏器。把下面一轮问答蒸馏成标题和结论。",
    "Title: 一行不超过 24 字的标题（去掉称呼语）。",
    "Summary: 一句话结论（不超过 60 字，优先结论句）。",
    "Decision: 若回答中做出了选择/修正/方向改变则 yes，否则 no。",
    "只输出这三行，格式严格为：",
    "Title: …",
    "Summary: …",
    "Decision: yes|no",
    "",
    `问题: ${clip(userQuery, LLM_DISTILL_PROMPT_MAX_QUERY)}`,
    `回答: ${clip(assistantReply, LLM_DISTILL_PROMPT_MAX_REPLY)}`,
  ].join("\n");

  let raw: string;
  try {
    raw = await generate(prompt);
  } catch {
    return fallback;
  }
  if (typeof raw !== "string" || !raw.trim()) return fallback;

  const title = matchLabeledLine(raw, "Title");
  const summary = matchLabeledLine(raw, "Summary");
  const decision = /^Decision:\s*(yes|no)\s*$/im.exec(raw)?.[1]?.toLowerCase() === "yes";
  if (!title && !summary) return fallback;

  return {
    title: title || fallback.title,
    summary: summary || fallback.summary,
    decisionTurn: decision || fallback.decisionTurn,
    source: "llm",
  };
}

function matchLabeledLine(text: string, label: string): string {
  const match = new RegExp(`^${label}:\\s*(.+)$`, "mi").exec(text);
  const value = match?.[1]?.trim();
  return value ? clip(value, label === "Title" ? TITLE_MAX_CHARS * 2 : SUMMARY_MAX_CHARS) : "";
}
