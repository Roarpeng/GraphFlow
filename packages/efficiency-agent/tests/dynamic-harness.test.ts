import { describe, expect, it, vi } from "vitest";
import type { ExecutionContractV1 } from "../src/contract.js";
import type { WorkerAdapter, WorkerObservation } from "../src/domain.js";
import {
  createTemporaryHarness,
  type DynamicSubAgent,
  type SpecialistTool,
} from "../src/dynamic-harness.js";

function makeContract(overrides: Partial<ExecutionContractV1> = {}): ExecutionContractV1 {
  return {
    schemaVersion: "1.0",
    taskId: "task:test-harness",
    mode: "shadow",
    reuseMode: "FRESH",
    confidence: 0.5,
    signals: {
      taskComplexity: "simple",
      executionMode: "bridge",
      fusedStepCount: 1,
      similarEpisodeCount: 0,
    },
    context: {
      source: "graphflow",
      requiredAnchors: ["test.ts"],
    },
    worker: {
      modelTier: "economy",
      executionMode: "one-shot",
      maxRounds: 1,
    },
    validation: ["npm test"],
    decision: {
      provenance: "deterministic",
      llmCalls: 0,
      durationMs: 1,
    },
    ...overrides,
  };
}

describe("Dynamic Temporary Harness (HTML §11)", () => {
  describe("Trivial complexity — deterministic fast-path", () => {
    it("completes immediately without calling worker when contract is REUSE", async () => {
      const harness = createTemporaryHarness("trivial");
      const contract = makeContract({ reuseMode: "REUSE" });
      const worker: WorkerAdapter = {
        name: "unused-worker",
        prepare: vi.fn(),
        execute: vi.fn(),
        validate: vi.fn(),
        stop: vi.fn(),
      };

      const result = await harness.run(contract, worker);
      expect(result.status).toBe("completed");
      expect(result.complexity).toBe("trivial");
      expect(result.rounds).toBe(0);
      expect(result.stopReason).toBe("trivial-fast-path");
      expect(result.validation?.passed).toBe(true);
      expect(worker.prepare).not.toHaveBeenCalled();
      expect(worker.execute).not.toHaveBeenCalled();
      expect(worker.stop).toHaveBeenCalled();
    });

    it("runs single-step fast-path when worker is provided and contract is not REUSE", async () => {
      const harness = createTemporaryHarness("trivial");
      const contract = makeContract({ reuseMode: "FRESH" });
      const worker: WorkerAdapter = {
        name: "trivial-worker",
        prepare: vi.fn().mockResolvedValue({ command: "node", args: ["-v"] }),
        execute: vi.fn().mockResolvedValue({ durationMs: 2, exitCode: 0, stdoutTail: "v20.0.0" }),
        validate: vi.fn().mockResolvedValue({ passed: true, checks: [{ name: "quick", passed: true }] }),
        stop: vi.fn(),
      };

      const result = await harness.run(contract, worker);
      expect(result.status).toBe("completed");
      expect(result.rounds).toBe(1);
      expect(result.stopReason).toBe("validation-passed");
      expect(worker.prepare).toHaveBeenCalledTimes(1);
      expect(worker.execute).toHaveBeenCalledTimes(1);
      expect(worker.validate).toHaveBeenCalledTimes(1);
      expect(worker.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe("Simple complexity — single worker one-shot + validation", () => {
    it("runs exactly one round and completes if validation passes", async () => {
      const harness = createTemporaryHarness("simple");
      const contract = makeContract();
      const worker: WorkerAdapter = {
        name: "simple-worker",
        prepare: vi.fn().mockResolvedValue({ command: "npm", args: ["test"] }),
        execute: vi.fn().mockResolvedValue({ durationMs: 10, exitCode: 0 }),
        validate: vi.fn().mockResolvedValue({ passed: true, checks: [{ name: "unit", passed: true }] }),
        stop: vi.fn(),
      };

      const result = await harness.run(contract, worker);
      expect(result.status).toBe("completed");
      expect(result.rounds).toBe(1);
      expect(result.stopReason).toBe("validation-passed");
      expect(result.validation?.passed).toBe(true);
      expect(worker.stop).toHaveBeenCalled();
    });

    it("fails on validation failure without retrying", async () => {
      const harness = createTemporaryHarness("simple");
      const contract = makeContract();
      const worker: WorkerAdapter = {
        name: "simple-worker-fail",
        prepare: vi.fn().mockResolvedValue({ command: "npm", args: ["test"] }),
        execute: vi.fn().mockResolvedValue({ durationMs: 10, exitCode: 1 }),
        validate: vi.fn().mockResolvedValue({ passed: false, checks: [{ name: "unit", passed: false }] }),
        stop: vi.fn(),
      };

      const result = await harness.run(contract, worker);
      expect(result.status).toBe("failed");
      expect(result.rounds).toBe(1);
      expect(result.stopReason).toBe("one-shot-failed");
      expect(result.validation?.passed).toBe(false);
      expect(worker.prepare).toHaveBeenCalledTimes(1);
    });
  });

  describe("Medium complexity — worker + specialist tool + retry policy", () => {
    it("retries on initial failure and uses specialist tools", async () => {
      const toolSpy = vi.fn();
      const specialistTool: SpecialistTool = {
        name: "syntax-checker",
        execute: toolSpy,
      };

      const harness = createTemporaryHarness("medium", {
        specialistTools: [specialistTool],
        retryPolicy: { maxRetries: 2, backoffMs: 5 },
      });

      const contract = makeContract({
        worker: { modelTier: "standard", executionMode: "loop", maxRounds: 3 },
      });

      let attempt = 0;
      const worker: WorkerAdapter = {
        name: "medium-worker",
        prepare: vi.fn().mockResolvedValue({ command: "make", args: ["check"] }),
        execute: vi.fn().mockImplementation(async () => {
          attempt += 1;
          return { durationMs: 5, exitCode: attempt === 2 ? 0 : 1 };
        }),
        validate: vi.fn().mockImplementation(async (obs: WorkerObservation) => {
          return {
            passed: obs.exitCode === 0,
            checks: [{ name: "check-target", passed: obs.exitCode === 0 }],
          };
        }),
        stop: vi.fn(),
      };

      const result = await harness.run(contract, worker);
      expect(result.status).toBe("completed");
      expect(result.rounds).toBe(2);
      expect(result.stopReason).toBe("validation-passed");
      expect(toolSpy).toHaveBeenCalledTimes(2);
      expect(worker.prepare).toHaveBeenCalledTimes(2);
      expect(worker.stop).toHaveBeenCalledTimes(1);
    });

    it("exhausts retries and returns failed if validation never passes", async () => {
      const harness = createTemporaryHarness("medium", {
        retryPolicy: { maxRetries: 1 },
      });

      const contract = makeContract();
      const worker: WorkerAdapter = {
        name: "failing-worker",
        prepare: vi.fn().mockResolvedValue({ command: "flakey", args: [] }),
        execute: vi.fn().mockResolvedValue({ durationMs: 2, exitCode: 1 }),
        validate: vi.fn().mockResolvedValue({ passed: false, checks: [{ name: "always-fails", passed: false }] }),
        stop: vi.fn(),
      };

      const result = await harness.run(contract, worker);
      expect(result.status).toBe("failed");
      expect(result.rounds).toBe(2); // Initial round + 1 retry
      expect(result.stopReason).toBe("max-retries-exhausted");
    });
  });

  describe("Complex complexity — task-specific temporary harness", () => {
    it("assembles context planning, dynamic sub-agents, tools, and validates correctly", async () => {
      const contextPlanner = vi.fn().mockResolvedValue({
        requiredAnchors: ["core/kernel.ts", "config.json"],
        maxTokens: 16000,
        dynamicDirectives: ["prioritize-stability"],
      });

      const subAgent1: DynamicSubAgent = {
        id: "arch-reviewer",
        role: "Architecture Reviewer",
        run: vi.fn().mockResolvedValue({ approved: true, score: 98 }),
        stop: vi.fn(),
      };

      const tool1: SpecialistTool = {
        name: "graph-analyzer",
        execute: vi.fn().mockResolvedValue({ nodes: 12 }),
        dispose: vi.fn(),
      };

      const harness = createTemporaryHarness("complex", {
        contextPlanner,
        subAgents: [subAgent1],
        specialistTools: [tool1],
        budgetCapMs: 5000,
      });

      const contract = makeContract({
        signals: { taskComplexity: "complex", executionMode: "llm", fusedStepCount: 3, similarEpisodeCount: 1 },
        worker: { modelTier: "heavy", executionMode: "loop", maxRounds: 2 },
      });

      const worker: WorkerAdapter = {
        name: "complex-worker",
        prepare: vi.fn().mockResolvedValue({ command: "vitest", args: ["run"] }),
        execute: vi.fn().mockResolvedValue({ durationMs: 15, exitCode: 0 }),
        validate: vi.fn().mockResolvedValue({ passed: true, checks: [{ name: "all-tests", passed: true }] }),
        stop: vi.fn(),
      };

      const result = await harness.run(contract, worker);
      expect(result.status).toBe("completed");
      expect(result.complexity).toBe("complex");
      expect(result.contextPlan?.requiredAnchors).toEqual(["core/kernel.ts", "config.json"]);
      expect(result.subAgentOutputs?.["arch-reviewer"]).toEqual({ approved: true, score: 98 });
      expect(contextPlanner).toHaveBeenCalledWith(contract.taskId);
      expect(subAgent1.run).toHaveBeenCalledTimes(1);
      expect(tool1.execute).toHaveBeenCalledTimes(1);
      expect(result.stopReason).toBe("validation-passed");
    });

    it("respects strict budget cap and marks budget-exhausted", async () => {
      const harness = createTemporaryHarness("complex", {
        budgetCapMs: 30, // tiny budget
      });

      const contract = makeContract();
      const worker: WorkerAdapter = {
        name: "slow-worker",
        prepare: vi.fn().mockResolvedValue({ command: "sleep", args: ["1"] }),
        execute: vi.fn().mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { durationMs: 50, exitCode: 1 };
        }),
        validate: vi.fn().mockResolvedValue({ passed: false, checks: [{ name: "pending", passed: false }] }),
        stop: vi.fn(),
      };

      const result = await harness.run(contract, worker);
      expect(result.status).toBe("budget-exhausted");
      expect(result.stopReason).toBe("budget-exhausted");
    });

    it("evaluates custom stop conditions to abort early", async () => {
      const harness = createTemporaryHarness("complex", {
        stopConditions: [
          (ctx) => ctx.rounds >= 1, // Stop after round 1 regardless of validation
        ],
      });

      const contract = makeContract();
      const worker: WorkerAdapter = {
        name: "loop-worker",
        prepare: vi.fn().mockResolvedValue({ command: "check", args: [] }),
        execute: vi.fn().mockResolvedValue({ durationMs: 5, exitCode: 1 }),
        validate: vi.fn().mockResolvedValue({ passed: false, checks: [{ name: "fail", passed: false }] }),
        stop: vi.fn(),
      };

      const result = await harness.run(contract, worker);
      expect(result.status).toBe("stopped");
      expect(result.stopReason).toBe("stop-condition-triggered");
      expect(result.rounds).toBe(1);
    });
  });

  describe("Lifecycle and safe resource teardown", () => {
    it("disposes sub-agents, tools, and onDispose hook safely", async () => {
      const toolDispose = vi.fn();
      const subAgentDispose = vi.fn();
      const onDisposeHook = vi.fn();

      const tool: SpecialistTool = {
        name: "tool-to-clean",
        execute: vi.fn(),
        dispose: toolDispose,
      };

      const subAgent: DynamicSubAgent = {
        id: "sub-to-clean",
        role: "Cleaner",
        run: vi.fn(),
        dispose: subAgentDispose,
      };

      const harness = createTemporaryHarness("complex", {
        specialistTools: [tool],
        subAgents: [subAgent],
        onDispose: onDisposeHook,
      });

      expect(harness.isDisposed).toBe(false);
      await harness.dispose();
      expect(harness.isDisposed).toBe(true);

      expect(toolDispose).toHaveBeenCalledTimes(1);
      expect(subAgentDispose).toHaveBeenCalledTimes(1);
      expect(onDisposeHook).toHaveBeenCalledTimes(1);

      // Subsequent dispose calls are safe no-ops
      await harness.dispose();
      expect(toolDispose).toHaveBeenCalledTimes(1);
    });

    it("throws error when trying to run on disposed harness", async () => {
      const harness = createTemporaryHarness("simple");
      await harness.dispose();

      const contract = makeContract();
      await expect(harness.run(contract)).rejects.toThrow("Cannot run disposed harness");
    });
  });
});
