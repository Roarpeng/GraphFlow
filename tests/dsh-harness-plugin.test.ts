import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DSH_GLUE_ROW_ID,
  DSH_MCP_ROW_ID,
  DSH_PACKAGE_NAME,
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

  it("writes MCP-only overlay when profile package is missing (safe for dsh boot)", () => {
    const dir = makeTempRoot("gf-dsh-empty-");
    const dshHome = join(dir, ".dsh");
    mkdirSync(dshHome, { recursive: true });

    const created = installDshHarness({ dshHome });
    expect(created.status).toBe("created");
    expect(created.message).toMatch(/glue omitted/i);
    const patchPath = join(dshHome, "cordis.patch.yml");
    const content = readFileSync(patchPath, "utf8");
    expect(content).toContain(DSH_PATCH_BEGIN);
    expect(content).toContain(DSH_PATCH_END);
    expect(content).toContain(`id: ${DSH_MCP_ROW_ID}`);
    expect(content).not.toContain(`id: ${DSH_GLUE_ROW_ID}`);
    expect(content).not.toContain("@roarpeng/graphflow/dsh");

    const skipped = installDshHarness({ dshHome });
    expect(skipped.status).toBe("skipped");
    expect(skipped.message).toMatch(/glue omitted/i);

    const status = getDshHarnessStatus({ dshHome });
    expect(status.detected).toBe(true);
    expect(status.installed).toBe(true);
    expect(status.glueInstalled).toBe(false);
    expect(status.packageInstalled).toBe(false);
  });

  it("clears home overlay when profile package is present (bundle owns MCP+glue)", () => {
    const dir = makeTempRoot("gf-dsh-with-pkg-");
    const dshHome = join(dir, ".dsh");
    const profileDir = join(dshHome, "profiles", "web");
    const pkgDir = join(profileDir, "node_modules", "@roarpeng", "graphflow");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: DSH_PACKAGE_NAME, version: "0.0.0" }), "utf8");
    writeFileSync(
      join(profileDir, "package.json"),
      JSON.stringify(
        {
          name: "dsh-profile-web",
          private: true,
          dependencies: { [DSH_PACKAGE_NAME]: "0.0.0" },
          dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"], patchReload: "live" } },
        },
        null,
        2
      ),
      "utf8"
    );
    writeFileSync(join(dshHome, "cordis.patch.yml"), wrapDshManagedPatch(buildGraphFlowDshInsertPatch()), "utf8");

    const updated = installDshHarness({ dshHome });
    expect(updated.status).toBe("updated");
    expect(updated.message).toMatch(/cleared home overlay/i);
    expect(existsSync(join(dshHome, "cordis.patch.yml"))).toBe(false);
    expect(getDshHarnessStatus({ dshHome }).packageInstalled).toBe(true);
    expect(getDshHarnessStatus({ dshHome }).glueInstalled).toBe(true);

    const profilePkg = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8")) as {
      dsh: { profile: { bundles: string[] } };
    };
    expect(profilePkg.dsh.profile.bundles).toContain(DSH_PACKAGE_NAME);
  });

  it("downgrades existing glue overlay to MCP-only when package is missing", () => {
    const dir = makeTempRoot("gf-dsh-downgrade-");
    const dshHome = join(dir, ".dsh");
    mkdirSync(dshHome, { recursive: true });
    const patchPath = join(dshHome, "cordis.patch.yml");
    writeFileSync(patchPath, wrapDshManagedPatch(buildGraphFlowDshInsertPatch({ includeGlue: true })), "utf8");

    const updated = installDshHarness({ dshHome });
    expect(updated.status).toBe("updated");
    const content = readFileSync(patchPath, "utf8");
    expect(content).toContain(`id: ${DSH_MCP_ROW_ID}`);
    expect(content).not.toContain(`id: ${DSH_GLUE_ROW_ID}`);
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
    expect(content).not.toContain(`id: ${DSH_GLUE_ROW_ID}`);

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
