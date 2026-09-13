/**
 * file-parse-pool.ts — worker pool for per-file parsing.
 *
 * Indexing a large workspace is dominated by reading + parsing files, which runs
 * on one thread today. The pool fans that step out across `worker_threads`;
 * everything else (cache decisions, graph pruning, store writes, reference-edge
 * building) stays on the main thread.
 *
 * Fail-open by design: when workers are unavailable (older runtime, bundler
 * stripped them, `GRAPHFLOW_INDEX_WORKERS=0`, too few files) the caller keeps
 * using the in-process path. Every worker error rejects only that task, which
 * the caller then parses in-process instead of failing the whole index.
 */

import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, extname, join } from "node:path";
import { Worker } from "node:worker_threads";
import type { GraphEdge, GraphNode } from "../core/types.js";
import type { ParsedFile } from "./file-indexer-nodes.js";

export interface FileParseTask {
  relPath: string;
  absPath: string;
  size: number;
  /** Hash from the index cache; the worker skips parsing when it still matches. */
  prevHash?: string;
  forceReindex?: boolean;
}

export interface FileParseOutcome {
  /** Content hash matched the cache: the file needs no re-parse. */
  unchanged: boolean;
  currentHash: string;
  fileNodes?: GraphNode[];
  fileEdges?: GraphEdge[];
  parsedEntry?: ParsedFile;
}

export interface WorkerLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (value: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): unknown;
  unref?(): void;
}

export type WorkerFactory = (
  workerPath: string,
  options: { execArgv?: string[] }
) => WorkerLike;

export interface FileParsePool {
  readonly size: number;
  readonly threaded: boolean;
  /** Rejects when the worker fails; callers fall back to in-process parsing. */
  run(task: FileParseTask): Promise<FileParseOutcome>;
  close(): void;
}

/** Files below this count are not worth the thread hand-off. */
export const MIN_FILES_FOR_WORKERS = 24;
const MAX_WORKERS = 8;
const DISABLE_ENV = "GRAPHFLOW_INDEX_WORKERS";

interface QueuedTask {
  task: FileParseTask;
  resolve: (outcome: FileParseOutcome) => void;
  reject: (error: Error) => void;
}

interface PoolSlot {
  worker: WorkerLike;
  busy: boolean;
  task: QueuedTask | null;
}

function workersDisabledByEnv(): boolean {
  const raw = process.env[DISABLE_ENV]?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off" || raw === "no" || raw === "disabled";
}

/** Default worker count: all but one core, capped; 0 when it would not help. */
export function defaultWorkerCount(): number {
  let cores: number;
  try {
    cores = availableParallelism();
  } catch {
    cores = 4;
  }
  if (!Number.isFinite(cores) || cores <= 1) return 0;
  return Math.max(2, Math.min(MAX_WORKERS, cores - 1));
}

/**
 * Resolve the worker entry next to the running module: the published build ships
 * `file-parse-worker.js`; TypeScript sources need the `tsx` loader.
 */
export function resolveParseWorkerEntry(
  currentModule: string
): { path: string; execArgv: string[] } | undefined {
  const extension = extname(currentModule) || ".js";
  const candidate = join(dirname(currentModule), `file-parse-worker${extension}`);
  if (!existsSync(candidate)) {
    return undefined;
  }
  return {
    path: candidate,
    execArgv: extension === ".ts" ? ["--import", "tsx"] : [],
  };
}

export interface CreateFileParsePoolOptions {
  workerCount?: number;
  workerEntry?: { path: string; execArgv: string[] };
  workerFactory?: WorkerFactory;
  /** Current module path, injected by tests. */
  currentModule?: string;
}

/**
 * Create a pool, or return undefined when worker threads cannot be used — the
 * caller must then parse in-process.
 */
export function createFileParsePool(
  options: CreateFileParsePoolOptions = {}
): FileParsePool | undefined {
  if (workersDisabledByEnv()) return undefined;
  const requested = options.workerCount ?? defaultWorkerCount();
  if (requested <= 0) return undefined;

  const entry = options.workerEntry ?? resolveParseWorkerEntry(options.currentModule ?? __filename);
  if (!entry) return undefined;

  const factory: WorkerFactory =
    options.workerFactory ??
    ((workerPath, workerOptions) =>
      new Worker(workerPath, {
        ...(workerOptions.execArgv && workerOptions.execArgv.length > 0
          ? { execArgv: workerOptions.execArgv }
          : {}),
      }));

  const slots: PoolSlot[] = [];
  let closed = false;
  let nextId = 0;

  const spawn = (): WorkerLike => {
    const worker = factory(entry.path, {
      ...(entry.execArgv.length > 0 ? { execArgv: entry.execArgv } : {}),
    });
    worker.unref?.();
    return worker;
  };

  const finishSlot = (slot: PoolSlot, settle: (task: QueuedTask) => void): void => {
    const task = slot.task;
    slot.task = null;
    slot.busy = false;
    if (task) settle(task);
    drain();
  };

  const attach = (slot: PoolSlot): void => {
    slot.worker.on("message", (value: unknown) => {
      const message = value as
        | { id: number; ok: true; outcome: FileParseOutcome }
        | { id: number; ok: false; error: string };
      finishSlot(slot, (task) =>
        message.ok ? task.resolve(message.outcome) : task.reject(new Error(message.error))
      );
    });
    slot.worker.on("error", (error: Error) => {
      // Replace the crashed worker so remaining tasks still run threaded; the
      // failed task is rejected so the caller can parse it in-process.
      const replacement = (() => {
        try {
          return spawn();
        } catch {
          return undefined;
        }
      })();
      finishSlot(slot, (task) => task.reject(error));
      if (replacement) {
        slot.worker = replacement;
        attach(slot);
      } else {
        slot.busy = true; // permanently unusable: tasks drain elsewhere
        slot.worker = {
          postMessage: () => undefined,
          on: () => undefined,
          terminate: () => undefined,
        };
      }
    });
    slot.worker.on("exit", (code: number) => {
      if (!closed && code !== 0) {
        finishSlot(slot, (task) =>
          task.reject(new Error(`index worker exited with code ${code}`))
        );
      }
    });
  };

  try {
    for (let i = 0; i < requested; i += 1) {
      const slot: PoolSlot = { worker: spawn(), busy: false, task: null };
      attach(slot);
      slots.push(slot);
    }
  } catch {
    for (const slot of slots) {
      try {
        slot.worker.terminate();
      } catch {
        // ignore
      }
    }
    return undefined;
  }

  const queue: QueuedTask[] = [];

  function drain(): void {
    while (queue.length > 0) {
      const slot = slots.find((candidate) => !candidate.busy);
      if (!slot) return;
      const task = queue.shift()!;
      slot.busy = true;
      slot.task = task;
      slot.worker.postMessage({ id: (nextId += 1), task: task.task });
    }
  }

  return {
    size: slots.length,
    threaded: true,
    run(task: FileParseTask): Promise<FileParseOutcome> {
      return new Promise<FileParseOutcome>((resolve, reject) => {
        if (closed) {
          reject(new Error("index worker pool is closed"));
          return;
        }
        queue.push({ task, resolve, reject });
        drain();
      });
    },
    close(): void {
      closed = true;
      for (const slot of slots) {
        const task = slot.task;
        slot.task = null;
        slot.busy = true;
        if (task) task.reject(new Error("index worker pool closed"));
        try {
          slot.worker.terminate();
        } catch {
          // ignore
        }
      }
      slots.length = 0;
      queue.length = 0;
    },
  };
}

/** True when a workspace is large enough (and workers allowed) to thread. */
export function shouldUseWorkerPool(
  fileCount: number,
  options?: { indexWorkers?: number }
): boolean {
  if (options?.indexWorkers === 0) return false;
  if (typeof options?.indexWorkers === "number" && options.indexWorkers > 0) return fileCount >= 4;
  if (workersDisabledByEnv()) return false;
  return fileCount >= MIN_FILES_FOR_WORKERS;
}
