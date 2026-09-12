/**
 * GF-2 "verified receipt" reducer.
 *
 * Two strategies:
 *  - fingerprint (default, deterministic): lines matching a salience regex,
 *    plus unique lines, plus the first/last few lines, packed in line order
 *    under policy.reduce.maxReceiptTokens.
 *  - llm (when a `reducer` callback is supplied): the callback sees redacted,
 *    numbered source lines and returns line numbers; numbers that do not exist
 *    in the archived source are discarded.
 *
 * Either way the retained lines are then VERIFIED VERBATIM: the archived blob
 * is re-read fresh, its sha256 must still equal the handle's sha, and every
 * retained line must equal the exact bytes of that line in the archive. Any
 * mismatch degrades to `{ fallback: true, reason: "quote-mismatch" }` with a
 * bounded head/tail excerpt instead of the receipt. Nothing here throws.
 */

import { readFile } from "node:fs/promises";
import { logger } from "../utils/logger.js";
import { redactSecrets } from "../learning/dialogue-thread.js";
import { estimateTokens } from "../graph/context-slicer-utils.js";
import type { ResolvedObservationPolicy } from "./policy.js";
import type { ReduceResult, RetainedLine } from "./types.js";
import {
  blobPath,
  boundedExcerpt,
  packObservationImpl,
  recallObservationImpl,
  sha256Hex,
  splitLines,
} from "./store.js";

const SALIENT_LINE_RE = /error|fail|warn|exception|assert|expected|actual|panic|traceback|diff|^---|^\+\+\+/i;
/** First/last lines always kept by the fingerprint strategy (budget permitting). */
const FINGERPRINT_EDGE_LINES = 5;
/** Token budget reserved for the receipt header so receiptTokens stays under the cap. */
const HEADER_RESERVE_TOKENS = 32;
/** Line numbers in reducer output must not be glued to a preceding '-' or digit (so "-3" is not "3"). */
const LINE_NUMBER_RE = /(?<![-\d])\d+/g;

export interface ReduceObservationInput {
  rootDir: string;
  handle?: string;
  content?: string;
  policy: ResolvedObservationPolicy;
  reducer?: (prompt: string) => Promise<string>;
}

function failure(
  reason: string,
  excerpt: string,
  sourceHandle: string,
  sourceBytes: number
): ReduceResult {
  return {
    receipt: excerpt,
    retainedLines: [],
    verified: false,
    fallback: true,
    reason,
    sourceHandle,
    sourceBytes,
    receiptTokens: estimateTokens(excerpt),
  };
}

/** Greedy, deterministic, budget-capped line selection over candidate numbers. */
function capByTokenBudget(
  lines: string[],
  candidates: number[],
  maxTokens: number
): RetainedLine[] {
  const budget = Math.max(16, maxTokens - HEADER_RESERVE_TOKENS);
  const picked = new Map<number, string>();
  let tokens = 0;
  for (const n of candidates) {
    if (picked.has(n)) continue;
    const text = lines[n - 1];
    if (text === undefined) continue;
    const cost = estimateTokens(`L${n}: ${text}`) + 1; // +1 approximates the newline join
    if (tokens + cost > budget) continue; // skip oversized line, keep filling
    picked.set(n, text);
    tokens += cost;
  }
  return [...picked.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, text]) => ({ n, text }));
}

/** Deterministic salience selection: edge lines, then regex-salient, then unique lines. */
function fingerprintSelect(lines: string[], maxTokens: number): RetainedLine[] {
  const total = lines.length;
  const freq = new Map<string, number>();
  for (const text of lines) {
    freq.set(text, (freq.get(text) ?? 0) + 1);
  }

  const edge: number[] = [];
  for (let n = 1; n <= Math.min(FINGERPRINT_EDGE_LINES, total); n++) edge.push(n);
  for (let n = Math.max(1, total - FINGERPRINT_EDGE_LINES + 1); n <= total; n++) edge.push(n);
  const edgeSet = new Set(edge);

  const salient: number[] = [];
  const unique: number[] = [];
  for (let n = 1; n <= total; n++) {
    if (edgeSet.has(n)) continue;
    const text = lines[n - 1];
    if (text === undefined) continue;
    if (SALIENT_LINE_RE.test(text)) {
      salient.push(n);
    } else if (text.trim().length > 0 && freq.get(text) === 1) {
      unique.push(n);
    }
  }

  return capByTokenBudget(lines, [...edge, ...salient, ...unique], maxTokens);
}

function buildReducerPrompt(lines: string[]): string {
  const numbered = lines.map((text, i) => `L${i + 1}: ${text}`).join("\n");
  return [
    "You are an evidence-preserving reducer. Below is an archived tool output with 1-based line numbers.",
    "Select the minimal set of lines that preserves the evidence needed to understand what happened",
    "(errors, failures, assertions, key identifiers, decisive outcomes).",
    "Reply with ONLY a JSON array of line numbers, e.g. [3, 17, 42].",
    "",
    numbered,
  ].join("\n");
}

/** Parse reducer output into existing 1-based line numbers; nonexistent numbers are discarded. */
export function parseReducerLineNumbers(raw: string, lineCount: number): number[] {
  const found = new Set<number>();
  const arrayMatch = /\[[\s\S]*?\]/.exec(raw);
  const candidates = arrayMatch ? [arrayMatch[0], raw] : [raw];
  for (const candidate of candidates) {
    for (const match of candidate.matchAll(LINE_NUMBER_RE)) {
      const token = match[0];
      if (token === undefined) continue;
      const n = Number.parseInt(token, 10);
      if (Number.isFinite(n) && n >= 1 && n <= lineCount) {
        found.add(n);
      }
    }
    if (found.size > 0) break;
  }
  return [...found].sort((a, b) => a - b);
}

async function readArchivedSource(rootDir: string, sha: string): Promise<string | null> {
  try {
    return await readFile(blobPath(rootDir, sha), "utf8");
  } catch {
    return null;
  }
}

export async function reduceObservationImpl(opts: ReduceObservationInput): Promise<ReduceResult> {
  const policy = opts.policy;
  try {
    // 1. Resolve the archived source of truth.
    let sourceHandle = "";
    let sourceSha = "";
    let sourceBytes = 0;
    let source: string | null = null;

    if (opts.handle !== undefined) {
      const recalled = await recallObservationImpl({
        rootDir: opts.rootDir,
        handle: opts.handle,
        policy,
      });
      if (recalled.expired) {
        return failure("handle-expired", "", opts.handle, 0);
      }
      sourceHandle = recalled.handle;
      sourceSha = recalled.sha;
      sourceBytes = recalled.sizeBytes;
      source = recalled.content;
    } else if (opts.content !== undefined) {
      const packed = await packObservationImpl({
        rootDir: opts.rootDir,
        content: opts.content,
        policy,
      });
      if (packed.fallback) {
        return failure(packed.reason, "", "", 0);
      }
      sourceHandle = packed.handle;
      sourceSha = packed.sha;
      sourceBytes = packed.sizeBytes;
      // Reduce what is actually archived (post-redaction bytes), not caller memory.
      source = await readArchivedSource(opts.rootDir, sourceSha);
      if (source === null) {
        return failure("source-unavailable", "", sourceHandle, sourceBytes);
      }
    } else {
      return failure("no-source", "", "", 0);
    }

    if (sourceBytes > policy.reduce.maxSourceBytes) {
      return failure("source-too-large", boundedExcerpt(source, policy), sourceHandle, sourceBytes);
    }

    const lines = splitLines(source);

    // 2. Select retained lines (raw, unredacted — verification needs exact bytes).
    let retained: RetainedLine[];
    if (opts.reducer !== undefined) {
      let raw: string;
      try {
        raw = await opts.reducer(redactSecrets(buildReducerPrompt(lines)));
      } catch (error) {
        logger.warn({ error }, "observation reducer unavailable");
        return failure("reducer-unavailable", boundedExcerpt(source, policy), sourceHandle, sourceBytes);
      }
      const numbers = parseReducerLineNumbers(raw, lines.length);
      if (numbers.length === 0) {
        return failure("reducer-unavailable", boundedExcerpt(source, policy), sourceHandle, sourceBytes);
      }
      retained = capByTokenBudget(lines, numbers, policy.reduce.maxReceiptTokens);
    } else if (policy.reduce.strategy === "llm") {
      // A remote reducer route is never implied: "llm" without a caller-supplied
      // reducer (provider+model) fails open to an excerpt instead of silently
      // downgrading to the local fingerprint selector.
      return failure("reducer-route-missing", boundedExcerpt(source, policy), sourceHandle, sourceBytes);
    } else {
      retained = fingerprintSelect(lines, policy.reduce.maxReceiptTokens);
    }

    // 3. Verbatim verification against a fresh read of the archived source.
    let freshBuf: Buffer;
    try {
      freshBuf = await readFile(blobPath(opts.rootDir, sourceSha));
    } catch {
      return failure("source-unavailable", boundedExcerpt(source, policy), sourceHandle, sourceBytes);
    }
    const freshContent = freshBuf.toString("utf8");
    if (sha256Hex(freshBuf) !== sourceSha) {
      return failure("quote-mismatch", boundedExcerpt(freshContent, policy), sourceHandle, sourceBytes);
    }
    const freshLines = splitLines(freshContent);
    for (const { n, text } of retained) {
      if (freshLines[n - 1] !== text) {
        return failure("quote-mismatch", boundedExcerpt(freshContent, policy), sourceHandle, sourceBytes);
      }
    }

    // 4. Verified — build the redacted receipt.
    const header =
      `[observation ${sourceHandle}] ${lines.length} lines, ${sourceBytes} bytes - ` +
      `verified excerpt (${retained.length} retained)`;
    const receipt = redactSecrets([header, ...retained.map(({ n, text }) => `L${n}: ${text}`)].join("\n"));
    return {
      receipt,
      retainedLines: retained.map(({ n, text }) => ({ n, text: redactSecrets(text) })),
      verified: true,
      fallback: false,
      sourceHandle,
      sourceBytes,
      receiptTokens: estimateTokens(receipt),
    };
  } catch (error) {
    logger.warn({ error }, "reduceObservation failed");
    return failure("reduce-error", "", opts.handle ?? "", 0);
  }
}
