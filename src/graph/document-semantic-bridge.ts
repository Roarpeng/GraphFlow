/**
 * Bridge work items for document semantic extraction after structural indexing.
 * Structure (headings/chunks/links) comes from Markdown conversion; deep
 * semantics are delegated to the host agent via ATP/bridge.
 */

import type { AgentWorkItem } from "../core/agent-delegation.js";

export interface DocumentSemanticTarget {
  relPath: string;
  /** Short structural summary (title / top headings). */
  outline: string;
  /** Truncated markdown body for the agent prompt. */
  excerpt: string;
}

/**
 * Build optional bridge work items so the host agent extracts entities,
 * claims, and a concise semantic summary, then submits via graphflow_insight.
 */
export function buildDocumentSemanticWorkItems(
  docs: DocumentSemanticTarget[],
  options?: { maxDocs?: number }
): AgentWorkItem[] {
  const maxDocs = options?.maxDocs ?? 5;
  const selected = docs.slice(0, maxDocs);
  if (selected.length === 0) {
    return [];
  }

  return selected.map((doc, index) => ({
    id: `document-semantic-${index + 1}`,
    kind: "document-semantic" as const,
    optional: true,
    expectedFormat: "json" as const,
    prompt: [
      `Document semantic extraction for: ${doc.relPath}`,
      "",
      "Structural outline (already indexed as graph sections/chunks):",
      doc.outline,
      "",
      "Excerpt:",
      doc.excerpt.slice(0, 4000),
      "",
      "Extract KEY information and semantics for the knowledge graph.",
      "Return JSON only. Then submit via graphflow_insight(mode=\"submit\") with this id.",
    ].join("\n"),
    responseSchema: {
      relPath: `string — echo exactly: ${doc.relPath}`,
      title: "string — document title",
      summary: "string — 2-4 sentence semantic summary",
      keyEntities: "string[] — people/orgs/systems/APIs/modules → Concept nodes",
      requirements: "string[] — normative requirements (preferred over keyClaims)",
      keyClaims: "string[] — fallback facts/requirements if requirements omitted",
      relatedCodeHints: "string[] — code symbol names or relative file paths to link",
      tags: "string[] — short topic tags",
    },
  }));
}

/** Build a short outline string from markdown headings. */
export function outlineFromMarkdown(markdown: string, maxHeadings = 12): string {
  const headings = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,3}\s+/.test(line))
    .slice(0, maxHeadings);
  if (headings.length === 0) {
    return "(no headings — body chunk indexed)";
  }
  return headings.join("\n");
}
