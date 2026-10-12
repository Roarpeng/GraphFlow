import type { AgentWorkItem } from "../core/agent-delegation.js";
import { containsCJK, extractPathTokens } from "./graph-utils.js";
import type { ContextAnchorItem } from "./context-slicer-types.js";
import type { GraphFlowConfig } from "../config/schema.js";
import { hasUsableLlmProvider } from "../config/llm-availability.js";
import { resolveCompressorSelection } from "../routing/model-router.js";
import { executeRolePrompt } from "../routing/provider-executor.js";

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

/**
 * Translation instructions shared by BOTH execution paths — the bridge work
 * item answered by the HOST agent (`buildQueryTranslateWorkItem`) and the
 * local auto-translate LLM call (`autoTranslateQuery`) — so the translation
 * guidance and the JSON contract can never drift apart.
 */
function queryTranslatePromptLines(query: string, workspaceRoot?: string): string[] {
  const pathHints = extractPathTokens(workspaceRoot);
  const pathLine =
    pathHints.length > 0
      ? `Project path hints (use if relevant): ${pathHints.slice(0, 12).join(", ")}`
      : "";

  return [
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
    "{",
    '  "englishQuery": "space separated english keywords for graph search",',
    '  "keywords": ["term1", "term2", "term3"]',
    "}",
  ].filter(Boolean);
}

export function buildQueryTranslateWorkItem(query: string, workspaceRoot?: string): AgentWorkItem {
  return {
    id: "query-translate-en",
    kind: "query-translate",
    prompt: [
      ...queryTranslatePromptLines(query, workspaceRoot),
      "Then call graphflow_preview_context again with the SAME query plus englishQuery:",
      `graphflow_preview_context({ query: ${JSON.stringify(query)}, englishQuery: "<your englishQuery>" })`,
    ].join("\n"),
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

// ─────────────── Auto-retry translation (local economy-tier LLM) ───────────────

/** Default wall-clock budget for the auto-translation utility call. */
export const QUERY_TRANSLATE_TIMEOUT_MS = 15_000;

/** Defensive cap: a rogue reply must not flood the context build with text. */
const MAX_TRANSLATED_QUERY_CHARS = 500;

export interface QueryTranslateResult {
  englishQuery: string;
  keywords: string[];
}

/**
 * Transparency field riding on the graphflow_context tool result so hosts can
 * see what the auto-retry loop did: the executed economy-tier translation, or
 * a machine-readable reason it was skipped.
 */
export type QueryTranslationStatus =
  | { englishQuery: string; keywords: string[]; tier: "economy" }
  | { skipped: string };

/**
 * Defensively parse a query-translation reply into `{ englishQuery, keywords }`.
 * Accepts bare JSON, fenced markdown JSON (```json … ```), and a JSON object
 * surrounded by prose. Returns null when no usable englishQuery surfaces.
 */
export function parseQueryTranslateReply(raw: string): QueryTranslateResult | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }

  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]?.trim()) {
    candidates.push(fenced[1]);
  }
  candidates.push(text);
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    candidates.push(text.slice(braceStart, braceEnd + 1));
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const source = parsed as { englishQuery?: unknown; keywords?: unknown };
    const englishQuery =
      typeof source.englishQuery === "string" ? source.englishQuery.trim() : "";
    if (!englishQuery) {
      continue;
    }
    const keywords = (Array.isArray(source.keywords) ? source.keywords : [])
      .filter((term): term is string => typeof term === "string")
      .map((term) => term.trim())
      .filter((term) => term.length > 0);
    return {
      englishQuery:
        englishQuery.length > MAX_TRANSLATED_QUERY_CHARS
          ? englishQuery.slice(0, MAX_TRANSLATED_QUERY_CHARS)
          : englishQuery,
      keywords:
        keywords.length > 0
          ? keywords
          : englishQuery.split(/\s+/).filter((term) => term.length > 0),
    };
  }
  return null;
}

/**
 * Translate a CJK query locally via GraphFlow's own LLM provider — the
 * auto-retry half of the query-translate loop. Builds the SAME prompt the
 * bridge work item uses (see `queryTranslatePromptLines`), executes it on the
 * economy-tier (cheap-utility) model — never the smart tier — and parses the
 * JSON reply defensively.
 *
 * Resolves to null on ANY failure (no usable provider, timeout, provider
 * error, unparseable reply, empty englishQuery). Never throws; the caller
 * falls back to bridging the `query-translate-en` work item to the host.
 */
export async function autoTranslateQuery(
  task: string,
  options: { config: GraphFlowConfig; timeoutMs?: number; configPath?: string }
): Promise<QueryTranslateResult | null> {
  try {
    const query = task.trim();
    if (!query || !options?.config) {
      return null;
    }
    if (!hasUsableLlmProvider(options.config)) {
      return null;
    }

    // Economy tier only — this is a cheap utility call and must never occupy
    // the smart tier. resolveCompressorSelection is the config-object-based
    // resolver for the configured cheap-utility (compression/economy) model;
    // it never reads tiers.smart.
    const selection = resolveCompressorSelection(options.config);

    const prompt = [
      ...queryTranslatePromptLines(query, options.config.graphPolicy.workspaceRoot),
      // Direct-call trailer replacing the bridge item's host round-trip lines.
      "Respond with ONLY the JSON object itself — no explanation, no markdown fences.",
    ].join("\n");

    const timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : QUERY_TRANSLATE_TIMEOUT_MS;
    const controller = new AbortController();
    let raceTimer: ReturnType<typeof setTimeout> | undefined;
    // Belt-and-braces: executeRolePrompt honors the abort signal and carries
    // its own per-attempt timeout, but the retry budget (with backoff) can
    // outlive the outer budget — the race latch enforces it as a hard cap.
    const timeoutLatch = new Promise<null>((resolve) => {
      raceTimer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
      raceTimer.unref?.();
    });

    let raw: string | null = null;
    try {
      raw = await Promise.race([
        executeRolePrompt("planner", prompt, selection, undefined, controller.signal, {
          disableTools: true,
          ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
        }),
        timeoutLatch,
      ]);
    } finally {
      clearTimeout(raceTimer);
    }
    if (typeof raw !== "string") {
      return null;
    }
    return parseQueryTranslateReply(raw);
  } catch {
    return null; // never throws
  }
}
