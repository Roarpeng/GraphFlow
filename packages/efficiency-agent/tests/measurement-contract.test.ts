import { describe, expect, it } from "vitest";
import {
  estimated,
  isStrongerOrEqual,
  measured,
  proxy,
  sumMeasurements,
  validateMeasurement,
  weakestProvenance,
} from "../src/measurement";
import {
  assertAdvisoryCompatible,
  type ExecutionContractV1,
} from "../src/contract";
import {
  validateTraceProvenance,
  type TaskTrace,
} from "../src/trace";

describe("measurement contract (R1–R5)", () => {
  it("measured values reject method and confidence", () => {
    expect(validateMeasurement("x", measured(3))).toEqual([]);
    expect(validateMeasurement("x", { value: 3, provenance: "measured", method: "clock" })).toContain(
      "x: measured values do not carry a method"
    );
    expect(
      validateMeasurement("x", { value: 3, provenance: "measured", confidence: 0.9 })
    ).toContain("x: measured values do not carry confidence");
  });

  it("estimated/proxy values require a method string", () => {
    expect(validateMeasurement("x", estimated(1200, "chars/4"))).toEqual([]);
    expect(validateMeasurement("x", proxy(5, "host-telemetry", 0.6))).toEqual([]);
    expect(
      validateMeasurement("x", { value: 5, provenance: "proxy" })
    ).toContain("x: proxy values require a method string");
    expect(
      validateMeasurement("x", estimated(5, "chars/4", 1.5))
    ).toContain("x: confidence must be within 0..1");
  });

  it("aggregation inherits the weakest provenance (R5)", () => {
    expect(weakestProvenance(["measured", "estimated", "proxy"])).toBe("proxy");
    expect(weakestProvenance(["measured", "estimated"])).toBe("estimated");
    expect(isStrongerOrEqual("measured", "estimated")).toBe(true);
    expect(isStrongerOrEqual("proxy", "estimated")).toBe(false);
    const summed = sumMeasurements(
      [measured(100), estimated(50, "chars/4")],
      "sum-of-inputs"
    );
    expect(summed).toEqual({ value: 150, provenance: "estimated", method: "sum-of-inputs" });
  });
});

describe("task trace provenance gate (R6)", () => {
  const baseTrace: TaskTrace = {
    schemaVersion: "1.0",
    traceId: "trace-1",
    task: { text: "fix axis homing", category: "bugfix" },
    run: { worker: "claude-code", mode: "shadow", startedAt: "2026-09-30T00:00:00.000Z" },
    context: { tokens: measured(3200), anchors: 5, cacheHit: false },
    llm: { calls: measured(3), totalTokens: proxy(9000, "host-telemetry", 0.5) },
    tools: [{ name: "grep", calls: measured(4) }],
    rounds: measured(1),
    validation: [{ name: "build", passed: true }],
    result: { success: true },
    decision: {
      reuseMode: "ADAPT",
      durationMs: measured(2),
      llmCalls: measured(0),
    },
  };

  it("a fully provenance-clean trace passes the gate", () => {
    expect(validateTraceProvenance(baseTrace)).toEqual([]);
  });

  it("a bare-number cost field disguised as measurement is refused", () => {
    const dirty: TaskTrace = {
      ...baseTrace,
      llm: {
        calls: { value: 3, provenance: "estimated" }, // no method
      },
    };
    expect(validateTraceProvenance(dirty)).toContain("llm.calls: estimated values require a method string");
  });

  it("decision cost violations surface under decision.*", () => {
    const dirty: TaskTrace = {
      ...baseTrace,
      decision: {
        reuseMode: "FRESH",
        durationMs: { value: 2, provenance: "measured", confidence: 0.9 },
        llmCalls: measured(0),
      },
    };
    expect(validateTraceProvenance(dirty)).toContain(
      "decision.durationMs: measured values do not carry confidence"
    );
  });
});

describe("execution contract compatibility gate", () => {
  const valid: ExecutionContractV1 = {
    schemaVersion: "1.0",
    taskId: "task:abc123",
    mode: "shadow",
    reuseMode: "FRESH",
    confidence: 0.5,
    signals: {
      taskComplexity: "simple",
      executionMode: "bridge",
      fusedStepCount: 2,
      similarEpisodeCount: 0,
    },
    context: { source: "graphflow", requiredAnchors: [] },
    worker: { modelTier: "economy", executionMode: "one-shot", maxRounds: 1 },
    validation: [],
    decision: { provenance: "deterministic", llmCalls: 0, durationMs: 1 },
  };

  it("accepts the substrate advisory shape", () => {
    expect(assertAdvisoryCompatible(valid)).toEqual([]);
  });

  it("refuses a deterministic decision that bills LLM calls", () => {
    const lying: unknown = {
      ...valid,
      decision: { provenance: "deterministic", llmCalls: 2, durationMs: 1 },
    };
    expect(assertAdvisoryCompatible(lying)).toContain(
      "decision: deterministic provenance must bill 0 llmCalls"
    );
  });

  it("refuses garbage", () => {
    expect(assertAdvisoryCompatible("trust me")).toEqual(["advisory: not an object"]);
    expect(assertAdvisoryCompatible({}).length).toBeGreaterThan(5);
  });
});
