/**
 * index-pipeline.ts — bounded-concurrency async pipeline for full-rebuild indexing.
 *
 * `indexWorkspaceFiles` used to walk files in fixed slices of `concurrency` and
 * `Promise.all` each slice, and its per-file reads were `readFileSync` — so on
 * the in-process path (dev, tests, small workspaces below the worker-pool gate)
 * nothing actually overlapped: every read blocked the event loop before the
 * next file could start. This module provides the honest replacement:
 *
 *   - reads go through `fs/promises` at the call site, so several file reads
 *     are genuinely in flight at once;
 *   - up to `concurrency` files are being processed at any moment (sliding
 *     window, not fixed batches — a slow file no longer stalls its whole slice);
 *   - results are handed to the caller STRICTLY in original walk order via
 *     `onOrderedResult`, so the collected nodes/edges/cache writes are
 *     byte-identical at any concurrency level (determinism contract);
 *   - `concurrency <= 1` (or `parallelIndex.enabled === false`) takes the
 *     sequential path: each file is fully processed before the next one starts,
 *     reproducing the exact serial behavior.
 *
 * Parsing itself stays on the calling thread (tree-sitter wasm is CPU-bound and
 * single-threaded); the real win is overlapping file IO and parse scheduling,
 * plus the worker pool (`file-parse-pool.ts`) for compiled builds.
 */

/** Default fan-out for the parallel index pipeline (graphPolicy.parallelIndex.concurrency). */
export const DEFAULT_PARALLEL_INDEX_CONCURRENCY = 4;

/** Mirrors `graphPolicy.parallelIndex` from the config schema. */
export interface ParallelIndexPolicy {
  /** Default true. `false` reproduces the exact serial behavior. */
  enabled?: boolean;
  /** Max files in flight. Default {@link DEFAULT_PARALLEL_INDEX_CONCURRENCY}. */
  concurrency?: number;
}

/**
 * Resolve the effective pipeline concurrency.
 *
 * Precedence: `enabled === false` pins 1 (serial); otherwise an explicit
 * `policy.concurrency` wins, then the legacy `concurrency` option, then the
 * default. Non-finite or < 1 values clamp to 1.
 */
export function resolveIndexConcurrency(
  policy?: ParallelIndexPolicy,
  legacyConcurrency?: number
): number {
  if (policy?.enabled === false) {
    return 1;
  }
  const requested = policy?.concurrency ?? legacyConcurrency ?? DEFAULT_PARALLEL_INDEX_CONCURRENCY;
  const floored = Math.floor(requested);
  if (!Number.isFinite(floored) || floored < 1) {
    return 1;
  }
  return floored;
}

export interface RunIndexPipelineOptions {
  /** Max items processed at once; 1 (or less) runs strictly sequentially. */
  concurrency: number;
  /** Checked before STARTING each item; in-flight items still complete. */
  signal?: AbortSignal | undefined;
}

/**
 * Run `task` over `items` with bounded concurrency, invoking `onOrderedResult`
 * for every completed item strictly in input order (as soon as the ordered
 * frontier reaches it). Returns when every item has been delivered or the
 * signal aborted the scheduling of further items.
 *
 * Errors from `task` propagate (reject): callers that want per-item failure
 * isolation catch inside their own task wrapper — one unreadable file must not
 * abort a whole workspace index.
 */
export async function runIndexPipeline<T, R>(
  items: readonly T[],
  task: (item: T, index: number) => Promise<R>,
  onOrderedResult: (item: T, index: number, value: R) => void,
  options: RunIndexPipelineOptions
): Promise<void> {
  const total = items.length;
  if (total === 0) {
    return;
  }
  const limit = Math.max(1, Math.min(options.concurrency, total));

  if (limit === 1) {
    // Sequential path: process each item fully (in order) before the next —
    // the exact behavior `parallelIndex.enabled: false` pins down.
    for (let i = 0; i < total; i += 1) {
      if (options.signal?.aborted) {
        return;
      }
      const value = await task(items[i]!, i);
      onOrderedResult(items[i]!, i, value);
    }
    return;
  }

  // Sliding-window path: `limit` workers pull the next index, park the result,
  // and the ordered frontier delivers results in walk order as they complete.
  const settled = new Array<{ value: R } | undefined>(total);
  let nextIndex = 0;
  let mergeIndex = 0;

  const advanceFrontier = (): void => {
    while (mergeIndex < total) {
      const slot = settled[mergeIndex];
      if (slot === undefined) {
        return;
      }
      settled[mergeIndex] = undefined;
      onOrderedResult(items[mergeIndex]!, mergeIndex, slot.value);
      mergeIndex += 1;
    }
  };

  const worker = async (): Promise<void> => {
    while (!options.signal?.aborted) {
      const index = nextIndex;
      if (index >= total) {
        return;
      }
      nextIndex += 1;
      settled[index] = { value: await task(items[index]!, index) };
      advanceFrontier();
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
}
