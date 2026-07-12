import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearRuntimeTimeline,
  createTimeoutSignal,
  emitRuntimeTimeline,
  getRuntimeTimeline,
  runAbortable,
} from "../src/core/cancellation";
import { executeDag, type TaskExecutor } from "../src/core/dag-engine";
import type { TaskNode } from "../src/core/types";
import { GraphifyFileClient } from "../src/graph/graphify-file-client";
import { ensureMcpWorkspaceEnv, isUnsafeWorkspaceFallback } from "../src/config/discover-workspace";

describe("M70 cancellation and pretty graph store", () => {
  beforeEach(() => {
    clearRuntimeTimeline();
  });

  it("createTimeoutSignal aborts after timeout", async () => {
    const { signal, dispose } = createTimeoutSignal(30);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(signal.aborted).toBe(true);
    dispose();
  });

  it("createTimeoutSignal merges external abort", () => {
    const parent = new AbortController();
    const { signal, dispose } = createTimeoutSignal(60_000, parent.signal);
    parent.abort();
    expect(signal.aborted).toBe(true);
    dispose();
  });

  it("runAbortable records timeline events", async () => {
    const value = await runAbortable("demo", 1000, undefined, async () => "ok");
    expect(value).toBe("ok");
    const events = getRuntimeTimeline();
    expect(events.some((e) => e.status === "started")).toBe(true);
    expect(events.some((e) => e.status === "completed")).toBe(true);
  });

  it("executeDag aborts slow nodes via AbortSignal", async () => {
    const plan: TaskNode[] = [
      {
        id: "slow",
        description: "slow",
        dependencies: [],
        status: "PENDING",
        contextQuery: "",
        retryCount: 0,
      },
      {
        id: "fast",
        description: "fast",
        dependencies: [],
        status: "PENDING",
        contextQuery: "",
        retryCount: 0,
      },
    ];

    let slowSawAbort = false;
    const executor: TaskExecutor = async (task, signal) => {
      if (task.id === "slow") {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500);
          signal?.addEventListener(
            "abort",
            () => {
              slowSawAbort = true;
              clearTimeout(timer);
              resolve();
            },
            { once: true }
          );
        });
        return true;
      }
      return true;
    };

    const result = await executeDag(plan, executor, { nodeTimeoutMs: 40 });
    expect(result.failed).toContain("slow");
    expect(result.completed).toContain("fast");
    expect(slowSawAbort).toBe(true);
    expect(getRuntimeTimeline().some((e) => e.id === "slow" && e.status === "timeout")).toBe(true);
  });

  it("writes pretty-printed graph JSON", async () => {
    const dir = join(tmpdir(), `graphflow-pretty-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const storePath = join(dir, "graph.json");
    try {
      const client = new GraphifyFileClient(storePath);
      await client.upsertNodes([
        { id: "n1", type: "File", content: "hello" },
        { id: "n2", type: "Symbol", content: "world" },
      ]);
      await client.upsertEdges([{ from: "n1", to: "n2", relation: "defines" }]);

      const raw = readFileSync(storePath, "utf8");
      expect(raw).toContain("\n");
      expect(raw).toMatch(/\{\s*\n\s*"nodes"/);
      const parsed = JSON.parse(raw) as { nodes: unknown[]; edges: unknown[] };
      expect(parsed.nodes).toHaveLength(2);
      expect(parsed.edges).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ensureMcpWorkspaceEnv clears unsafe GRAPHFLOW_WORKSPACE_ROOT", () => {
    if (process.platform !== "win32" || !process.env.USERPROFILE) {
      return;
    }
    const home = process.env.USERPROFILE;
    expect(isUnsafeWorkspaceFallback(home)).toBe(true);
    process.env.GRAPHFLOW_WORKSPACE_ROOT = home;
    const resolved = ensureMcpWorkspaceEnv(home);
    // Must never keep home; may rediscover a real project via IDE hints.
    expect(resolved === undefined || !isUnsafeWorkspaceFallback(resolved)).toBe(true);
    if (process.env.GRAPHFLOW_WORKSPACE_ROOT) {
      expect(isUnsafeWorkspaceFallback(process.env.GRAPHFLOW_WORKSPACE_ROOT)).toBe(false);
    }
  });

  it("emitRuntimeTimeline caps buffer size", () => {
    for (let i = 0; i < 250; i += 1) {
      emitRuntimeTimeline({ phase: "dag.node", status: "started", id: String(i) });
    }
    expect(getRuntimeTimeline(500).length).toBeLessThanOrEqual(200);
  });
});
