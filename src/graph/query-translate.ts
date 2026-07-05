import type { AgentWorkItem } from "../core/agent-delegation.js";
import { containsCJK, extractPathTokens } from "./graph-utils.js";

/** Minimum anchors before we skip agent translation delegation. */
export const QUERY_TRANSLATE_HIT_THRESHOLD = 3;

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

export function shouldDelegateQueryTranslation(
  query: string,
  anchorCount: number,
  englishQuery?: string
): boolean {
  if (englishQuery?.trim()) {
    return false;
  }
  if (!containsCJK(query)) {
    return false;
  }
  return anchorCount < QUERY_TRANSLATE_HIT_THRESHOLD;
}
