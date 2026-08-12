import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATP_MINIMAL_PRODUCER_PROTOCOL,
  buildMinimalSimplePlanWorkItems,
  buildOptionalMemoryWorkItems,
  buildRequiredSimplePlanWorkItems,
} from "../src/agents/atp-example-producer";
import { SIMPLE_PLAN_BRIDGE_REQUIRED_IDS } from "../src/core/agent-delegation";

describe("ATP/IR v1.2 conformance", () => {
  it("spec status marks atp-ir/1.2 Stable with §8 memory increment", () => {
    const spec = readFileSync(join(process.cwd(), "docs/atp-ir-spec-v1.md"), "utf8");
    expect(spec).toMatch(/Protocol version:\s*`atp-ir\/1\.2`/);
    expect(spec).toContain("Status: **Stable**");
    expect(spec).toContain("memory-recall");
    expect(spec).toContain("memory-backfill");
    expect(spec).toContain("requirementIds");
    expect(spec).toContain("conceptIds");
    expect(spec).toContain("codeHints");
  });

  it("optional memory markers match §8 registry shapes", () => {
    const items = buildOptionalMemoryWorkItems();
    expect(items.map((i) => i.id)).toEqual(["memory-recall", "memory-backfill"]);
    for (const item of items) {
      expect(item.kind).toBe("memory");
      expect(item.optional).toBe(true);
      expect(item.expectedFormat).toBe("json");
      expect(item.responseSchema).toBeTruthy();
    }
  });

  it("minimal producer defaults to atp-ir/1.2 with required + optional memory items", () => {
    expect(ATP_MINIMAL_PRODUCER_PROTOCOL).toBe("atp-ir/1.2");
    const items = buildMinimalSimplePlanWorkItems("conformance task");
    const ids = items.map((i) => i.id);
    for (const id of SIMPLE_PLAN_BRIDGE_REQUIRED_IDS) {
      expect(ids).toContain(id);
    }
    expect(ids).toContain("alignment-check");
    expect(ids).toContain("memory-recall");
    expect(ids).toContain("memory-backfill");

    // v1.1 consumers ignore unknown optional items — required-only set unchanged
    const required = buildRequiredSimplePlanWorkItems("conformance task");
    expect(required.map((i) => i.id)).toEqual([...SIMPLE_PLAN_BRIDGE_REQUIRED_IDS]);
  });

  it("fixture.work-items.json stays aligned with producer protocol", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(process.cwd(), "examples/atp-minimal-producer/fixture.work-items.json"),
        "utf8"
      )
    ) as { protocol: string; agentWorkItems: Array<{ id: string; optional?: boolean }> };
    expect(fixture.protocol).toBe("atp-ir/1.2");
    const ids = fixture.agentWorkItems.map((i) => i.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "simple-plan-intent",
        "simple-plan-decomposition",
        "alignment-check",
        "memory-recall",
        "memory-backfill",
      ])
    );
    const memory = fixture.agentWorkItems.filter((i) =>
      i.id.startsWith("memory-")
    );
    expect(memory.every((i) => i.optional === true)).toBe(true);
  });
});
