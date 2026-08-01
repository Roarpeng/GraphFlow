import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  alignPackageJsonForNamespace,
  openVsxHasVersion,
  resolveOpenVsxToken,
} from "../scripts/openvsx-publish-lib.cjs";

describe("Open VSX idempotent publish helper", () => {
  it("detects current and historical versions from metadata", () => {
    expect(openVsxHasVersion({ version: "1.7.9" }, "1.7.9")).toBe(true);
    expect(
      openVsxHasVersion(
        {
          version: "1.8.0",
          allVersions: {
            "1.7.9": "https://open-vsx.org/api/roarpeng/graphflow/1.7.9",
          },
        },
        "1.7.9"
      )
    ).toBe(true);
    expect(openVsxHasVersion({ version: "1.8.0", allVersions: {} }, "1.7.9")).toBe(false);
    expect(openVsxHasVersion(null, "1.7.9")).toBe(false);
  });

  it("resolves open_vsx_token and keeps publisher aligned with roarpeng namespace", () => {
    expect(resolveOpenVsxToken({ open_vsx_token: "from-secret" })).toBe("from-secret");
    expect(resolveOpenVsxToken({ OPEN_VSX_TOKEN: "upper", OVSX_PAT: "legacy" })).toBe("upper");
    expect(resolveOpenVsxToken({ OVSX_PAT: "legacy" })).toBe("legacy");

    const same = alignPackageJsonForNamespace(
      {
        name: "graphflow",
        publisher: "roarpeng",
        activationEvents: ["onChatParticipant:roarpeng.graphflow.graphflowAgent"],
        contributes: {
          chatParticipants: [{ id: "roarpeng.graphflow.graphflowAgent" }],
        },
      },
      "roarpeng"
    );
    expect(same.publisher).toBe("roarpeng");
    expect(same.activationEvents).toContain(
      "onChatParticipant:roarpeng.graphflow.graphflowAgent"
    );
  });

  it("wires Build workflow to publish Open VSX after successful package", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/build.yml"), "utf8");
    expect(workflow).toContain("publish-openvsx:");
    expect(workflow).toContain("needs: package-windows");
    expect(workflow).toContain("publish-openvsx-idempotent.mjs");
    expect(workflow).toContain("secrets.open_vsx_token");
    expect(workflow).toContain("OVSX_NAMESPACE: roarpeng");
  });
});
