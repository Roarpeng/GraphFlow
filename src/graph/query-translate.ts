import type { AgentWorkItem } from "../core/agent-delegation.js";
import { containsCJK, extractPathTokens } from "./graph-utils.js";
import type { ContextAnchorItem } from "./context-slicer-types.js";

/** Minimum anchors before we skip agent translation delegation. */
export const QUERY_TRANSLATE_HIT_THRESHOLD = 3;

/**
 * Size of the strongest-scored anchor set inspected by the low-relevance
 * check. Channel position cannot be used: injected Module/File anchors
 * (config file, module groupings) routinely sit ahead of the retrieval-ranked
 * Symbol anchors while sharing no query wording, so the mean is taken over
 * the K HIGHEST relevance values across the channel, not the first K slots.
 */
export const QUERY_TRANSLATE_RELEVANCE_TOP_K = 5;

/**
 * Cap on anchors DELIVERED when the low-relevance dimension fires: the
 * response keeps only relevance > 0 anchors, at most this many, so a garbage
 * retrieval cannot flood the caller's context with unrelated pointers.
 */
export const QUERY_TRANSLATE_RELEVANCE_TOP_K_DELIVERED = 5;

/**
 * Mean top-K relevance below which translation is delegated even when
 * anchorCount >= QUERY_TRANSLATE_HIT_THRESHOLD. `computeAnchorRelevance` is
 * a share of matched query tokens, and CJK tokenization is dense (overlapping
 * bigrams): a node that genuinely answers a pure-Chinese question matches
 * most of them (>= 0.5 in practice, e.g. a jsdoc containing the queried
 * phrase), while anchors reached only via workspace-path expansion match
 * none and sit at ~0. 0.25 keeps the bar at "at least a quarter of the query
 * is literally present in the anchor text" — low enough that one missing
 * term never fires it, high enough that a fully unrelated anchor head does.
 */
export const QUERY_TRANSLATE_LOW_RELEVANCE_THRESHOLD = 0.25;

export function buildQueryTranslateWorkItem(query: string, workspaceRoot?: string): AgentWorkItem {
  const pathHints = extractPathTokens(workspaceRoot);
  const pathLine =
    pathHints.length > 0
      ? `Project path hints (use if relevant): ${pathHints.slice(0, 12).join(", ")}`
      : "";

  return {
    id: "query-translate-en",
    kind: "query-translate",
    prompt: [
      "GraphFlow could not match enough code symbols from a Chinese/CJK search query.",
      `Original query: ${query}`,
      pathLine,
      "",
      "Using YOUR model, translate the user's intent into English CODE SEARCH terms.",
      "Prefer exact file/class/function/component names (e.g. PoseDetectionPage, BattlePage, shieldEffect).",
      "Avoid generic ambiguous words (e.g. use pose/camera/avatar for UI questions, not exercise when the codebase has fitness data modules).",
      "Include Page/Component/Service file stems when the question is about UI behavior or effects.",
      "",
      "Return ONLY a JSON object (no markdown fences):",
      '{',
      '  "englishQuery": "space separated english keywords for graph search",',
      '  "keywords": ["term1", "term2", "term3"]',
      "}",
      "",
      "Then call graphflow_preview_context again with the SAME query plus englishQuery:",
      `graphflow_preview_context({ query: ${JSON.stringify(query)}, englishQuery: "<your englishQuery>" })`,
    ]
      .filter(Boolean)
      .join("\n"),
    expectedFormat: "json",
    responseSchema: {
      englishQuery: "string — space-separated English search terms",
      keywords: "string[] — individual English terms",
    },
  };
}

export function buildQueryTranslateInstructions(query: string): string {
  return [
    "[GraphFlow CJK] Low symbol match for Chinese query.",
    "Answer agentWorkItems id=query-translate-en with JSON { englishQuery, keywords },",
    "then retry graphflow_preview_context with englishQuery (keep original query for traceability).",
    `Original query: ${query}`,
  ].join(" ");
}

/**
 * Mean relevance of the K strongest-scored anchors. Channel order is not
 * retrieval rank (injected Module/File anchors sit first and rarely share
 * query wording), so the mean must be taken over the highest scores, not the
 * channel head. Returns `undefined` when no anchor carries a relevance score
 * — the caller then falls back to the legacy anchor-count rule instead of
 * guessing.
 */
export function anchorRelevanceQuality(
  anchors: ReadonlyArray<ContextAnchorItem>
): number | undefined {
  const scored: number[] = [];
  for (const anchor of anchors) {
    const relevance = anchor.relevance;
    if (typeof relevance === "number" && Number.isFinite(relevance)) {
      scored.push(relevance);
    }
  }
  if (scored.length === 0) {
    return undefined;
  }
  scored.sort((a, b) => b - a);
  const k = Math.min(QUERY_TRANSLATE_RELEVANCE_TOP_K, scored.length);
  let sum = 0;
  for (let i = 0; i < k; i += 1) {
    sum += scored[i]!;
  }
  return sum / k;
}

export function shouldDelegateQueryTranslation(
  query: string,
  anchorCount: number,
  englishQuery?: string,
  anchors?: ReadonlyArray<ContextAnchorItem>
): boolean {
  if (englishQuery?.trim()) {
    return false;
  }
  if (!containsCJK(query)) {
    return false;
  }
  if (anchorCount < QUERY_TRANSLATE_HIT_THRESHOLD) {
    return true;
  }
  // Low-relevance escape hatch: the anchor count cleared the threshold, but
  // the anchor head shares (almost) no wording with the query — typically a
  // pure-CJK query whose hits only came from workspace-path expansion.
  // Anchor count alone would keep promising translation forever; delegate
  // so the agent can supply real English search terms.
  const quality = anchors ? anchorRelevanceQuality(anchors) : undefined;
  return quality !== undefined && quality < QUERY_TRANSLATE_LOW_RELEVANCE_THRESHOLD;
}
