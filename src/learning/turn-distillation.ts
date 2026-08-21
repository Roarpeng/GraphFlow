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
