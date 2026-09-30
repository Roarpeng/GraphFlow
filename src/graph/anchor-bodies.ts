import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { GraphNode } from "../core/types";
import { estimateTokens } from "./context-slicer-utils.js";

/**
 * Symbol bodies inside the context package.
 *
 * Anchors used to be id-only pointers, so a pack could score 92% anchor recall
 * while covering 1% of the body the anchor names: the agent got the right
 * position and then spent another round trip (or a whole-file Read) on it. This
 * quotes the declaration itself for the few anchors that matter most, and only
 * when the bytes on disk still match the signature we indexed — a body we
 * cannot verify is a body we do not ship.
 */

const DEFAULT_MAX_BODIES = 3;
const DEFAULT_MAX_BODY_TOKENS = 120;
/** Share of the package budget bodies may claim; the rest stays with anchors. */
const DEFAULT_BODY_BUDGET_RATIO = 0.2;

export interface AnchorBodyStats {
  attached: number;
  tokens: number;
  /** Symbol anchors we left as bare pointers, by reason. */
  noExtent: number;
  unverified: number;
  noBudget: number;
}

/**
 * Returns the declaration body of `node` when it can be quoted honestly, or
 * undefined with the reason recorded. `remainingTokens` is what the package has
 * left, so a body never pushes an anchor out of the pack.
 */
export type AnchorBodyReader = (node: GraphNode, remainingTokens: number) => string | undefined;

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function readContained(rootDir: string, relPath: string): string | undefined {
  if (!relPath || isAbsolute(relPath)) return undefined;
  const absPath = join(rootDir, relPath);
  const inside = relative(rootDir, absPath);
  if (!inside || inside.startsWith("..") || inside.includes(`..${sep}`) || isAbsolute(inside)) {
    return undefined;
  }
  if (!existsSync(absPath)) return undefined;
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return undefined;
  }
}

export function createAnchorBodyReader(options: {
  workspaceRoot: string;
  maxTokens: number;
  maxBodies?: number;
  maxBodyTokens?: number;
  budgetRatio?: number;
}): { reader: AnchorBodyReader; stats: AnchorBodyStats } {
  const maxBodies = options.maxBodies ?? DEFAULT_MAX_BODIES;
  const perBodyTokens = options.maxBodyTokens ?? DEFAULT_MAX_BODY_TOKENS;
  const bodyTokenCap = Math.floor(
    options.maxTokens * (options.budgetRatio ?? DEFAULT_BODY_BUDGET_RATIO)
  );
  const stats: AnchorBodyStats = { attached: 0, tokens: 0, noExtent: 0, unverified: 0, noBudget: 0 };
  const fileCache = new Map<string, string[] | undefined>();

  const linesOf = (relPath: string): string[] | undefined => {
    if (!fileCache.has(relPath)) {
      const content = readContained(options.workspaceRoot, relPath);
      fileCache.set(relPath, content?.split(/\r?\n/));
    }
    return fileCache.get(relPath);
  };

  const reader: AnchorBodyReader = (node, remainingTokens) => {
    if (stats.attached >= maxBodies || stats.tokens >= bodyTokenCap) {
      stats.noBudget += 1;
      return undefined;
    }
    if (node.type !== "Symbol" || typeof node.metadata?.line !== "number") {
      return undefined;
    }
    const relPath = typeof node.metadata.file === "string" ? node.metadata.file : undefined;
    const endLine = typeof node.metadata.endLine === "number" ? node.metadata.endLine : undefined;
    const signature = typeof node.metadata.signature === "string" ? node.metadata.signature : undefined;
    // No extent, or no parser signature to verify against: we would be quoting
    // a guess, so leave it an anchor and let the agent expand deliberately.
    if (!relPath || endLine === undefined || endLine < node.metadata.line || !signature) {
      stats.noExtent += 1;
      return undefined;
    }

    const lines = linesOf(relPath);
    if (!lines || lines.length === 0) {
      stats.noExtent += 1;
      return undefined;
    }
    const start = Math.max(0, node.metadata.line - 1);
    const end = Math.min(lines.length, endLine);
    const slice = lines.slice(start, end);
    const head = normalizeLine(signature).slice(0, 80);
    const window = normalizeLine(slice.slice(0, Math.min(slice.length, 6)).join("\n"));
    if (!head || !window.includes(head)) {
      // The symbol moved or was rewritten since indexing; the stored span would
      // quote someone else's code.
      stats.unverified += 1;
      return undefined;
    }

    let keep = slice.length;
    while (keep > 1 && estimateTokens(slice.slice(0, keep).join("\n")) > perBodyTokens) keep -= 1;
    const body = slice.slice(0, keep).join("\n").trimEnd();
    const tokens = estimateTokens(body);
    if (!body || tokens > remainingTokens || stats.tokens + tokens > bodyTokenCap) {
      // The cap is checked with this body's cost included: testing only the
      // running total let the last body overshoot by a whole unit.
      stats.noBudget += 1;
      return undefined;
    }
    stats.attached += 1;
    stats.tokens += tokens;
    return body;
  };

  return { reader, stats };
}
