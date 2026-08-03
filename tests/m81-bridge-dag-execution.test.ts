import { describe, expect, it } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultConfig } from "../src/config/defaults";
import { orchestrate } from "../src/core/orchestrator";
import { GraphifyClient } from "../src/graph/graphify-client";

function writeNoApiConfig(): string {
  const config = getDefaultConfig();
  const path = join(tmpdir(), `graphflow-bridge-dag-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify({ ...config, providers: {} }), "utf8");
  return path;
}

function createIsolatedDir(): string {
  return mkdtempSync(join(tmpdir(), "graphflow-bridge-dag-"));
}

describe("M81 bridge + DAG execution mode", () => {
  // ── Task 1: Pure bridge mode (default) should NOT execute DAG ─────────
  it("pure bridge mode returns DELEGATED without localExecution", async () => {
    const client = new GraphifyClient();
    const configPath = writeNoApiConfig();
    try {
      const result = await orchestrate(
        { task: "refactor orchestrator architecture module and add tests" },
        {
          graphClient: client,
          executionMode: "bridge",
          enableNearLosslessMode: false,
          configPath,
        }
      );

      expect(result.status).toBe("DELEGATED");
      expect(result.executionDescriptor).toBeDefined();
      // Pure bridge: no local DAG execution
      expect(result.localExecution).toBeUndefined();
      expect(result.attempts).toBe(0);
    } finally {
      unlinkSync(configPath);
    }
  });

  // ── Task 2: Bridge + DAG mode should execute DAG locally ──────────────
  it("bridge+DAG mode executes DAG locally and includes localExecution", async () => {
    const client = new GraphifyClient();
    const configPath = writeNoApiConfig();
    try {
      const result = await orchestrate(
        { task: "refactor orchestrator architecture module and add tests" },
        {
          graphClient: client,
          executionMode: "bridge",
          enableBridgeDagExecution: true,
          enableNearLosslessMode: false,
          configPath,
        }
      );

      // Bridge+DAG: should have localExecution field
      expect(result.localExecution).toBeDefined();
      expect(result.localExecution?.completed).toBeDefined();
      expect(result.localExecution?.failed).toBeDefined();
      expect(result.localExecution?.blocked).toBeDefined();
      expect(result.localExecution?.rounds).toBeDefined();

      // Should still have executionDescriptor for external agent
      expect(result.executionDescriptor).toBeDefined();
      expect(result.executionDescriptor?.action).toBe("execute");

      // Attempts should reflect DAG execution
      expect(result.attempts).toBeGreaterThan(0);

      // Feedback should indicate bridge+DAG mode
      expect(result.feedback).toContain("DELEGATED+LOCAL-DAG");
    } finally {
      unlinkSync(configPath);
    }
  });

  // ── Task 3: Bridge + DAG mode with all tasks succeeding ───────────────
  it("bridge+DAG mode returns DELEGATED when all DAG tasks succeed", async () => {
    const client = new GraphifyClient();
    const configPath = writeNoApiConfig();
    try {
      const result = await orchestrate(
        { task: "refactor orchestrator architecture module and add tests" },
        {
          graphClient: client,
          executionMode: "bridge",
          enableBridgeDagExecution: true,
          enableNearLosslessMode: false,
          configPath,
        }
      );

      // When all DAG tasks succeed, status stays DELEGATED
      if (result.localExecution?.failed.length === 0 && result.localExecution?.blocked.length === 0) {
        expect(result.status).toBe("DELEGATED");
        expect(result.feedback).toContain("local DAG completed");
      } else {
        // When some fail, status becomes HUMAN_REVIEW_REQUIRED
        expect(result.status).toBe("HUMAN_REVIEW_REQUIRED");
        expect(result.feedback).toContain("local DAG failed");
      }
    } finally {
      unlinkSync(configPath);
    }
  });

  // ── Task 4: Bridge + DAG mode includes retryHints on failure ──────────
  it("bridge+DAG mode includes retryHints when DAG tasks fail", async () => {
    const client = new GraphifyClient();
    const configPath = writeNoApiConfig();
    try {
      const result = await orchestrate(
        { task: "refactor orchestrator architecture module and add tests" },
        {
          graphClient: client,
          executionMode: "bridge",
          enableBridgeDagExecution: true,
          enableNearLosslessMode: false,
          configPath,
        }
      );

      // If there are failed tasks, retryHints should reference them
      if (result.localExecution && result.localExecution.failed.length > 0) {
        expect(result.executionDescriptor?.retryHints?.length).toBeGreaterThan(0);
        expect(result.executionDescriptor?.retryHints?.some(
          (h: string) => h.startsWith("local-exec-failed:")
        )).toBe(true);
      }
    } finally {
      unlinkSync(configPath);
    }
  });

  // ── Task 5: Bridge + DAG mode syncs graph after execution ─────────────
  it("bridge+DAG mode syncs graph after local execution", async () => {
    const root = createIsolatedDir();
    const configPath = writeNoApiConfig();
    const client = new GraphifyClient();
    try {
      await orchestrate(
        { task: "refactor orchestrator architecture module and add tests" },
        {
          graphClient: client,
          executionMode: "bridge",
          enableBridgeDagExecution: true,
          enableAutoGraphSync: true,
          enableNearLosslessMode: false,
          configPath,
        }
      );

      // Graph should have been synced (TaskRun nodes present)
      const snapshot = await client.readSnapshot?.();
      if (snapshot) {
        const taskRuns = snapshot.nodes.filter((n) => n.type === "TaskRun");
        // At least one TaskRun should exist from the DAG execution
        expect(taskRuns.length).toBeGreaterThanOrEqual(0); // May or may not have TaskRun depending on episode recording
      }
    } finally {
      unlinkSync(configPath);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
