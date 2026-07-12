import { describe, expect, it, beforeEach } from "vitest";
import { clearRuntimeTimeline, getRuntimeTimeline } from "../src/core/cancellation";
import { executeDag, type TaskExecutor } from "../src/core/dag-engine";
import { RuntimeController } from "../src/core/runtime-controller";
import type { TaskNode } from "../src/core/types";

function task(id: string, dependencies: string[] = []): TaskNode {
  return {
    id,
    description: id,
    dependencies,
    status: "PENDING",
    contextQuery: "",
    retryCount: 0,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("M71 runtime controller", () => {
  beforeEach(() => {
    clearRuntimeTimeline();
  });

  it("pause blocks execution until resume", async () => {
    const runtime = new RuntimeController();
    const executed: string[] = [];
    const plan = [task("first"), task("second", ["first"])];
    const executor: TaskExecutor = async (node) => {
      executed.push(node.id);
      return true;
    };

    runtime.pause();
    expect(runtime.state).toBe("paused");
    const run = executeDag(plan, executor, {
      runtime,
      concurrencyLimit: 1,
      nodeTimeoutMs: 1_000,
    });

    await flushMicrotasks();
    expect(executed).toEqual([]);

    runtime.resume();
    expect(runtime.state).toBe("running");
    const result = await run;

    expect(result.completed).toEqual(["first", "second"]);
    expect(executed).toEqual(["first", "second"]);
  });

  it("cancel aborts and fails remaining work", async () => {
    const runtime = new RuntimeController();
    const plan = [task("first"), task("second", ["first"])];
    let firstSawAbort = false;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const executor: TaskExecutor = async (node, signal) => {
      if (node.id === "first") {
        markStarted?.();
        await new Promise<never>((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              firstSawAbort = true;
              reject(signal.reason);
            },
            { once: true }
          );
        });
      }
      return true;
    };

    const run = executeDag(plan, executor, {
      runtime,
      concurrencyLimit: 1,
      nodeTimeoutMs: 1_000,
    });

    await started;
    runtime.cancel(new Error("user cancelled"));
    expect(runtime.state).toBe("cancelled");
    const result = await run;

    expect(firstSawAbort).toBe(true);
    expect(result.failed).toContain("first");
    expect(result.blocked).toContain("second");
    expect(result.completed).toEqual([]);
    expect(getRuntimeTimeline().some((e) => e.id === "first" && e.status === "aborted")).toBe(true);
  });

  it("timeline contains paused and resumed events", () => {
    const runtime = new RuntimeController();

    runtime.pause();
    runtime.resume();

    const statuses = getRuntimeTimeline().map((event) => event.status);
    expect(statuses).toContain("paused");
    expect(statuses).toContain("resumed");
  });
});
