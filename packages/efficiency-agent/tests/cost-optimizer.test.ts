import { describe, expect, it } from "vitest";
import { buildCost, costFromNumbers } from "../src/cost/model";
import { chooseAction } from "../src/cost/optimizer";
import { estimated, measured, proxy, validateMeasurement } from "../src/measurement";
import type { ActionCandidate } from "../src/domain";

function candidate(
  id: string,
  costValue: number,
  expectedSuccessRate: number,
  expectedFidelity: number,
  safety: number,
  evidence: number
): ActionCandidate {
  return {
    id,
    cost: measured(costValue),
    expectedSuccessRate,
    expectedFidelity,
    safety,
    evidence,
  };
}

describe("cost model aggregation (plan §20)", () => {
  it("mixed provenance: total sums values, inherits the weakest provenance, carries a method", () => {
    const breakdown = buildCost([
      { name: "llm-calls", measurement: measured(3) },
      { name: "context-tokens", measurement: estimated(1200, "chars/4") },
      { name: "tool-tokens", measurement: proxy(400, "host-telemetry", 0.5) },
    ]);
    expect(breakdown.components).toHaveLength(3);
    expect(breakdown.total.value).toBe(1603);
    expect(breakdown.total.provenance).toBe("proxy");
    expect(breakdown.total.method).toBe("sum-of-components");
    expect(validateMeasurement("total", breakdown.total)).toEqual([]);
  });

  it("all-measured: total is measured and carries no method (R2)", () => {
    const breakdown = buildCost([
      { name: "a", measurement: measured(100) },
      { name: "b", measurement: measured(200) },
    ]);
    expect(breakdown.total).toEqual({ value: 300, provenance: "measured" });
    expect(validateMeasurement("total", breakdown.total)).toEqual([]);
  });

  it("empty components: total is measured 0", () => {
    const breakdown = buildCost([]);
    expect(breakdown.total).toEqual({ value: 0, provenance: "measured" });
    expect(breakdown.components).toEqual([]);
  });

  it("estimated-only mix: total is estimated with a method", () => {
    const breakdown = buildCost([
      { name: "a", measurement: estimated(1, "chars/4") },
      { name: "b", measurement: estimated(2, "chars/4") },
    ]);
    expect(breakdown.total).toEqual({
      value: 3,
      provenance: "estimated",
      method: "sum-of-components",
    });
  });

  it("does not alias the caller's measurement objects", () => {
    const original = measured(7);
    const breakdown = buildCost([{ name: "a", measurement: original }]);
    expect(breakdown.components[0]).not.toBe(original);
  });

  it("costFromNumbers stamps provenance and method on components", () => {
    const breakdown = costFromNumbers(
      [
        ["llm", 3],
        ["context", 2],
      ],
      "estimated",
      "chars/4"
    );
    expect(breakdown.components).toEqual([
      { value: 3, provenance: "estimated", method: "chars/4" },
      { value: 2, provenance: "estimated", method: "chars/4" },
    ]);
    expect(breakdown.total).toEqual({
      value: 5,
      provenance: "estimated",
      method: "sum-of-components",
    });
  });

  it("costFromNumbers omits the method for measured provenance (R2)", () => {
    const breakdown = costFromNumbers([["llm", 1]], "measured", "unused-for-measured");
    expect(breakdown.components).toEqual([{ value: 1, provenance: "measured" }]);
    expect(breakdown.total).toEqual({ value: 1, provenance: "measured" });
  });
});

describe("cost-aware optimizer (plan §20)", () => {
  it("picks the cheapest survivor among floor-passing candidates", () => {
    const decision = chooseAction(
      [
        candidate("expensive", 10, 0.9, 0.9, 0.9, 0.9),
        candidate("cheap", 4, 0.9, 0.9, 0.9, 0.9),
        candidate("dirt-cheap-but-risky", 1, 0.1, 0.9, 0.9, 0.9),
      ],
      { minSuccessRate: 0.5 }
    );
    expect(decision.chosen?.id).toBe("cheap");
    expect(decision.rejected).toEqual([
      { id: "dirt-cheap-but-risky", reason: "success-rate-below-floor" },
    ]);
  });

  it("reports only the FIRST violated floor as the rejection reason", () => {
    const decision = chooseAction(
      [candidate("terrible", 1, 0.1, 0.2, 0.3, 0.4)],
      { minSuccessRate: 0.8, minFidelity: 0.8, minSafety: 0.8, minEvidence: 0.8 }
    );
    expect(decision.chosen).toBeUndefined();
    expect(decision.rejected).toEqual([
      { id: "terrible", reason: "success-rate-below-floor" },
    ]);
  });

  it("names each individual floor in its rejection reason", () => {
    expect(
      chooseAction([candidate("f", 1, 0.9, 0.1, 0.9, 0.9)], { minFidelity: 0.5 }).rejected
    ).toEqual([{ id: "f", reason: "fidelity-below-floor" }]);
    expect(
      chooseAction([candidate("s", 1, 0.9, 0.9, 0.1, 0.9)], { minSafety: 0.5 }).rejected
    ).toEqual([{ id: "s", reason: "safety-below-floor" }]);
    expect(
      chooseAction([candidate("e", 1, 0.9, 0.9, 0.9, 0.1)], { minEvidence: 0.5 }).rejected
    ).toEqual([{ id: "e", reason: "evidence-below-floor" }]);
  });

  it("values exactly at the floor pass (>=)", () => {
    const decision = chooseAction(
      [candidate("edge", 1, 0.5, 0.5, 0.5, 0.5)],
      { minSuccessRate: 0.5, minFidelity: 0.5, minSafety: 0.5, minEvidence: 0.5 }
    );
    expect(decision.chosen?.id).toBe("edge");
    expect(decision.rejected).toEqual([]);
  });

  it("ties break by higher success rate, then lexically smaller id", () => {
    const bySuccess = chooseAction(
      [candidate("a", 5, 0.8, 0.9, 0.9, 0.9), candidate("c", 5, 0.95, 0.9, 0.9, 0.9)],
      {}
    );
    expect(bySuccess.chosen?.id).toBe("c");

    const byId = chooseAction(
      [candidate("bbb", 5, 0.8, 0.9, 0.9, 0.9), candidate("aaa", 5, 0.8, 0.9, 0.9, 0.9)],
      {}
    );
    expect(byId.chosen?.id).toBe("aaa");
  });

  it("all candidates rejected: chosen is undefined, every candidate is rejected", () => {
    const decision = chooseAction(
      [candidate("x", 1, 0.1, 0.9, 0.9, 0.9), candidate("y", 2, 0.9, 0.1, 0.9, 0.9)],
      { minSuccessRate: 0.5, minFidelity: 0.5 }
    );
    expect(decision.chosen).toBeUndefined();
    expect(decision.rejected).toEqual([
      { id: "x", reason: "success-rate-below-floor" },
      { id: "y", reason: "fidelity-below-floor" },
    ]);
  });

  it("undefined floor entries behave as 0", () => {
    const zeroed = chooseAction([candidate("zero", 1, 0, 0, 0, 0)], {});
    expect(zeroed.chosen?.id).toBe("zero");

    const partial = chooseAction([candidate("low", 1, 0.6, 0, 0, 0)], { minSuccessRate: 0.5 });
    expect(partial.chosen?.id).toBe("low");
  });

  it("no candidates: empty decision", () => {
    expect(chooseAction([], { minSuccessRate: 0.5 })).toEqual({ rejected: [] });
  });

  it("never mutates its inputs", () => {
    const candidates = [
      candidate("a", 5, 0.9, 0.9, 0.9, 0.9),
      candidate("b", 1, 0.1, 0.9, 0.9, 0.9),
    ];
    const floor = { minSuccessRate: 0.5 };
    const candidatesSnapshot = structuredClone(candidates);
    const floorSnapshot = structuredClone(floor);
    chooseAction(candidates, floor);
    expect(candidates).toEqual(candidatesSnapshot);
    expect(floor).toEqual(floorSnapshot);
  });

  it("the chosen candidate is a copy, not the caller's object", () => {
    const a = candidate("a", 1, 0.9, 0.9, 0.9, 0.9);
    const decision = chooseAction([a], {});
    expect(decision.chosen).toEqual(a);
    expect(decision.chosen).not.toBe(a);
  });
});
