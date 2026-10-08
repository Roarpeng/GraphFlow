import type { GraphEdge, GraphNode } from "../core/types";
import { ARCHITECTURE_QUERY } from "./context-slicer-types.js";
import { expandCjkGlossaryTerms, filterGenericPathTokens } from "./cjk-glossary.js";

const TOKEN_SPLIT = /[^a-zA-Z0-9_\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g;
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

const DEPRIORITIZED_PATH_PATTERNS = [
  /(?:^|\/)\.cursor\//i,
  /(?:^|\/)Cursor\//,
  /(?:^|\/)docs\/integrations\//i,
  /mcp\.json$/i,
  /package-lock\.json$/i,
];

const PRIORITIZED_PATH_PATTERNS = [
  /(?:^|\/)src\//,
  /(?:^|\/)tests\//,
];

/** Core implementation paths should beat packaging mirrors for architecture queries. */
const CORE_SOURCE_PATH_PATTERNS = [
  /(?:^|\/)src\/graph\//,
  /(?:^|\/)src\/core\//,
  /(?:^|\/)src\/surfaces\/mcp\//,
  /(?:^|\/)src\/learning\//,
  /(?:^|\/)src\/skills\//,
];

/** Hub paths that should dominate architecture / overview ranking. */
const ARCHITECTURE_HUB_PATH_PATTERNS = [
  /(?:^|\/)src\/core\/orchestrator/i,
  /(?:^|\/)src\/surfaces\/mcp\//i,
  /(?:^|\/)README(?:\.[^/]+)?$/i,
];

/** Leaf / peripheral paths to demote only for architecture overview queries. */
const ARCHITECTURE_PERIPHERAL_TYPES_PATTERN = /(?:^|\/)[^/]*types\.ts$/i;
const ARCHITECTURE_PERIPHERAL_ERROR_PATTERN = /(?:^|\/)[^/]*error[^/]*\.ts$/i;
const ARCHITECTURE_PANELS_PATH_PATTERN = /(?:^|\/)vscode-extension\/src\/panels\.ts$/i;

/** Soft-demote IDE/extension/docs and packaged dependency noise unless explicitly targeted. */
const VSCODE_EXTENSION_PATH_PATTERN = /(?:^|\/)vscode-extension\//;
const PACKAGING_NOISE_PATH_PATTERNS = [
  /(?:^|\/)vendor\//,
  /(?:^|\/)node_modules\//,
];
const BUILD_OUTPUT_PATH_PATTERN = /(?:^|\/)dist\//;
/** Installed host mirrors of the GraphFlow skill/rules (copies of src/surfaces/*). */
const AGENT_SKILL_PATH_PATTERN =
  /(?:^|\/)\.(?:agents?|trae|claude|codex|kiro|windsurf|gemini|qoder|codebuddy|cline|roo)\//;
const DOCS_PATH_PATTERN = /(?:^|\/)docs\//;
const PROSE_FILE_PATTERN = /\.(?:md|mdx|mdc|txt|rst)$/i;
const TEST_OR_BENCH_PATH_PATTERN =
  /(?:^|\/)(?:tests?|__tests__|benchmarks?|fixtures)\/|\.(?:test|spec|bench)\.[cm]?[jt]sx?$/i;
const TEST_INTENT_TOKENS = new Set([
  "test",
  "tests",
  "testing",
  "spec",
  "benchmark",
  "benchmarks",
  "bench",
  "fixture",
  "fixtures",
  "vitest",
  "jest",
  "测试",
  "基准",
]);
/** Query words that make prose (README, SKILL.md, rules) a legitimate answer. */
const DOC_INTENT_TOKENS = new Set([
  "readme",
  "doc",
  "docs",
  "documentation",
  "guide",
  "skill",
  "skills",
  "rule",
  "rules",
  "instruction",
  "instructions",
  "usage",
  "tutorial",
  "changelog",
  "workflow",
  "文档",
  "说明",
  "指南",
  "教程",
  "规则",
]);

const UI_PAGE_PATH_PATTERN = /(?:^|\/)src\/pages\//;
const UI_COMPONENT_PATH_PATTERN = /(?:^|\/)src\/components\//;
const DATA_LAYER_PATH_PATTERN = /(?:^|\/)src\/(?:data|types)\//;
const SLICES_PATH_PATTERN = /(?:^|\/)slices(?:\/|$)/i;

/** Tokens that suggest UI/page behavior rather than shared data types. */
const UI_INTERACTION_TOKENS = new Set([
  "avatar",
  "shield",
  "battle",
  "pose",
  "camera",
  "effect",
  "attack",
  "selection",
  "detection",
  "page",
  "modal",
  "button",
  "animation",
  "render",
]);

/** Tokens that indicate core-engine / architecture retrieval intent. */
const CORE_ENGINE_TOKENS = new Set([
  "orchestrator",
  "orchestration",
  "dag",
  "planner",
  "planning",
  "slicer",
  "context",
  "mcp",
  "architecture",
  "engine",
  "flywheel",
  "episodic",
  "indexer",
  "routing",
  "bridge",
  "compress",
  "compression",
  "anchor",
  "token",
  "skill",
  "graph",
  "client",
  "runtime",
]);

/** Tokens that indicate the caller explicitly wants vscode-extension / IDE UI. */
const EXTENSION_INTENT_TOKENS = new Set([
  "vscode",
  "extension",
  "webview",
  "statusbar",
  "sidebar",
  "panel",
]);

export function containsCJK(text: string): boolean {
  return CJK_RE.test(text);
}

/** Extract CJK phrases (2+ chars) and overlapping bigrams for partial matching. */
export function tokenizeCJK(text: string): string[] {
  const phrases = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]{2,}/g) ?? [];
  const out = new Set<string>();
  for (const phrase of phrases) {
    out.add(phrase);
    for (let i = 0; i < phrase.length - 1; i += 1) {
      out.add(phrase.slice(i, i + 2));
    }
  }
  return [...out];
}

/** Split camelCase, PascalCase, and snake_case identifiers into searchable tokens. */
export function splitIdentifierTokens(part: string): string[] {
  if (!part) return [];
  const out = new Set<string>();
  const lower = part.toLowerCase();
  if (lower.length >= 2) out.add(lower);

  const spaced = part.replace(/([a-z0-9])([A-Z])/g, "$1 $2");

  for (const piece of spaced.split(/[^a-zA-Z0-9]+/).filter(Boolean)) {
    const token = piece.toLowerCase();
    if (token.length >= 2) out.add(token);
  }

  return [...out];
}

const CJK_SPLIT = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g;

export function tokenizeForIndex(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();

  for (const part of text.split(TOKEN_SPLIT)) {
    if (!part) continue;
    if (!CJK_RE.test(part)) {
      for (const token of splitIdentifierTokens(part)) {
        out.add(token);
      }
      continue;
    }
    // Mixed CJK+Latin span with no whitespace between (identifier glued to
    // Chinese with no separator): Latin runs are identifiers - harvest them
    // the whole span. Previously any English glued to Chinese vanished from
    // both the query and the index, so mixed-language queries could only ever
    // match via CJK bigrams. CJK phrases for the span still come from
    // tokenizeCJK below; single Latin chars ("A") stay dropped by the
    // length>=2 rule inside splitIdentifierTokens.
    for (const run of part.split(CJK_SPLIT)) {
      if (!run) continue;
      for (const token of splitIdentifierTokens(run)) {
        out.add(token);
      }
    }
  }

  for (const t of tokenizeCJK(text)) {
    out.add(t);
  }

  return [...out];
}

/**
 * Merge original query with optional agent-translated English for matching / intent detection.
 * Keeps both sides so CJK overview wording and englishQuery hubs are visible together.
 */
export function composeContextQuery(query: string, englishQuery?: string): string {
  const q = query.trim();
  const en = englishQuery?.trim();
  if (!q) return en ?? "";
  if (!en) return q;
  const qLower = q.toLowerCase();
  const enLower = en.toLowerCase();
  if (qLower === enLower || qLower.includes(enLower) || enLower.includes(qLower)) {
    return q.length >= en.length ? q : en;
  }
  return `${q} ${en}`;
}

/** Tokens used for re-ranking: original query + agent English + active sub-query. */
export function buildSearchScoreTokens(
  query: string,
  englishQuery?: string,
  subQuery?: string
): string[] {
  const out = new Set<string>();
  for (const text of [query, englishQuery, subQuery]) {
    if (!text?.trim()) continue;
    for (const token of tokenizeForIndex(text)) {
      out.add(token);
    }
  }
  return [...out];
}

/** Derive English-ish tokens from workspace path segments (e.g. fat-battle → battle). */
export function extractPathTokens(workspaceRoot?: string): string[] {
  if (!workspaceRoot?.trim()) return [];
  const out = new Set<string>();
  const normalized = workspaceRoot.replace(/\\/g, "/");

  for (const segment of normalized.split("/")) {
    if (!segment || segment === "." || segment === "..") continue;
    for (const tok of tokenizeForIndex(segment)) {
      out.add(tok);
    }
    const camelParts = segment
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^a-zA-Z0-9]+/);
    for (const part of camelParts) {
      const lower = part.toLowerCase();
      if (lower.length >= 2) out.add(lower);
    }
  }

  return [...out];
}

/**
 * Build search queries for RRF: original query, optional agent-translated English,
 * deterministic CJK glossary expansion, plus path-derived hints when CJK is present.
 *
 * Path-hint queries carry PATH_HINT_QUERY_WEIGHT (< 1): directory names are weak
 * evidence - often generic dev-machine segments - and RRF-fused at equal weight
 * they bury the true ranking (workspace junk outranked the true config
 * module). Down-weighted they break ties instead of dominating.
 */
export const PATH_HINT_QUERY_WEIGHT = 0.25;

export interface ExpandedSearchQuery {
  query: string;
  weight: number;
}

export function expandSearchQueriesWeighted(
  query: string,
  workspaceRoot?: string,
  englishQuery?: string
): ExpandedSearchQuery[] {
  const trimmed = query.trim();
  if (!trimmed && !englishQuery?.trim()) return [];

  const out: ExpandedSearchQuery[] = [];
  const seen = new Set<string>();
  const push = (text: string, weight: number): void => {
    if (seen.has(text)) return;
    seen.add(text);
    out.push({ query: text, weight });
  };
  if (trimmed) push(trimmed, 1);

  const en = englishQuery?.trim();
  if (en) {
    push(en, 1);
    for (const token of tokenizeForIndex(en)) {
      if (token.length >= 2 && !containsCJK(token)) {
        push(token, 1);
      }
    }
  }

  if (containsCJK(trimmed)) {
    // Zero-LLM first aid before agent translation: curated Chinese domain
    // terms map straight to English code terms.
    const glossaryTerms = expandCjkGlossaryTerms(trimmed);
    if (glossaryTerms.length > 0) {
      push(glossaryTerms.join(" "), 1);
      for (const term of glossaryTerms) {
        push(term, 1);
      }
    }
    const pathTokens = filterGenericPathTokens(extractPathTokens(workspaceRoot));
    if (pathTokens.length > 0) {
      push(pathTokens.join(" "), PATH_HINT_QUERY_WEIGHT);
      for (const token of pathTokens.slice(0, 8)) {
        push(token, PATH_HINT_QUERY_WEIGHT);
      }
    }
  }

  return out;
}

export function expandSearchQueries(
  query: string,
  workspaceRoot?: string,
  englishQuery?: string
): string[] {
  return expandSearchQueriesWeighted(query, workspaceRoot, englishQuery).map(
    (entry) => entry.query
  );
}

/** All text used for inverted-index lookup (content, jsdoc, paths, symbol names). */
export function nodeSearchableText(node: GraphNode): string {
  const parts: string[] = [node.content];
  const meta = node.metadata;

  if (meta) {
    if (typeof meta.jsdoc === "string") parts.push(meta.jsdoc);
    if (typeof meta.sourcePath === "string") parts.push(meta.sourcePath);
    if (typeof meta.path === "string") parts.push(meta.path);
    if (typeof meta.file === "string") parts.push(meta.file);
    if (typeof meta.name === "string") parts.push(meta.name);
    if (Array.isArray(meta.exports)) {
      parts.push(meta.exports.filter((e): e is string => typeof e === "string").join(" "));
    }
  }

  if (node.id.startsWith("file:")) {
    parts.push(node.id.slice("file:".length));
  } else if (node.id.startsWith("module:")) {
    parts.push(node.id.slice("module:".length));
  } else if (node.id.startsWith("symbol:")) {
    parts.push(node.id.slice("symbol:".length));
  }

  return parts.join(" ");
}

/** Distinct identifier terms harvested from a File node's body (see `extractBodyTerms`). */
export function nodeBodyTerms(node: GraphNode): string {
  const terms = node.metadata?.bodyTerms;
  return typeof terms === "string" ? terms : "";
}

/**
 * Text fed to keyword recall indexes: searchable text plus File body terms, so a
 * query naming an identifier used only inside a function body can still recall
 * its file. Ranking keeps body terms in a separate field (no length penalty).
 */
export function nodeRecallText(node: GraphNode): string {
  const body = nodeBodyTerms(node);
  const base = nodeSearchableText(node);
  return body ? `${base} ${body}` : base;
}

const BODY_TERM_MAX = 500;
const BODY_CJK_TERM_MAX = 120;

/** Distinct lowercase identifier tokens (plus CJK comment terms) from a source body, capped for index size. */
export function extractBodyTerms(content: string): string {
  if (!content) return "";
  const out: string[] = [];
  let latin = 0;
  let cjk = 0;
  for (const token of tokenizeForIndex(content)) {
    if (CJK_RE.test(token)) {
      if (cjk >= BODY_CJK_TERM_MAX) continue;
      cjk += 1;
    } else {
      if (latin >= BODY_TERM_MAX || token.length < 3 || /^\d+$/.test(token)) continue;
      latin += 1;
    }
    out.push(token);
  }
  return out.join(" ");
}

export function dedupEdgesByKey(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const result: GraphEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}|${edge.relation}|${edge.to}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(edge);
    }
  }
  return result;
}

/**
 * Does the query name something that actually exists in the graph?
 *
 * `extractSymbolCandidates` is a text heuristic: it only recognises camelCase
 * identifiers, file paths and call syntax, so a query naming a plain lowercase
 * symbol (`tokenize`, `parse_frontmatter`) reads as having no concrete ref at
 * all — the exact opposite of the truth, and it silently blocks the case where
 * delegation is most obviously right. Matching against the graph is evidence
 * rather than a pattern, and it cannot invent a ref that is not there.
 */
export function queryNamesGraphNode(
  query: string,
  nodes: readonly GraphNode[]
): boolean {
  const haystack = query.trim();
  if (haystack.length === 0) return false;
  for (const node of nodes) {
    const name = typeof node.metadata?.name === "string" ? node.metadata.name.trim() : "";
    if (name.length >= 3 && haystack.includes(name)) return true;
    const path = extractNodeSourcePath(node);
    // Only trust a path that is really a path (see abstention-floor.ts: the
    // extractor degrades to the node's first word when metadata is absent).
    if (path.length >= 4 && !/\s/.test(path) && haystack.includes(path)) return true;
  }
  return false;
}

export function extractNodeSourcePath(node: GraphNode): string {
  const fromMeta = node.metadata?.sourcePath;
  if (typeof fromMeta === "string" && fromMeta.trim()) {
    return fromMeta.trim();
  }

  if (node.id.startsWith("file:")) {
    return node.id.slice("file:".length);
  }

  if (node.id.startsWith("symbol:")) {
    const body = node.id.slice("symbol:".length);
    const hashIndex = body.lastIndexOf(":");
    if (hashIndex > 0 && /^[a-z0-9]+$/i.test(body.slice(hashIndex + 1))) {
      return body.slice(0, hashIndex);
    }
  }

  if (node.id.startsWith("module:")) {
    return node.id.slice("module:".length);
  }

  return node.content.split(/\s+/)[0] ?? "";
}

function queryMatchesNode(node: GraphNode, queries: string[]): boolean {
  const searchable = nodeSearchableText(node).toLowerCase();
  for (const query of queries) {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery && searchable.includes(normalizedQuery)) {
      return true;
    }

    for (const phrase of tokenizeCJK(query)) {
      if (phrase.length >= 2 && searchable.includes(phrase)) {
        return true;
      }
    }
  }

  return false;
}

export interface RankNodesOptions {
  scoreTokens?: Iterable<string>;
  matchQueries?: string[];
  /** Optional workspace path segments used as retrieval hints (e.g. from extractPathTokens). */
  pathHints?: Iterable<string>;
  /** Agent-translated English terms; composed with query for architecture intent detection. */
  englishQuery?: string;
}

function hasArchitectureIntent(query: string, englishQuery?: string, matchQueries?: string[]): boolean {
  if (ARCHITECTURE_QUERY.test(composeContextQuery(query, englishQuery))) {
    return true;
  }
  return (matchQueries ?? []).some((q) => ARCHITECTURE_QUERY.test(q));
}

/** Extra boost for orchestrator / MCP / README hubs on architecture overview queries. */
function architectureHubBoost(path: string): number {
  if (ARCHITECTURE_HUB_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
    return 16;
  }
  return 0;
}

/**
 * Soft-demote peripheral types/errors/panels for architecture queries only.
 * Normal code search (non-architecture) is unaffected.
 */
function architecturePeripheralPenalty(path: string): number {
  if (ARCHITECTURE_PANELS_PATH_PATTERN.test(path)) {
    return -18;
  }
  if (ARCHITECTURE_PERIPHERAL_TYPES_PATTERN.test(path)) {
    return -10;
  }
  if (ARCHITECTURE_PERIPHERAL_ERROR_PATTERN.test(path)) {
    return -10;
  }
  return 0;
}

function hasCoreEngineIntent(tokens: Set<string>): boolean {
  return [...tokens].some((token) => CORE_ENGINE_TOKENS.has(token));
}

function hasExtensionIntent(tokens: Set<string>, query: string, pathHints: Set<string>): boolean {
  if (/vscode-extension/i.test(query)) {
    return true;
  }
  if ([...pathHints].some((hint) => /vscode-extension/i.test(hint))) {
    return true;
  }
  return [...tokens].some((token) => EXTENSION_INTENT_TOKENS.has(token));
}

/**
 * Soft-demote vscode-extension / .agent / docs paths for core-engine queries.
 * Never hard-excludes — extension hits can still surface when they are the only match
 * or when the query explicitly targets the extension.
 */
function extensionNoisePenalty(
  path: string,
  coreIntent: boolean,
  extensionIntent: boolean
): number {
  if (extensionIntent) {
    if (VSCODE_EXTENSION_PATH_PATTERN.test(path)) {
      return 8;
    }
    return 0;
  }

  if (VSCODE_EXTENSION_PATH_PATTERN.test(path)) {
    // Strong demotion for core/architecture queries; mild demotion otherwise.
    return coreIntent ? -20 : -10;
  }
  if (AGENT_SKILL_PATH_PATTERN.test(path)) {
    return coreIntent ? -14 : -6;
  }
  if (coreIntent && DOCS_PATH_PATTERN.test(path)) {
    return -8;
  }
  return 0;
}

function packagingNoisePenalty(path: string, coreIntent: boolean): number {
  if (PACKAGING_NOISE_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
    return coreIntent ? -28 : -16;
  }
  if (BUILD_OUTPUT_PATH_PATTERN.test(path) && !/(?:^|\/)src\//.test(path)) {
    return coreIntent ? -22 : -10;
  }
  return 0;
}

/**
 * IDF over the candidate set, normalized so the average query term keeps its
 * old weight of 1. Keyword recall returns every node matching ANY query term,
 * so candidate document frequency tracks corpus frequency: "file"/"graph"/
 * "json" appear in thousands of nodes and must not count as much as "sqlite"
 * or "fold". Without this, broad documents (README headings) that mention
 * many common words outranked the one file that matched the rare ones.
 */
const BM25_K1 = 1.2;
const BM25_B = 0.5;
const BODY_TERM_WEIGHT = 1;
/**
 * Distinct-term coverage weight (T2): a node matching several different query
 * terms is stronger evidence than one matching a single rare term — without
 * it a one-token sense collision outranks the true multi-term owner.
 * Additive only, gated on
 * >= 3 distinct terms, so single-term queries score exactly as before.
 */
const COVERAGE_DISTINCT_WEIGHT = 1.5;

function buildQueryTermWeights(
  nodeTokens: readonly string[][],
  nodePaths: readonly string[],
  queryTokens: ReadonlySet<string>,
  queryStems: ReadonlySet<string>,
  stemLen: number
): { exact: Map<string, number>; stem: Map<string, number> } {
  // Document = source file, not node: every symbol node repeats its file
  // path, so per-node counting made a file's own name look common in
  // proportion to how many symbols the file has.
  const exactDocs = new Map<string, Set<string>>();
  const stemDocs = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, term: string, doc: string): void => {
    const docs = map.get(term);
    if (docs) docs.add(doc);
    else map.set(term, new Set([doc]));
  };
  nodeTokens.forEach((tokens, index) => {
    const doc = nodePaths[index] || `#${index}`;
    for (const token of tokens) {
      if (queryTokens.has(token)) {
        add(exactDocs, token, doc);
      }
      if (queryStems.size > 0 && token.length >= stemLen) {
        const stem = token.slice(0, stemLen);
        if (queryStems.has(stem)) add(stemDocs, stem, doc);
      }
    }
  });
  const exactDf = new Map([...exactDocs].map(([term, docs]) => [term, docs.size] as const));
  const stemDf = new Map([...stemDocs].map(([term, docs]) => [term, docs.size] as const));
  const total = new Set(nodePaths.map((path, index) => path || `#${index}`)).size;
  const idf = (df: number): number => Math.log(1 + (total - df + 0.5) / (df + 0.5));
  const normalize = (dfs: Map<string, number>): Map<string, number> => {
    const raw = new Map<string, number>();
    for (const [term, df] of dfs) raw.set(term, idf(df));
    const values = [...raw.values()];
    const mean = values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
    const out = new Map<string, number>();
    for (const [term, value] of raw) {
      out.set(term, mean > 0 ? Math.min(3, Math.max(0.25, value / mean)) : 1);
    }
    return out;
  };
  return { exact: normalize(exactDf), stem: normalize(stemDf) };
}

/**
 * File-name / directory field match, deliberately independent of IDF: a query
 * term that names the file ("worker" -> agents/worker.ts, "env" ->
 * cli/runtime/env.ts) is strong evidence even when the same word is common in
 * bodies elsewhere. Docs are excluded so README-style files do not gain from
 * generic names.
 */
function splitPathFields(path: string): { baseTokens: Set<string>; dirTokens: Set<string> } | undefined {
  if (!path || /\.(?:md|mdx|txt|rst)$/i.test(path)) {
    return undefined;
  }
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = (segments.pop() ?? "").replace(/\.[^.]+$/, "");
  return {
    baseTokens: new Set(tokenizeForIndex(base.replace(/[-_.]/g, " "))),
    dirTokens: new Set(
      segments.slice(-2).flatMap((segment) => tokenizeForIndex(segment.replace(/[-_.]/g, " ")))
    ),
  };
}

/** How many distinct candidate files carry each query token in their file name. */
function buildBaseNameDf(nodePaths: readonly string[], queryTokens: ReadonlySet<string>): Map<string, number> {
  const df = new Map<string, number>();
  for (const path of new Set(nodePaths)) {
    const fields = splitPathFields(path);
    if (!fields) continue;
    for (const token of fields.baseTokens) {
      if (queryTokens.has(token)) df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  return df;
}

function pathFieldBonus(
  path: string,
  queryTokens: ReadonlySet<string>,
  baseNameDf: ReadonlyMap<string, number>
): number {
  const fields = splitPathFields(path);
  if (!fields) {
    return 0;
  }
  const { baseTokens, dirTokens } = fields;
  let bonus = 0;
  let baseMatched = 0;
  for (const token of baseTokens) {
    if (queryTokens.has(token)) {
      baseMatched += 1;
      bonus += 5 * Math.min(1, Math.max(0.3, 3 / (baseNameDf.get(token) ?? 1)));
    }
  }
  if (baseMatched > 0 && baseMatched === baseTokens.size) {
    bonus += 4;
  }
  for (const token of dirTokens) {
    if (queryTokens.has(token) && !baseTokens.has(token)) {
      bonus += 1.5;
    }
  }
  return bonus;
}

/**
 * Re-rank keyword hits so integration/config/packaging noise does not dominate
 * architecture queries.
 */
export function rankNodesForContextQuery(
  nodes: GraphNode[],
  query: string,
  options?: RankNodesOptions
): GraphNode[] {
  const queryTokens = new Set(options?.scoreTokens ?? tokenizeForIndex(query));
  // Prefix-stem matching: exact token matching misses morphological variants
  // ("orchestrate" query vs "orchestration"/"orchestrator" in code). Stems of
  // >= 6 chars are conservative enough to avoid false positives ("task" never
  // stems) while catching common verb/noun/derived forms. Stem hits score half
  // of an exact hit.
  const STEM_LEN = 6;
  const queryStems = new Set<string>();
  for (const token of queryTokens) {
    if (token.length >= STEM_LEN) {
      queryStems.add(token.slice(0, STEM_LEN));
    }
  }
  const matchQueries = options?.matchQueries ?? [query];
  const pathHints = new Set(
    [...(options?.pathHints ?? [])].map((hint) => hint.toLowerCase()).filter(Boolean)
  );
  const uiIntent = [...queryTokens].some((token) => UI_INTERACTION_TOKENS.has(token));
  const architectureIntent = hasArchitectureIntent(query, options?.englishQuery, matchQueries);
  const coreIntent = hasCoreEngineIntent(queryTokens) || architectureIntent;
  const extensionIntent = hasExtensionIntent(queryTokens, query, pathHints);
  const sliceIntent =
    queryTokens.has("slice") ||
    queryTokens.has("slices") ||
    matchQueries.some((q) => /\bslices?\b/i.test(q));
  const intentTokens = new Set([...queryTokens, ...matchQueries.flatMap((q) => tokenizeForIndex(q))]);
  const docIntent = [...intentTokens].some((token) => DOC_INTENT_TOKENS.has(token));
  const testIntent = [...intentTokens].some((token) => TEST_INTENT_TOKENS.has(token));

  const nodeTokens = nodes.map((node) => tokenizeForIndex(nodeSearchableText(node)));
  const nodeBodyTermSets = nodes.map((node) => {
    const body = nodeBodyTerms(node);
    return body ? new Set(body.split(" ")) : undefined;
  });
  const nodePaths = nodes.map((node) => extractNodeSourcePath(node));
  const termWeight = buildQueryTermWeights(nodeTokens, nodePaths, queryTokens, queryStems, STEM_LEN);
  const baseNameDf = buildBaseNameDf(nodePaths, queryTokens);
  const avgNodeLength = Math.max(
    1,
    nodeTokens.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, nodeTokens.length)
  );

  const scored = nodes.map((node, nodeIndex) => {
    let score = 0;
    const path = extractNodeSourcePath(node);
    let tokenHits = 0;

    // BM25-style saturation + length normalization: a single occurrence scores
    // as before, but a long jsdoc repeating "graph" ten times no longer beats
    // a short symbol that matches several distinct query terms.
    const tokens = nodeTokens[nodeIndex]!;
    const exactTf = new Map<string, number>();
    const stemTf = new Map<string, number>();
    for (const token of tokens) {
      if (queryTokens.has(token)) {
        exactTf.set(token, (exactTf.get(token) ?? 0) + 1);
      } else if (queryStems.size > 0 && token.length >= STEM_LEN && queryStems.has(token.slice(0, STEM_LEN))) {
        const stem = token.slice(0, STEM_LEN);
        stemTf.set(stem, (stemTf.get(stem) ?? 0) + 1);
      }
    }
    const lengthNorm = 1 - BM25_B + BM25_B * (tokens.length / avgNodeLength);
    const saturate = (tf: number): number => (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lengthNorm);
    for (const [token, tf] of exactTf) {
      const weight = termWeight.exact.get(token) ?? 1;
      score += 2 * weight * saturate(tf);
      tokenHits += weight;
    }
    for (const [stem, tf] of stemTf) {
      const weight = termWeight.stem.get(stem) ?? 1;
      score += weight * saturate(tf);
      tokenHits += 0.5 * weight;
    }
    const bodyTerms = nodeBodyTermSets[nodeIndex];
    if (bodyTerms) {
      for (const token of queryTokens) {
        if (exactTf.has(token) || !bodyTerms.has(token)) continue;
        const weight = termWeight.exact.get(token) ?? 1;
        score += BODY_TERM_WEIGHT * weight;
        tokenHits += 0.5 * weight;
      }
    }

    if (tokenHits >= 2) {
      score += tokenHits;
    }

    const distinctTerms = exactTf.size + stemTf.size * 0.5;
    if (distinctTerms >= 3) {
      score += distinctTerms * COVERAGE_DISTINCT_WEIGHT;
    }

    score += pathFieldBonus(path, queryTokens, baseNameDf);

    if (queryMatchesNode(node, matchQueries)) {
      score += 6;
    }

    if (PRIORITIZED_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
      score += 8;
    }
    if (coreIntent && CORE_SOURCE_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
      score += 12;
    }
    if (architectureIntent) {
      score += architectureHubBoost(path);
      score += architecturePeripheralPenalty(path);
    }
    if (sliceIntent && SLICES_PATH_PATTERN.test(path)) {
      score += 10;
    }
    score += extensionNoisePenalty(path, coreIntent, extensionIntent);
    score += packagingNoisePenalty(path, coreIntent);
    if (uiIntent) {
      if (UI_PAGE_PATH_PATTERN.test(path)) {
        score += 12;
      } else if (UI_COMPONENT_PATH_PATTERN.test(path)) {
        score += 10;
      } else if (DATA_LAYER_PATH_PATTERN.test(path)) {
        score -= 6;
      }
    }
    if (DEPRIORITIZED_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
      score -= 12;
    }
    if (!docIntent && PROSE_FILE_PATTERN.test(path)) {
      score -= 6;
    }
    if (!testIntent && TEST_OR_BENCH_PATH_PATTERN.test(path)) {
      score -= 8;
    }
    if (node.type === "Symbol") {
      score += 3;
    } else if (node.type === "File") {
      score += 1;
    }

    return { node, score };
  });

  scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  return scored.map((entry) => entry.node);
}
