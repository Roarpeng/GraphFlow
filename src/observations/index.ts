/**
 * GF-2 "verified receipt" observations — public API.
 *
 * Self-contained module: pack large outputs into a content-addressed local
 * store, recall their exact bytes later, and reduce them to bounded receipts
 * whose retained lines are verified verbatim against the archive. Every
 * function fails open — storage/IO/reducer problems surface as
 * `{ fallback: true, reason }` or `{ expired: true }`, never as throws.
 */

import { resolveObservationPolicy } from "./policy.js";
import { packObservationImpl, recallObservationImpl } from "./store.js";
import { reduceObservationImpl } from "./reduce.js";
import type { ObservationPolicy, PackResult, RecallResult, ReduceResult } from "./types.js";

export type {
  ObservationPolicy,
  ObservationReducePolicy,
  PackFailure,
  PackResult,
  PackSuccess,
  RecallExpired,
  RecallResult,
  RecallSuccess,
  ReduceResult,
  RetainedLine,
} from "./types.js";
export { DEFAULT_OBSERVATION_POLICY } from "./policy.js";

export async function packObservation(opts: {
  rootDir: string;
  content: string;
  origin?: string;
  policy?: ObservationPolicy;
}): Promise<PackResult> {
  return packObservationImpl({ ...opts, policy: resolveObservationPolicy(opts.policy) });
}

export async function recallObservation(opts: {
  rootDir: string;
  handle: string;
  page?: number;
  range?: [number, number];
  policy?: ObservationPolicy;
}): Promise<RecallResult> {
  return recallObservationImpl({ ...opts, policy: resolveObservationPolicy(opts.policy) });
}

export async function reduceObservation(opts: {
  rootDir: string;
  handle?: string;
  content?: string;
  policy?: ObservationPolicy;
  reducer?: (prompt: string) => Promise<string>;
}): Promise<ReduceResult> {
  return reduceObservationImpl({ ...opts, policy: resolveObservationPolicy(opts.policy) });
}
