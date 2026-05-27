import { describe, expect, it } from "vitest";
import { runSimpleTask, type RunInput } from "../src/core/state-machine";
import { resolveModelForRole } from "../src/routing/model-router";
import { validateTaskResult } from "../src/agents/validator";

describe("M1 bootstrap behavior", () => {
  it("routes planner to smart tier by default", () => {
    const model = resolveModelForRole("planner");
    expect(model.tier).toBe("smart");
  });

  it("routes worker to economy tier by default", () => {
    const model = resolveModelForRole("worker");
    expect(model.tier).toBe("economy");
  });

  it("validator fails empty output", () => {
    const result = validateTaskResult("update readme", "");
    expect(result.passed).toBe(false);
  });

  it("simple pipeline finishes completed when worker returns output", async () => {
    const input: RunInput = { task: "update readme", workerOutput: "applied diff" };
    const run = await runSimpleTask(input);
    expect(run.status).toBe("COMPLETED");
    expect(run.attempts).toBe(1);
  });

  it("simple pipeline enters human review after retry limit", async () => {
    const input: RunInput = { task: "update readme", workerOutput: "", maxRetries: 2 };
    const run = await runSimpleTask(input);
    expect(run.status).toBe("HUMAN_REVIEW_REQUIRED");
    expect(run.attempts).toBe(2);
  });
});
