/**
 * Unified runtime cancellation controller: running | paused | cancelled.
 * AbortSignal remains the cancel truth; pause/resume gate progress without aborting.
 */

import { emitRuntimeTimeline } from "./cancellation.js";

export type RuntimeControllerState = "running" | "paused" | "cancelled";

export class RuntimeController {
  private currentState: RuntimeControllerState = "running";
  private readonly controller = new AbortController();
  private pauseWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get state(): RuntimeControllerState {
    return this.currentState;
  }

  getState(): RuntimeControllerState {
    return this.currentState;
  }

  pause(): void {
    if (this.currentState === "cancelled" || this.currentState === "paused") {
      return;
    }
    this.currentState = "paused";
    emitRuntimeTimeline({
      phase: "runtime.controller",
      status: "paused",
      id: "runtime",
      detail: "RuntimeController.pause",
    });
  }

  resume(): void {
    if (this.currentState !== "paused") {
      return;
    }
    this.currentState = "running";
    emitRuntimeTimeline({
      phase: "runtime.controller",
      status: "resumed",
      id: "runtime",
      detail: "RuntimeController.resume",
    });
    const waiters = this.pauseWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  cancel(reason?: unknown): void {
    if (this.currentState === "cancelled") {
      return;
    }
    this.currentState = "cancelled";
    const error =
      reason instanceof Error
        ? reason
        : new Error(reason !== undefined ? String(reason) : "Runtime cancelled");
    if (!this.controller.signal.aborted) {
      this.controller.abort(error);
    }
    emitRuntimeTimeline({
      phase: "runtime.controller",
      status: "aborted",
      id: "runtime",
      detail: error.message,
    });
    const waiters = this.pauseWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  /** Block while paused; resolve on resume; reject if cancelled. */
  async waitIfPaused(): Promise<void> {
    if (this.currentState === "cancelled" || this.controller.signal.aborted) {
      const reason =
        this.controller.signal.reason instanceof Error
          ? this.controller.signal.reason
          : new Error("Runtime cancelled");
      throw reason;
    }
    if (this.currentState !== "paused") {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.pauseWaiters.push({ resolve, reject });
    });
  }
}
