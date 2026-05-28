import { describe, expect, it } from "vitest";
import { previewContext, runTask } from "../src/surfaces/cli/runtime";

describe("M10 CLI runtime", () => {
  it("runs task and returns standard output line", async () => {
    const output = await runTask("update readme");
    expect(output).toContain("status=");
    expect(output).toContain("feedback=");
  });

  it("returns context preview stats", async () => {
    const preview = await previewContext("orchestrate");
    expect(preview.summaryCount).toBeGreaterThanOrEqual(0);
    expect(preview.anchorCount).toBeGreaterThanOrEqual(0);
    expect(preview.tokenEstimate).toBeGreaterThanOrEqual(0);
    expect(preview.anchorsByLayer.l1).toBeGreaterThanOrEqual(0);
  });
});
