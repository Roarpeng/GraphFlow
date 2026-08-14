import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DSH_MCP_ROW_ID,
  DSH_PATCH_BEGIN,
  DSH_PATCH_END,
  buildGraphFlowDshInsertPatch,
  getDshHarnessStatus,
  installDshHarness,
  uninstallDshHarness,
  wrapDshManagedPatch,
} from "../src/integrations/dsh-harness-installer";
import { buildAgentProfiles } from "../src/integrations/agent-mcp-installer";
import { getAgentSkillTargets } from "../src/integrations/skill-installer";
import { buildDoctorReport } from "../src/surfaces/cli/init";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("DeepSeek Harness dsh plugin", () => {
  it("package.json declares dsh.bundle pointing at cordis.patch.yml", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      dsh?: { bundle?: { patch?: string } };
      files?: string[];
      keywords?: string[];
    };
    expect(pkg.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    expect(pkg.files).toContain("cordis.patch.yml");
    expect(pkg.keywords).toContain("dsh-plugin");
  });

  it("cordis.patch.yml matches the installer insert layer", () => {
    const file = readFileSync(join(__dirname, "..", "cordis.patch.yml"), "utf8");
    const insert = buildGraphFlowDshInsertPatch().trim();
    expect(file).toContain(`id: ${DSH_MCP_ROW_ID}`);
    expect(file).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(file).toContain("serverName: graphflow");
    expect(file).toContain("graphflow-mcp");
    expect(file.replace(/\r\n/g, "\n")).toContain(insert);
  });

  it("skips install when ~/.dsh is absent", () => {
    const dir = makeTempRoot("gf-dsh-missing-");
    const dshHome = join(dir, "no-dsh");
    const result = installDshHarness({ dshHome });
    expect(result.status).toBe("skipped");
    expect(result.message).toMatch(/not detected/i);
    expect(getDshHarnessStatus({ dshHome }).detected).toBe(false);
  });

  it("writes a managed overlay into an empty home patch", () => {
    const dir = makeTempRoot("gf-dsh-empty-");
    const dshHome = join(dir, ".dsh");
    mkdirSync(dshHome, { recursive: true });

    const created = installDshHarness({ dshHome });
    expect(created.status).toBe("created");
    const patchPath = join(dshHome, "cordis.patch.yml");
    const content = readFileSync(patchPath, "utf8");
    expect(content).toContain(DSH_PATCH_BEGIN);
    expect(content).toContain(DSH_PATCH_END);
    expect(content).toContain(`id: ${DSH_MCP_ROW_ID}`);

    const skipped = installDshHarness({ dshHome });
    expect(skipped.status).toBe("skipped");

    const status = getDshHarnessStatus({ dshHome });
    expect(status.detected).toBe(true);
    expect(status.installed).toBe(true);
  });

  it("appends the overlay without clobbering existing user rows", () => {
    const dir = makeTempRoot("gf-dsh-merge-");
    const dshHome = join(dir, ".dsh");
    mkdirSync(dshHome, { recursive: true });
    const patchPath = join(dshHome, "cordis.patch.yml");
    writeFileSync(
      patchPath,
      "- insert:\n    - id: user-row\n      name: '@example/keep-me'\n",
      "utf8"
    );

    const updated = installDshHarness({ dshHome });
    expect(updated.status).toBe("updated");
    const content = readFileSync(patchPath, "utf8");
    expect(content).toContain("id: user-row");
    expect(content).toContain("@example/keep-me");
    expect(content).toContain(`id: ${DSH_MCP_ROW_ID}`);

    const removed = uninstallDshHarness({ dshHome });
    expect(removed.status).toBe("updated");
    const after = readFileSync(patchPath, "utf8");
    expect(after).toContain("id: user-row");
    expect(after).not.toContain(DSH_PATCH_BEGIN);
    expect(after).not.toContain(`id: ${DSH_MCP_ROW_ID}`);
  });

  it("detects DeepSeek Harness in agent profiles and skill targets", () => {
    const profile = buildAgentProfiles().find((p) => p.id === "deepseek-harness");
    expect(profile).toBeDefined();
    expect(profile!.name).toBe("DeepSeek Harness");
    expect(profile!.userTargets).toEqual([]);

    const skill = getAgentSkillTargets().find((t) => t.agent === "DeepSeek Harness");
    expect(skill).toBeDefined();
    expect(skill!.skillsRoot.endsWith("skills")).toBe(true);
  });

  it("wrapDshManagedPatch is a closed comment block", () => {
    const wrapped = wrapDshManagedPatch();
    expect(wrapped.startsWith(DSH_PATCH_BEGIN)).toBe(true);
    expect(wrapped.trimEnd().endsWith(DSH_PATCH_END)).toBe(true);
  });

  it("doctor reports the dsh overlay when GRAPHFLOW_DSH_HOME is set", () => {
    const dir = makeTempRoot("gf-dsh-doctor-");
    const dshHome = join(dir, ".dsh");
    mkdirSync(dshHome, { recursive: true });

    const prev = process.env.GRAPHFLOW_DSH_HOME;
    process.env.GRAPHFLOW_DSH_HOME = dshHome;
    try {
      const before = buildDoctorReport(process.cwd());
      const mcpBefore = before.checks.filter(
        (c) => c.category === "mcp" && c.agent === "DeepSeek Harness"
      );
      expect(mcpBefore.length).toBe(1);
      expect(mcpBefore[0]?.status).toBe("missing");

      installDshHarness({ dshHome });
      const after = buildDoctorReport(process.cwd());
      const mcpAfter = after.checks.filter(
        (c) => c.category === "mcp" && c.agent === "DeepSeek Harness"
      );
      expect(mcpAfter[0]?.status).toBe("installed");
      expect(after.detectedAgents.some((a) => a.id === "deepseek-harness")).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.GRAPHFLOW_DSH_HOME;
      } else {
        process.env.GRAPHFLOW_DSH_HOME = prev;
      }
    }
  });
});
