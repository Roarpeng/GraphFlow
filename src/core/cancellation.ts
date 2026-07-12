/**
 * Unified runtime cancellation + lightweight timeline events.
 *
 * AbortSignal is the single source of truth for cancel/timeout.
 * Pause/resume can later wrap the same token without inventing a second API.
 */

import { logger } from "../utils/logger.js";

export type RuntimeTimelinePhase =
  | "dag.node"
  | "provider.fetch"
  | "provider.execute"
  | "index.file"
  | "watcher.flush";

export type RuntimeTimelineStatus =
  | "started"
  | "completed"
  | "aborted"
  | "timeout"
  | "failed"
  | "paused"
  | "resumed";

export interface RuntimeTimelineEvent {
  ts: number;
  phase: RuntimeTimelinePhase;
  status: RuntimeTimelineStatus;
  id?: string;
  detail?: string;
  durationMs?: number;
}

const timelineBuffer: RuntimeTimelineEvent[] = [];
const MAX_TIMELINE_EVENTS = 200;

export function emitRuntimeTimeline(event: Omit<RuntimeTimelineEvent, "ts"> & { ts?: number }): void {
  const full: RuntimeTimelineEvent = {
    ...event,
    ts: event.ts ?? Date.now(),
  };
  timelineBuffer.push(full);
  if (timelineBuffer.length > MAX_TIMELINE_EVENTS) {
    timelineBuffer.splice(0, timelineBuffer.length - MAX_TIMELINE_EVENTS);
  }
  logger.debug(full, "runtime.timeline");
}

export function getRuntimeTimeline(limit = 50): RuntimeTimelineEvent[] {
  const n = Math.max(1, Math.min(limit, MAX_TIMELINE_EVENTS));
  return timelineBuffer.slice(-n);
}

export function clearRuntimeTimeline(): void {
  timelineBuffer.length = 0;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  const message = "message" in error ? String((error as { message?: unknown }).message) : "";
  return name === "AbortError" || /aborted|abort/i.test(message);
}

/** Merge an optional external signal with a timeout into one AbortSignal. */
export function createTimeoutSignal(
  timeoutMs: number,
  external?: AbortSignal
): { signal: AbortSignal; abort: (reason?: unknown) => void; dispose: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abort = (reason?: unknown): void => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const onExternalAbort = (): void => {
    abort(external?.reason ?? new Error("Aborted"));
  };

  if (external) {
    if (external.aborted) {
      onExternalAbort();
    } else {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      abort(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  const dispose = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (external) {
      external.removeEventListener("abort", onExternalAbort);
    }
  };

  return { signal: controller.signal, abort, dispose };
}

/**
 * Run an async operation bound to a timeout + optional external AbortSignal.
 * On timeout/cancel, aborts the signal so underlying fetch can tear down sockets.
 */
export async function runAbortable<T>(
  label: string,
  timeoutMs: number,
  external: AbortSignal | undefined,
  execute: (signal: AbortSignal) => Promise<T>,
  phase: RuntimeTimelinePhase = "provider.execute"
): Promise<T> {
  const startedAt = Date.now();
  const { signal, dispose } = createTimeoutSignal(timeoutMs, external);
  emitRuntimeTimeline({ phase, status: "started", id: label });

  try {
    const value = await execute(signal);
    emitRuntimeTimeline({
      phase,
      status: "completed",
      id: label,
      durationMs: Date.now() - startedAt,
    });
    return value;
  } catch (error) {
    const aborted = signal.aborted || isAbortError(error);
    const reasonText =
      signal.reason instanceof Error
        ? signal.reason.message
        : error instanceof Error
          ? error.message
          : String(signal.reason ?? error);
    const timedOut = aborted && /timed out/i.test(reasonText);
    emitRuntimeTimeline({
      phase,
      status: timedOut ? "timeout" : aborted ? "aborted" : "failed",
      id: label,
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
    if (aborted && !isAbortError(error)) {
      const reason =
        signal.reason instanceof Error
          ? signal.reason
          : new Error(`${label} aborted${timedOut ? ` (timeout ${timeoutMs}ms)` : ""}`);
      throw reason;
    }
    throw error;
  } finally {
    dispose();
  }
}
