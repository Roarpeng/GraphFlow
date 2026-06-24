import { describe, it, expect } from "vitest";
import { runSimpleTask } from "../src/core/state-machine";
import { validateTaskResult } from "../src/agents/validator";

describe("M43 bridge mode and validation fixes", () => {
  // ── Task 1: Bridge mode returns executionDescriptor ──────────────────
  describe("Bridge mode execution", () => {
    it("should return DELEGATED with executionDescriptor in bridge mode", async () => {
      const result = await runSimpleTask({
        task: "refactor authentication module",
        executionMode: "bridge",
        workerContext: {
          summaryChannel: ["module: auth.ts exports login()"],
          skillHints: ["refactor-safely"],
        },
      });

      expect(result.status).toBe("DELEGATED");
      expect(result.feedback).toContain("[DELEGATED]");
      expect(result.executionDescriptor).toBeDefined();
      expect(result.executionDescriptor?.action).toBe("execute");
      expect(result.executionDescriptor?.task).toBe("refactor authentication module");
      expect(result.executionDescriptor?.context).toContain("summaryChannel");
      expect(result.executionDescriptor?.retryHints).toEqual([]);
    });

    it("should skip execution loop in bridge mode", async () => {
      const result = await runSimpleTask({
        task: "add tests",
        executionMode: "bridge",
        maxRetries: 5,
      });

      // Bridge mode returns immediately without attempts
      expect(result.attempts).toBe(0);
      expect(result.executionDescriptor).toBeDefined();
    });
  });

  // ── Task 2: Validator marks heuristic validation ──────────────────
  describe("Validator heuristic tagging", () => {
    it("should mark rule-based validation as heuristic", () => {
      const result = validateTaskResult(
        "update readme and add tests",
        "Updated README.md with architecture section and added unit tests"
      );

      expect(result.passed).toBe(true);
      expect(result.feedback).toContain("[heuristic]");
      expect(result.riskTags).toContain("heuristic_validation");
    });

    it("should reject provider placeholder output", () => {
      const result = validateTaskResult(
        "implement feature",
        "[openai:gpt-4o] implement feature"
      );

      expect(result.passed).toBe(false);
      expect(result.feedback).toContain("placeholder");
      expect(result.riskTags).toContain("placeholder_output");
    });

    it("should detect anthropic fallback format", () => {
      const result = validateTaskResult(
        "fix bug",
        "[anthropic:claude-3] fix bug in auth module"
      );

      expect(result.passed).toBe(false);
      expect(result.riskTags).toContain("placeholder_output");
    });

    it("should mark failed validation as heuristic", () => {
      const result = validateTaskResult("update readme", "unrelated output");

      expect(result.passed).toBe(false);
      expect(result.feedback).toContain("[heuristic]");
      expect(result.riskTags).toContain("heuristic_validation");
    });
  });

  // ── Task 3: No fake COMPLETED without real execution ──────────────
  describe("No fake success without execution", () => {
    it("should not return COMPLETED in bridge mode", async () => {
      const result = await runSimpleTask({
        task: "complex refactor",
        executionMode: "bridge",
      });

      expect(result.status).not.toBe("COMPLETED");
      expect(result.status).toBe("DELEGATED");
      expect(result.feedback).toContain("DELEGATED");
    });

    it("should include executionDescriptor when delegating", async () => {
      const result = await runSimpleTask({
        task: "migrate database",
        executionMode: "bridge",
      });

      expect(result.executionDescriptor).toBeDefined();
      expect(result.executionDescriptor?.task).toBe("migrate database");
    });
  });
});
