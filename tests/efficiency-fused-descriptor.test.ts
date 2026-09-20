import { describe, expect, it } from "vitest";
import { buildFusedSteps, enrichExecutionDescriptor } from "../src/core/fused-descriptor";
import { buildExecutionDescriptor } from "../src/core/orchestrator-phases";
import { resolveEfficiencyPolicy } from "../src/config/resolve";

/**
 * GF-4 / Action Fusion delivery tests (test-level verification only — the
 * fused-descriptor assembly itself lives in src/core/fused-descriptor.ts).
 *
 * Contract under the best-by-default policy:
 * - resolveEfficiencyPolicy defaults actionFusion.enabled to true (an omitted
 *   or partial efficiencyPolicy section is not an explicit false);
 * - with the mechanism enabled, buildExecutionDescriptor's descriptor carries
 *   steps with fused:true, where an edit and its immediately following
 *   validation command collapse into one action unit.
 */

const planProjection = [
  { id: "t1", description: "Edit src/foo.ts to add the flag", dependencies: [] },
  { id: "t2", description: "Run the unit tests", dependencies: ["t1"] },
];

describe("buildFusedSteps", () => {
  it("collapses an edit followed by its validation command into one fused step", () => {
    const steps = buildFusedSteps({ task: "add flag", planNodes: planProjection });

    expect(steps).toHaveLength(1);
    const step = steps[0];
    // Two plan nodes consumed by one action unit: the fused id names both.
    expect(step.id).toBe("step:t1+t2");
    expect(step.action).toBe("edit");
    expect(step.target).toBe("Edit src/foo.ts to add the flag");
    expect(step.command).toBe("Run the unit tests");
  });

  it("keeps standalone steps for plans without an edit+validate adjacency", () => {
    const steps = buildFusedSteps({
      task: "investigate",
      planNodes: [
        { id: "a", description: "Investigate the failing import", dependencies: [] },
        { id: "b", description: "Summarize findings", dependencies: ["a"] },
      ],
    });
    expect(steps).toHaveLength(0);
  });

  it("derives deterministic, stable ids for the same input", () => {
    const first = buildFusedSteps({ task: "add flag", planNodes: planProjection });
    const second = buildFusedSteps({ task: "add flag", planNodes: planProjection });
    expect(first).toEqual(second);
  });
});

describe("enrichExecutionDescriptor", () => {
  it("marks the descriptor fused:true and attaches a defensive copy of the steps", () => {
    const steps = buildFusedSteps({ task: "add flag", planNodes: planProjection });
    const descriptor = enrichExecutionDescriptor({ action: "execute", task: "add flag" }, steps);

    expect(descriptor.fused).toBe(true);
    expect(descriptor.steps).toHaveLength(1);
    expect(descriptor.steps[0]).toMatchObject({ action: "edit", command: "Run the unit tests" });
    // Defensive copy: mutating the attached steps never reaches the source array.
    descriptor.steps.pop();
    expect(steps).toHaveLength(1);
  });

  it("reports fused:false when no step could be derived", () => {
    const descriptor = enrichExecutionDescriptor({ action: "execute", task: "x" }, []);
    expect(descriptor.fused).toBe(false);
    expect(descriptor.steps).toHaveLength(0);
  });
});

describe("buildExecutionDescriptor delivery (Action Fusion)", () => {
  it("attaches steps with fused:true when the mechanism is enabled", () => {
    const descriptor = buildExecutionDescriptor({
      task: "add flag",
      planProjection,
      agentAssignments: [],
      contextStr: "",
      retryHints: [],
      delegatedExtras: {},
      enableActionFusion: true,
    });

    expect(descriptor.fused).toBe(true);
    expect(descriptor.steps).toBeDefined();
    expect(descriptor.steps?.[0]).toMatchObject({
      id: "step:t1+t2",
      action: "edit",
      command: "Run the unit tests",
    });
  });

  it("omits steps when the mechanism is disabled", () => {
    const descriptor = buildExecutionDescriptor({
      task: "add flag",
      planProjection,
      agentAssignments: [],
      contextStr: "",
      retryHints: [],
      delegatedExtras: {},
    });

    expect(descriptor.steps).toBeUndefined();
    expect(descriptor.fused).toBeUndefined();
  });

  it("is enabled by the best-by-default policy an agent runs under", () => {
    // The routing layer projects exactly this flag; an omitted efficiencyPolicy
    // (and any partial section without an explicit false) must leave it on.
    expect(resolveEfficiencyPolicy(undefined).actionFusion.enabled).toBe(true);
    expect(resolveEfficiencyPolicy({ efficiencyPolicy: {} }).actionFusion.enabled).toBe(true);
    expect(
      resolveEfficiencyPolicy({ efficiencyPolicy: { observations: { enabled: false } } })
        .actionFusion.enabled
    ).toBe(true);
    expect(
      resolveEfficiencyPolicy({ efficiencyPolicy: { actionFusion: { enabled: false } } })
        .actionFusion.enabled
    ).toBe(false);
  });
});

it("fuses a plan-less Chinese bridge task's edit+validate clauses from the task text", () => {
  // The bridge path for simple tasks carries no plan nodes; the fused steps
  // must derive from the TASK TEXT itself ("…并验证" is an edit+validate pair).
  const steps = buildFusedSteps({ task: "修改 src/demo-store.ts 让 demoFn 返回 a+2 并验证" });
  expect(steps.length).toBe(1);
  expect(steps[0]?.id).toBe("step:task-1+task-2");
  expect(steps[0]?.action).toBe("edit");
  expect(steps[0]?.target).toContain("demoFn 返回 a+2");
  expect(steps[0]?.command).toBe("验证");
});
