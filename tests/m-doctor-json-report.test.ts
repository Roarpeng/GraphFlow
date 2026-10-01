import { probeMcpEntryPoint } from "../src/integrations/agent-mcp-installer";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildDoctorReport, formatDoctorLegacyText } from "../src/surfaces/cli/init";
import { buildCliUsage } from "../src/surfaces/cli/output";

describe("doctor JSON install self-check report", () => {
  it("documents doctor --json in CLI usage", () => {
    expect(buildCliUsage()).toContain("doctor [--json]");
  });

  it("returns structured success/missing checks with summary and ok flag", () => {
    const report = buildDoctorReport(process.cwd());

    expect(report).toMatchObject({
      command: "doctor",
      detectedAgents: expect.any(Array),
      checks: expect.any(Array),
      summary: {
        total: expect.any(Number),
        installed: expect.any(Number),
        missing: expect.any(Number),
        stale: expect.any(Number),
        na: expect.any(Number),
      },
      ok: expect.any(Boolean),
      remediation: expect.any(Array),
    });

    expect(report.summary.total).toBe(report.checks.length);
    expect(
      report.summary.installed + report.summary.missing + report.summary.stale + report.summary.na
    ).toBe(report.summary.total);
    // Stale is not "installed". A host launching a published copy while the
    // workspace has a local build is broken, and it reports healthy on an
    // existence check — so `ok` has to account for it or the check is theatre.
    expect(report.ok).toBe(report.summary.missing === 0 && report.summary.stale === 0);

    for (const check of report.checks) {
      expect(check).toMatchObject({
        category: expect.stringMatching(/^(mcp|config|skill|instruction|project|hooks)$/),
        agent: expect.any(String),
        path: expect.any(String),
        status: expect.stringMatching(/^(installed|missing|stale|n\/a)$/),
      });
    }

    if (report.summary.missing > 0) {
      expect(report.remediation.length).toBeGreaterThan(0);
      expect(report.remediation.some((line) => line.includes("graphflow install"))).toBe(true);
    }
  });

  it("formats human-readable doctor text from the same report", () => {
    const report = buildDoctorReport(process.cwd());
    const text = formatDoctorLegacyText(report);
    expect(text).toContain("[DOCTOR] GraphFlow self-diagnosis...");
    expect(text).toContain("Detected agents:");
    expect(text).toMatch(/summary: installed=\d+ missing=\d+/);
  });
});

describe("doctor detects a host running the wrong build", () => {
  it("flags a published MCP entry while a local build exists", () => {
    // Observed in the wild during an install: doctor reported `installed` for
    // an entry whose script was a published npm copy ten hours older than the
    // local dist, because the only question asked was "does the file exist".
    const dir = mkdtempSync(join(tmpdir(), "doctor-stale-"));
    try {
      const localBuild = join(dir, "dist", "surfaces", "mcp", "server.js");
      mkdirSync(dirname(localBuild), { recursive: true });
      writeFileSync(localBuild, "// local build");
      const configPath = join(dir, "opencode.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          mcp: {
            graphflow: {
              type: "local",
              command: ["/usr/bin/node", "/somewhere/node_modules/@roarpeng/graphflow/dist/surfaces/mcp/server.js"],
              enabled: true,
            },
          },
        })
      );
      const info = probeMcpEntryPoint(configPath, { workspaceRoot: dir });
      expect(info.fromPublishedPackage).toBe(true);
      expect(info.staleLocalBuild).toBe(localBuild);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not flag a host that already launches the local build", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-fresh-"));
    try {
      const localBuild = join(dir, "dist", "surfaces", "mcp", "server.js");
      mkdirSync(dirname(localBuild), { recursive: true });
      writeFileSync(localBuild, "// local build");
      const configPath = join(dir, "opencode.json");
      writeFileSync(
        configPath,
        JSON.stringify({ mcp: { graphflow: { type: "local", command: ["/usr/bin/node", localBuild] } } })
      );
      const info = probeMcpEntryPoint(configPath, { workspaceRoot: dir });
      expect(info.staleLocalBuild).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws on a missing or malformed config", () => {
    expect(probeMcpEntryPoint("/definitely/not/here.json")).toMatchObject({ fromPublishedPackage: false });
    const dir = mkdtempSync(join(tmpdir(), "doctor-bad-"));
    try {
      const bad = join(dir, "opencode.json");
      writeFileSync(bad, "{ not json");
      expect(() => probeMcpEntryPoint(bad)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("doctor reports a host entry that launches the workspace build", () => {
  it("treats it as installed, not as a missing or stale server", async () => {
    // The arrangement required for working on GraphFlow is a host entry that
    // points at this checkout's `dist/`. It looks like any other entry, so doctor
    // must not invent a second "something else registers it" check — an earlier
    // version had exactly that, for an opencode plugin hook that does not exist.
    // One server, one check.
    vi.resetModules();
    const home = mkdtempSync(join(tmpdir(), "doctor-workspace-mcp-"));
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const prevAppData = process.env.APPDATA;
    const prevLocalAppData = process.env.LOCALAPPDATA;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    // Cursor's secondary user target lives under %APPDATA%; without this the
    // install below writes the developer's real Cursor config.
    process.env.APPDATA = join(home, "AppData", "Roaming");
    process.env.LOCALAPPDATA = join(home, "AppData", "Local");
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    try {
      mkdirSync(join(home, ".cursor"), { recursive: true });
      // Built *before* the preference is set, because the preference falls back
      // to process.cwd() for the workspace when the marker has none recorded.
      // Creating it after would leave the build at a different path than the one
      // the entry points at, and the test would fail for the wrong reason.
      const workspace = mkdtempSync(join(tmpdir(), "doctor-workspace-"));
      mkdirSync(join(workspace, "dist", "surfaces", "mcp"), { recursive: true });
      writeFileSync(join(workspace, "dist", "surfaces", "mcp", "server.js"), "// build\n");

      process.env.HOME = home;
      if (process.platform === "win32") process.env.USERPROFILE = home;
      const { setWorkspaceBuildPreference } = await import("../src/integrations/workspace-build");
      setWorkspaceBuildPreference({ enabled: true, workspaceRoot: workspace });
      // The installer writes the entry the way `graphflow install --workspace-build` does.
      const { installMcpToDetectedAgents } = await import("../src/integrations/agent-mcp-installer");
      installMcpToDetectedAgents({
        strategy: "npx",
        installScope: "user",
        agentIdsOverride: ["cursor"],
        preferGlobalInstall: true,
        globalInstallOverride: null,
      });
      const { buildDoctorReport } = (await import("../src/surfaces/cli/init")) as typeof import("../src/surfaces/cli/init");

      const report = buildDoctorReport(workspace);
      // Cursor legitimately yields two mcp checks: the user-level path and a
      // workspace-relative one that does not exist in this sandbox. That split is
      // pre-existing and unrelated to the workspace build, so the invariant worth
      // pinning is that the *user-scope* entry is installed and nothing is stale —
      // not that there happens to be exactly one check.
      const userEntry = report.checks.find(
        (c) => c.category === "mcp" && /cursor/i.test(c.agent) && c.scope === "user"
      );

      expect(userEntry?.status).toBe("installed");
      expect(report.summary.stale).toBe(0);
      rmSync(workspace, { recursive: true, force: true });
    } finally {
      vi.resetModules();
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      for (const [key, value] of [
        ["APPDATA", prevAppData],
        ["LOCALAPPDATA", prevLocalAppData],
        ["XDG_CONFIG_HOME", prevXdg],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
