import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { projectToolResult } from "../src/observations/host-hook";
import { recallObservation } from "../src/observations/index";

const root = mkdtempSync(join(tmpdir(), "graphflow-host-hook-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const enabled = { enabled: true, inlineThresholdBytes: 64, headBytes: 32, tailBytes: 32 };

describe("host tool-result projection hook", () => {
  it("leaves the text untouched when the mechanism is disabled", async () => {
    const result = await projectToolResult(
      { tool: "bash", text: "x".repeat(500) },
      { rootDir: root, policy: { enabled: false } }
    );
    expect(result.archived).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(result.projected).toBe("x".repeat(500));
  });

  it("leaves small results inline", async () => {
    const result = await projectToolResult({ tool: "bash", text: "short" }, { rootDir: root, policy: enabled });
    expect(result.archived).toBe(false);
    expect(result.reason).toBe("below-threshold");
    expect(result.projected).toBe("short");
  });

  it("archives a large result, returns a handle projection, and recalls exact bytes", async () => {
    const full = ["line a", "line b", ...Array.from({ length: 40 }, (_, i) => "log line " + i)].join("\n");
    const result = await projectToolResult({ tool: "bash", text: full }, { rootDir: root, policy: enabled });
    expect(result.archived).toBe(true);
    expect(result.handle).toMatch(/^gfo:/);
    // The head/tail excerpts keep the ends; the middle is dropped.
    expect(result.projected.length).toBeLessThan(full.length);
    expect(result.projected).not.toContain("log line 20");
    expect(result.projected).toContain(result.handle!);

    const recalled = await recallObservation({ rootDir: root, handle: result.handle! });
    expect(recalled.expired).toBe(false);
    if (!recalled.expired) {
      expect(recalled.content).toBe(full);
    }
  });

  it("fails open when the store cannot be written", async () => {
    const filePath = join(root, "not-a-dir");
    writeFileSync(filePath, "blocker", "utf8");
    const result = await projectToolResult(
      { tool: "bash", text: "x".repeat(500) },
      { rootDir: filePath, policy: enabled }
    );
    expect(result.archived).toBe(false);
    expect(result.projected).toBe("x".repeat(500));
  });
});
