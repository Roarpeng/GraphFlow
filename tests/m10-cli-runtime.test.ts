import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexGraph, previewContext, runTask } from "../src/surfaces/cli/runtime";

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

  it("indexes graph from a workspace path", async () => {
    const root = mkdtempSync(join(tmpdir(), "graphflow-cli-index-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "demo.ts"), "export function demo() { return 1; }", "utf8");
      const result = await indexGraph(root);
      expect(result.indexedFiles).toBeGreaterThanOrEqual(1);
      expect(result.indexedSymbols).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
