import { describe, expect, it } from "vitest";
import { buildEfficiencyAdvisory } from "../src/core/efficiency-advisory";
import { assertAdvisoryCompatible } from "../packages/efficiency-agent/src/contract";

/**
 * Cross-boundary conformance: the substrate's graphflow_run advisory MUST
 * satisfy the efficiency-agent package's Execution Contract v1 gate. This is
 * the guard that keeps the two sides aligned without a runtime dependency —
 * the package consumes advisory JSON over MCP; if the substrate drifts out of
 * contract, this test fails before any benchmark trusts the advisory.
 */
describe("advisory ↔ execution-contract v1 conformance", () => {
  it("a built advisory passes the package's compatibility gate", () => {
    const advisory = buildEfficiencyAdvisory({
      task: "修复 axis 回零异常 并 验证 build",
      taskComplexity: "complex",
      executionMode: "bridge",
      fusedSteps: [
        { id: "s1", action: "edit", target: "src/motion.ts" },
        { id: "s2", action: "validate", command: "npm run build" },
      ],
      similarEpisodes: [{ id: "ep1", task: "修复 axis 异常", score: 0.7 }],
      maxContextTokens: 3200,
      durationMs: 2,
    });
    expect(assertAdvisoryCompatible(advisory)).toEqual([]);
    expect(advisory.reuseMode).toBe("ADAPT");
    expect(advisory.worker.modelTier).toBe("standard");
  });

  it("the simple-task path also conforms (FRESH / economy / one-shot)", () => {
    const advisory = buildEfficiencyAdvisory({
      task: "where is the model router configured",
      taskComplexity: "simple",
      executionMode: "bridge",
      durationMs: 1,
    });
    expect(assertAdvisoryCompatible(advisory)).toEqual([]);
    expect(advisory.reuseMode).toBe("FRESH");
    expect(advisory.worker).toEqual({
      modelTier: "economy",
      executionMode: "one-shot",
      maxRounds: 1,
    });
  });

  it("JSON round-trip through the MCP boundary preserves conformance", () => {
    const advisory = buildEfficiencyAdvisory({
      task: "refactor context slicer",
      taskComplexity: "complex",
      executionMode: "llm",
      durationMs: 0,
    });
    // The advisory crosses the MCP wire as JSON — contract validity must
    // survive serialization.
    const overTheWire: unknown = JSON.parse(JSON.stringify(advisory));
    expect(assertAdvisoryCompatible(overTheWire)).toEqual([]);
  });
});
