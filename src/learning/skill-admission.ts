/**
 * Held-out skill admission gate (Experience v2 P1).
 *
 * Generic stopwords and readme+update fusions never become proven.
 * Proven requires project-symbol shape and overlap with the retrieval-golden
 * expected file stems / symbols — UNLESS the skill carries a real success
 * evidence chain (successCount >= DEFAULT_PROVEN_MIN_SUCCESS deduped pass
 * episodes), which bypasses the golden-overlap gate entirely: a name that
 * appears in no static list can still be admitted on real success evidence.
 * Do not run the full retrieval benchmark here.
 *
 * The golden vocabulary is DYNAMIC, not a hardcoded closed set:
 *  - base tokens are extracted best-effort from the repo's retrieval golden
 *    dataset (`benchmarks/datasets/retrieval-golden-v1.json`); when the file
 *    cannot be found the set degrades to empty — no hard runtime dependency
 *    on that path;
 *  - real episode/symbol evidence observed at runtime is overlaid via
 *    registerGoldenEvidenceTokens() (pass episodes feed their plan /
 *    key-decision symbols in, see episodic-memory / workflow-skill);
 *  - callers may also pass per-call evidence (extraGoldenTokens).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * proven 准入阈值：绑定到技能且 outcome=pass 的去重 episode 数。
 * 默认 2；可用环境变量 GRAPHFLOW_SKILL_PROVEN_MIN_SUCCESS 覆盖。
 */
export const DEFAULT_PROVEN_MIN_SUCCESS = 2;

/** 解析 proven 成功 episode 阈值（允许配置/env 覆盖，非法值回退默认）。 */
export function resolveProvenMinSuccess(): number {
  const raw = process.env.GRAPHFLOW_SKILL_PROVEN_MIN_SUCCESS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PROVEN_MIN_SUCCESS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.floor(parsed)
    : DEFAULT_PROVEN_MIN_SUCCESS;
}

const STOPWORDS = new Set([
  "update", "readme", "add", "fix", "file", "files",
  "module", "the", "and", "with", "in", "a", "an", "to", "for", "of",
  "on", "at", "by", "from", "is", "are", "was", "were", "be", "been",
  "or", "not", "but", "this", "that", "it", "as", "if", "do", "done",
]);

const PROJECT_SYMBOL_PATTERNS: Array<{ test: RegExp; match: RegExp }> = [
  { test: /[a-z0-9_./-]+\.[a-z0-9]{2,8}\b/i, match: /[a-z0-9_./-]+\.[a-z0-9]{2,8}\b/gi },
  { test: /\b[a-z0-9_-]+\/[a-z0-9_./-]+\b/i, match: /\b[a-z0-9_-]+\/[a-z0-9_./-]+\b/gi },
  { test: /[a-z]+[A-Z][a-zA-Z0-9]*/, match: /[a-z]+[A-Z][a-zA-Z0-9]*/g },
  { test: /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/i, match: /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi },
];

export interface SkillAdmissionResult {
  ok: boolean;
  reason: string;
}

function flattenSkillName(name: string): string {
  return name.replace(/\+/g, " ").trim();
}

function tokenizePhrase(phrase: string): string[] {
  return phrase
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

/** True when every non-empty token is a generic stopword (e.g. "readme+update"). */
export function isStopwordOnlyName(name: string): boolean {
  const tokens = tokenizePhrase(flattenSkillName(name));
  if (tokens.length === 0) {
    return true;
  }
  return tokens.every((token) => STOPWORDS.has(token));
}

/** True when the name is a generic readme/update fusion, with or without `+`. */
export function isReadmeUpdateNoise(name: string): boolean {
  const tokens = new Set(tokenizePhrase(flattenSkillName(name)));
  return tokens.has("readme") && tokens.has("update");
}

function hasProjectSymbolShape(text: string): boolean {
  if (!text) {
    return false;
  }
  return PROJECT_SYMBOL_PATTERNS.some(({ test }) => test.test(text));
}

/**
 * True when the skill name itself looks like a project symbol
 * (file / slash-path / camelCase / snake_case). Composite "+" is flattened.
 * Stopword-only fusions such as "readme+update" never qualify — even if a
 * legacy `hasSymbolEvidence` flag was wrongly set.
 */
export function isSymbolicSkillName(name: string): boolean {
  const flattened = flattenSkillName(name);
  if (!flattened || isStopwordOnlyName(name)) {
    return false;
  }
  return hasProjectSymbolShape(flattened);
}

function stripExtension(token: string): string {
  return token.replace(/\.[a-z0-9]{1,8}$/i, "");
}

function compactToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function splitCamelCase(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0);
}

function collectNameTokens(skillName: string): Set<string> {
  const out = new Set<string>();
  const add = (raw: string): void => {
    const lower = raw.toLowerCase().trim();
    if (lower.length < 3) {
      return;
    }
    out.add(lower);
    const stem = stripExtension(lower);
    if (stem.length >= 3) {
      out.add(stem);
    }
    const compact = compactToken(raw);
    if (compact.length >= 3) {
      out.add(compact);
    }
  };

  add(skillName);
  for (const part of flattenSkillName(skillName).split(/[\s,;/]+/)) {
    add(part);
    for (const camel of splitCamelCase(part)) {
      add(camel);
    }
  }
  for (const camel of splitCamelCase(skillName)) {
    add(camel);
  }
  return out;
}

/** 归一化 golden 词（原始小写 + 去扩展名词干 + 紧凑形态），与名称侧 token 化一致。 */
function normalizeGoldenTokens(tokens: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const raw of tokens) {
    const lower = raw.toLowerCase().trim();
    if (lower.length < 3) {
      continue;
    }
    out.add(lower);
    const stem = stripExtension(lower);
    if (stem.length >= 3) {
      out.add(stem);
    }
    const compact = compactToken(raw);
    if (compact.length >= 3) {
      out.add(compact);
    }
  }
  return Array.from(out);
}

const GOLDEN_DATASET_RELPATH = "benchmarks/datasets/retrieval-golden-v1.json";

/** 候选数据集路径：显式 env 覆盖优先，其次 cwd 相对路径，最后向上逐层探测。 */
export function resolveGoldenDatasetCandidates(): string[] {
  const candidates: string[] = [];
  const explicit = process.env.GRAPHFLOW_GOLDEN_DATASET;
  if (explicit !== undefined && explicit.trim().length > 0) {
    candidates.push(explicit.trim());
  }
  candidates.push(resolve(process.cwd(), GOLDEN_DATASET_RELPATH));
  let dir = process.cwd();
  for (let depth = 0; depth < 4; depth += 1) {
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
    candidates.push(resolve(dir, GOLDEN_DATASET_RELPATH));
  }
  return candidates;
}

/**
 * Best-effort 读取仓库自带检索 golden 数据集（retrieval-golden-v1.json）的
 * expectAny 词。读不到 / 解析失败返回空数组——绝不抛出，绝不硬依赖该路径。
 */
export function loadRetrievalGoldenTokens(): string[] {
  const raw: string[] = [];
  for (const candidate of resolveGoldenDatasetCandidates()) {
    try {
      if (!existsSync(candidate)) {
        continue;
      }
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
        queries?: Array<{ expectAny?: unknown }>;
      };
      const queries = Array.isArray(parsed.queries) ? parsed.queries : [];
      for (const query of queries) {
        const anyList = Array.isArray(query?.expectAny) ? query.expectAny : [];
        for (const value of anyList) {
          if (typeof value === "string" && value.trim().length > 0) {
            raw.push(value.trim());
          }
        }
      }
      if (raw.length > 0) {
        break; // 第一个可读且非空的数据集胜出
      }
    } catch {
      // 单个候选失败不影响其它候选；最终空集兜底
    }
  }
  return raw;
}

/**
 * 从 episode 文本（task / plan 描述 / keyDecisions）提取 golden 证据词。
 * 叠加真实 episode/symbol 证据用：只保留有信息量的词（>=5 字符、非停用词）。
 */
export function extractGoldenEvidenceTokens(
  texts: Iterable<string>,
  limit = 200
): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    if (!text) {
      continue;
    }
    for (const raw of text.split(/[^a-z0-9_./-]+/i)) {
      const token = raw.trim().toLowerCase();
      if (isWeakOverlapToken(token)) {
        continue;
      }
      out.add(token);
      const compact = compactToken(token);
      if (compact.length >= 5) {
        out.add(compact);
      }
      if (out.size >= limit) {
        break;
      }
    }
    if (out.size >= limit) {
      break;
    }
  }
  return Array.from(out).slice(0, limit);
}

/** 运行时观察到的真实证据词（pass episode 的符号词等），进程内叠加进动态词集。 */
const runtimeEvidenceTokens = new Set<string>();

/**
 * 叠加真实 episode/symbol 证据到动态 golden 词集（幂等）。
 * 返回本次新增的词数。
 */
export function registerGoldenEvidenceTokens(tokens: Iterable<string>): number {
  let added = 0;
  for (const token of normalizeGoldenTokens(tokens)) {
    if (!runtimeEvidenceTokens.has(token)) {
      runtimeEvidenceTokens.add(token);
      added += 1;
    }
    // 动态集已构建时即时合并（进程内增量叠加）。
    if (dynamicGoldenSet) {
      dynamicGoldenSet.add(token);
    }
  }
  return added;
}

let dynamicGoldenSet: Set<string> | undefined;

/** 懒构建动态 golden 词集：检索数据集词 + 运行时证据词。 */
function getDynamicGoldenSet(): Set<string> {
  if (!dynamicGoldenSet) {
    dynamicGoldenSet = new Set<string>(
      normalizeGoldenTokens([...loadRetrievalGoldenTokens(), ...runtimeEvidenceTokens])
    );
  }
  return dynamicGoldenSet;
}

function isWeakOverlapToken(token: string): boolean {
  return STOPWORDS.has(token) || token.length < 5;
}

/**
 * Held-out overlap: skill name tokens vs golden expected file stems / symbols.
 * 词集动态生成；`extraGoldenTokens` 可叠加调用方持有的运行时证据。
 */
export function goldenTokenOverlap(
  skillName: string,
  extraGoldenTokens?: Iterable<string>
): string[] {
  const base = getDynamicGoldenSet();
  const set = extraGoldenTokens
    ? new Set<string>([...base, ...normalizeGoldenTokens(extraGoldenTokens)])
    : base;
  const hits: string[] = [];
  for (const token of collectNameTokens(skillName)) {
    if (isWeakOverlapToken(token)) {
      continue;
    }
    if (set.has(token)) {
      hits.push(token);
    }
  }
  return hits;
}

export interface AdmitSkillOptions {
  /** 绑定到技能且 outcome=pass 的去重 episode 数（真实成功证据链）。 */
  successCount?: number;
  /** 调用方运行时证据（如绑定 episode 的符号词）叠加进 golden 判定。 */
  extraGoldenTokens?: Iterable<string>;
}

/**
 * Admission gate before a skill may stay `proven`.
 * 主要门槛：successCount（真实成功 episode 绑定计数）>= 阈值（默认 2）。
 * 达到阈值即准入——闭集外的名字只要有真实成功证据链也可准入；
 * golden-overlap / 符号证据检查作为辅助条件保留（未达阈值时仍生效），
 * 但不再一票否决有真实成功记录的技能。Generic stopwords / readme+update
 * 融合（结构性噪声，非闭集检查）永远不通过。
 */
export function admitSkillToProven(
  skillName: string,
  options?: AdmitSkillOptions
): SkillAdmissionResult {
  const name = skillName.trim();
  if (!name) {
    return { ok: false, reason: "empty-name" };
  }
  if (isStopwordOnlyName(name)) {
    return { ok: false, reason: "stopword-only" };
  }

  const successCount = options?.successCount ?? 0;
  if (successCount >= resolveProvenMinSuccess()) {
    return { ok: true, reason: "success-evidence" };
  }

  const overlap = goldenTokenOverlap(name, options?.extraGoldenTokens);
  const symbolic = isSymbolicSkillName(name);
  if (overlap.length === 0) {
    return {
      ok: false,
      reason: symbolic ? "no-golden-overlap" : "no-project-symbol-evidence",
    };
  }
  return {
    ok: true,
    reason: symbolic ? "symbolic-golden-overlap" : "golden-overlap",
  };
}

/** True when promoting this name to proven would inject library-degrading noise. */
export function wouldDegradeLibrary(skillName: string): boolean {
  return !admitSkillToProven(skillName).ok;
}
