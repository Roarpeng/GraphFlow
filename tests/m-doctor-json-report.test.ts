import { probeMcpEntryPoint } from "../src/integrations/agent-mcp-installer";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
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

describe("doctor recognises a plugin-registered MCP server", () => {
  it("is not fooled into calling the correct setup broken", () => {
    // After removing the opencode.json entry, doctor would have reported the
    // absent entry as `missing` — punishing the arrangement you are required to
    // use when working on GraphFlow, because opencode normalises config entries
    // it owns. One server must also produce exactly one check.
    const home = mkdtempSync(join(tmpdir(), "doctor-plugin-mcp-"));
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    try {
      const configDir = join(home, ".config", "opencode");
      const pluginDir = join(configDir, "plugins");
      mkdirSync(pluginDir, { recursive: true });
      // The plugin is installed, and the config deliberately has no graphflow entry.
      writeFileSync(join(pluginDir, "graphflow.mjs"), "export const name = 'graphflow-opencode';\n");
      writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ mcp: { pencil: { type: "local" } } }));

      process.env.HOME = home;
      if (process.platform === "win32") process.env.USERPROFILE = home;
      const report = buildDoctorReport(process.cwd());
      const opencodeMcp = report.checks.filter(
        (c) => /opencode/i.test(c.agent) && c.category === "mcp"
      );
      // Exactly one, and not missing.
      expect(opencodeMcp.length).toBe(1);
      expect(opencodeMcp[0]?.status).toBe("installed");
      expect(opencodeMcp[0]?.message).toContain("plugin registers the server");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
