/**
 * GF-2 "verified receipt" observations — public type contracts.
 *
 * An observation is a large tool/agent output archived content-addressed under
 * `<rootDir>/.graphflow/observations/`. Packing returns a small handle +
 * head/tail excerpt; recall returns exact archived bytes; reduce produces a
 * bounded, line-anchored receipt whose every retained line is re-verified
 * verbatim against the archived source before it is allowed to stand in for
 * the full output.
 */

/** Reduction knobs nested inside {@link ObservationPolicy}. All fields optional; see policy.ts for defaults. */
export interface ObservationReducePolicy {
  enabled?: boolean;
  strategy?: "fingerprint" | "llm";
  maxReceiptTokens?: number;
  maxSourceBytes?: number;
}

/**
 * Observation store policy. Every field is optional at the call site; the
 * resolver fills in DEFAULT_OBSERVATION_POLICY values.
 *
 * `enabled` is advisory for future integration wiring: the direct API calls in
 * this module always operate (an explicit call is explicit intent).
 */
export interface ObservationPolicy {
  enabled?: boolean;
  inlineThresholdBytes?: number;
  headBytes?: number;
  tailBytes?: number;
  maxStoreBytes?: number;
  ttlDays?: number;
  redactOnStore?: boolean;
  reduce?: ObservationReducePolicy;
}

/** Successful pack: content-addressed handle plus bounded head/tail excerpt of the stored bytes. */
export interface PackSuccess {
  fallback: false;
  handle: string;
  sha: string;
  sizeBytes: number;
  lines: number;
  head: string;
  tail: string;
}

/** Failed pack (fail-open): no handle is minted, nothing was archived. */
export interface PackFailure {
  fallback: true;
  reason: string;
}

export type PackResult = PackSuccess | PackFailure;

/** Successful recall: exact archived bytes (or the requested page/range slice of them). */
export interface RecallSuccess {
  expired: false;
  handle: string;
  sha: string;
  content: string;
  sizeBytes: number;
  lines: number;
  page: number;
  pageCount: number;
  pageLines: number;
}

/** Missing, malformed, or TTL-expired handle — the caller must re-obtain the content. */
export interface RecallExpired {
  expired: true;
}

export type RecallResult = RecallSuccess | RecallExpired;

/** One verbatim line retained into a receipt, 1-based line number into the archived source. */
export interface RetainedLine {
  n: number;
  text: string;
}

/**
 * Result of a reduction. On any failure (`fallback: true`) `receipt` carries a
 * bounded head/tail excerpt of the source instead of the verified receipt and
 * `reason` explains why; `retainedLines` is empty and `verified` is false.
 */
export interface ReduceResult {
  receipt: string;
  retainedLines: RetainedLine[];
  verified: boolean;
  fallback: boolean;
  reason?: string;
  sourceHandle: string;
  sourceBytes: number;
  receiptTokens: number;
}
