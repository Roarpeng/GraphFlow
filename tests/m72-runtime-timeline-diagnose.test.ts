import { describe, expect, it, beforeEach } from "vitest";
import {
  clearRuntimeTimeline,
  emitRuntimeTimeline,
  getRuntimeTimelineSummary,
  queryRuntimeTimeline,
} from "../src/core/cancellation";
import { diagnoseRoutingResult } from "../src/surfaces/cli/runtime";
import { createMcpServer, executeToolCall } from "../src/surfaces/mcp/server";

describe("M72 runtime timeline diagnose", () => {
  beforeEach(() => {
    clearRuntimeTimeline();
  });

  it("summarizes buffered runtime timeline events", () => {
    emitRuntimeTimeline({ phase: "provider.fetch", status: "started", id: "fetch-1", ts: 1000 });
    emitRuntimeTimeline({ phase: "provider.fetch", status: "completed", id: "fetch-1", ts: 1005 });
    emitRuntimeTimeline({ phase: "dag.node", status: "failed", id: "node-1", ts: 1010 });

    const summary = getRuntimeTimelineSummary();

    expect(summary.totalBuffered).toBe(3);
    expect(summary.byStatus).toMatchObject({ started: 1, completed: 1, failed: 1 });
    expect(summary.byPhase).toMatchObject({ "provider.fetch": 2, "dag.node": 1 });
    expect(summary.recent.map((event) => event.id)).toEqual(["fetch-1", "fetch-1", "node-1"]);
  });

  it("queries runtime timeline by phase, status, id, and limit", () => {
    emitRuntimeTimeline({ phase: "provider.fetch", status: "started", id: "same", ts: 1000 });
    emitRuntimeTimeline({ phase: "provider.fetch", status: "completed", id: "same", ts: 1001 });
    emitRuntimeTimeline({ phase: "dag.node", status: "completed", id: "other", ts: 1002 });

    expect(queryRuntimeTimeline({ phase: "provider.fetch" })).toHaveLength(2);
    expect(queryRuntimeTimeline({ status: "completed" }).map((event) => event.id)).toEqual([
      "same",
      "other",
    ]);
    expect(queryRuntimeTimeline({ id: "same", status: "completed" })).toHaveLength(1);
    expect(queryRuntimeTimeline({ limit: 1 }).map((event) => event.id)).toEqual(["other"]);
  });

  it("includes runtime timeline in CLI diagnose JSON data", () => {
    emitRuntimeTimeline({ phase: "watcher.flush", status: "started", id: "flush-1", ts: 1000 });

    const diagnosis = diagnoseRoutingResult();

    expect(diagnosis.runtimeTimeline.totalBuffered).toBe(1);
    expect(diagnosis.runtimeTimeline.recent[0]?.id).toBe("flush-1");
  });

  it("includes runtime timeline in MCP diagnose response", async () => {
    emitRuntimeTimeline({ phase: "index.file", status: "completed", id: "src/demo.ts", ts: 1000 });

    const response = await executeToolCall(
      {
        name: "graphflow_diagnose",
        arguments: { nodeLimit: 0, edgeLimit: 0 },
      },
      createMcpServer()
    );
    // diagnose 全量响应超过 text 桩化阈值：结构化字段从 structuredContent 读。
    // The full diagnose response exceeds the text-stub threshold: read
    // structured fields from structuredContent.
    const result = response.structuredContent as {
      runtimeTimeline: { totalBuffered: number; recent: Array<{ id?: string }> };
    };

    expect(result.runtimeTimeline.totalBuffered).toBe(1);
    expect(result.runtimeTimeline.recent[0]?.id).toBe("src/demo.ts");
  });
});
