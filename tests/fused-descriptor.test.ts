import { describe, expect, it } from "vitest";
import {
  buildFusedSteps,
  enrichExecutionDescriptor,
  type FusedStep,
  type PlanNodeLike,
} from "../src/core/fused-descriptor";

describe("buildFusedSteps", () => {
  it("returns [] for an empty or missing plan", () => {
    expect(buildFusedSteps({ task: "anything", planNodes: [] })).toEqual([]);
    expect(buildFusedSteps({ task: "anything" })).toEqual([]);
  });

  it("fuses an edit step with an immediately following validate step into one unit", () => {
    const planNodes: PlanNodeLike[] = [
      { id: "n1", description: "edit src/a.ts" },
      { id: "n2", description: "validate the change" },
    ];
    const steps = buildFusedSteps({ task: "t", planNodes });
    expect(steps).toEqual([
      {
        id: "step:n1+n2",
        action: "edit",
        target: "edit src/a.ts",
        command: "validate the change",
      },
    ]);
  });

  it("fuses edit+run and keeps later steps ordered after the fusion unit", () => {
    const planNodes: PlanNodeLike[] = [
      { id: "n1", description: "edit src/a.ts" },
      { id: "n2", description: "run npm test" },
      { id: "n3", description: "validate the build", dependencies: ["n2"] },
    ];
    const steps = buildFusedSteps({ task: "t", planNodes });
    expect(steps.map((s) => s.id)).toEqual(["step:n1+n2", "step:n3"]);
    expect(steps[0]).toMatchObject({ action: "edit", command: "run npm test" });
    expect(steps[1]).toMatchObject({ action: "validate", dependsOn: ["step:n1+n2"] });
  });

  it("does not fuse when an edit is not immediately followed by run/validate", () => {
    const planNodes: PlanNodeLike[] = [
      { id: "n1", description: "run npm test" },
      { id: "n2", description: "edit src/a.ts" },
    ];
    const steps = buildFusedSteps({ task: "t", planNodes });
    expect(steps).toEqual([
      { id: "step:n1", action: "run", command: "run npm test" },
      { id: "step:n2", action: "edit", target: "edit src/a.ts" },
    ]);
  });

  it("is deterministic: two calls produce deeply equal output", () => {
    const planNodes: PlanNodeLike[] = [
      { id: "n1", description: "edit src/a.ts" },
      { id: "n2", description: "build the project" },
      { id: "n3", description: "verify output", dependencies: ["n1"] },
    ];
    const first = buildFusedSteps({ task: "t", planNodes });
    const second = buildFusedSteps({ task: "t", planNodes });
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("deduplicates identical steps, keeping the first occurrence", () => {
    const planNodes: PlanNodeLike[] = [
      { id: "n1", description: "edit src/a.ts" },
      { id: "n2", description: "edit src/a.ts" },
    ];
    const steps = buildFusedSteps({ task: "t", planNodes });
    expect(steps).toEqual([{ id: "step:n1", action: "edit", target: "edit src/a.ts" }]);
  });

  it("skips nodes with no recognizable action keyword", () => {
    const planNodes: PlanNodeLike[] = [
      { id: "n1", description: "ponder the architecture" },
      { id: "n2", description: "edit src/a.ts" },
    ];
    const steps = buildFusedSteps({ task: "t", planNodes });
    expect(steps.map((s) => s.id)).toEqual(["step:n2"]);
  });
});

describe("enrichExecutionDescriptor", () => {
  const steps: FusedStep[] = [
    { id: "step:n1+n2", action: "edit", target: "edit src/a.ts", command: "run npm test" },
  ];

  it("returns a new object with steps attached and fused=true", () => {
    const descriptor = Object.freeze({ action: "execute", task: "t", retryHints: [] as string[] });
    const enriched = enrichExecutionDescriptor(descriptor, steps);
    expect(enriched).not.toBe(descriptor);
    expect(enriched.action).toBe("execute");
    expect(enriched.fused).toBe(true);
    expect(enriched.steps).toEqual(steps);
    // Freezing the input proves the call cannot mutate it (would throw in strict mode).
  });

  it("sets fused=false and does not mutate the descriptor when steps are empty", () => {
    const descriptor = Object.freeze({ action: "execute", task: "t" });
    const enriched = enrichExecutionDescriptor(descriptor, []);
    expect(enriched.fused).toBe(false);
    expect(enriched.steps).toEqual([]);
    expect(descriptor).toEqual({ action: "execute", task: "t" });
  });

  it("defensively copies steps so later mutation of the input array is not visible", () => {
    const mutable: FusedStep[] = [
      { id: "step:n1", action: "run", command: "run npm test", dependsOn: ["step:n0"] },
    ];
    const enriched = enrichExecutionDescriptor({ task: "t" }, mutable);
    mutable.push({ id: "step:late", action: "validate", command: "check" });
    mutable[0]?.dependsOn?.push("step:mutated");
    expect(enriched.steps).toHaveLength(1);
    expect(enriched.steps[0]?.dependsOn).toEqual(["step:n0"]);
  });
});
