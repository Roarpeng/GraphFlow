import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openVsxHasVersion } from "../scripts/publish-openvsx-idempotent.mjs";

describe("Open VSX idempotent publish helper", () => {
  it("detects current and historical versions from metadata", () => {
    expect(openVsxHasVersion({ version: "1.7.9" }, "1.7.9")).toBe(true);
    expect(
      openVsxHasVersion(
        {
          version: "1.8.0",
          allVersions: {
            "1.7.9": "https://open-vsx.org/api/roarpeng/graphflow-tool/1.7.9",
          },
        },
        "1.7.9"
      )
    ).toBe(true);
    expect(openVsxHasVersion({ version: "1.8.0", allVersions: {} }, "1.7.9")).toBe(false);
    expect(openVsxHasVersion(null, "1.7.9")).toBe(false);
  });

  it("wires Build workflow to publish Open VSX after successful package", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/build.yml"), "utf8");
    expect(workflow).toContain("publish-openvsx:");
    expect(workflow).toContain("needs: package-windows");
    expect(workflow).toContain("publish-openvsx-idempotent.mjs");
    expect(workflow).toContain("OVSX_PAT");
  });
});
