import { describe, expect, it } from "vitest";
import {
  SIMPLE_PLAN_BRIDGE_REQUIRED_IDS,
  buildMinimalSimplePlanWorkItems,
  buildRequiredSimplePlanWorkItems,
  buildOptionalMemoryWorkItems,
} from "../src/agents/atp-example-producer";

describe("atp-minimal-producer (simple-plan work items)", () => {
  it("emits stable required ids, kinds, and expectedFormat json", () => {
    const task = "Add a cache layer for the tokenizer";
    const items = buildMinimalSimplePlanWorkItems(task);

    const byId = new Map(items.map((i) => [i.id, i]));
    for (const id of SIMPLE_PLAN_BRIDGE_REQUIRED_IDS) {
      expect(byId.has(id)).toBe(true);
      const item = byId.get(id)!;
      expect(item.expectedFormat).toBe("json");
      expect(item.prompt).toContain(task);
      expect(item.responseSchema).toBeTruthy();
      expect(typeof item.responseSchema).toBe("object");
    }

    expect(byId.get("simple-plan-intent")!.kind).toBe("intent");
    expect(byId.get("simple-plan-decomposition")!.kind).toBe("plan-refinement");

    const alignment = byId.get("alignment-check");
    expect(alignment).toBeDefined();
    expect(alignment!.kind).toBe("alignment");
    expect(alignment!.optional).toBe(true);
    expect(alignment!.expectedFormat).toBe("json");
  });

  it("includes optional atp-ir/1.2 memory markers by default", () => {
    const items = buildMinimalSimplePlanWorkItems("ship feature");
    const recall = items.find((i) => i.id === "memory-recall");
    const backfill = items.find((i) => i.id === "memory-backfill");
    expect(recall?.kind).toBe("memory");
    expect(recall?.optional).toBe(true);
    expect(backfill?.kind).toBe("memory");
    expect(backfill?.optional).toBe(true);

    const without = buildMinimalSimplePlanWorkItems("ship feature", {
      includeMemoryItems: false,
    });
    expect(without.some((i) => i.id.startsWith("memory-"))).toBe(false);
    expect(buildOptionalMemoryWorkItems()).toHaveLength(2);
  });

  it("required-only helper omits optional alignment-check and memory markers", () => {
    const required = buildRequiredSimplePlanWorkItems("ship feature X");
    expect(required.map((i) => i.id)).toEqual([...SIMPLE_PLAN_BRIDGE_REQUIRED_IDS]);
    expect(required.every((i) => i.expectedFormat === "json")).toBe(true);
  });
});
