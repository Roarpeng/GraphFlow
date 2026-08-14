import { describe, expect, it } from "vitest";
import {
  buildInstallReport,
  formatInstallLegacyText,
  type InstallReport,
} from "../src/surfaces/cli/init";
import { buildCliUsage } from "../src/surfaces/cli/output";

describe("install JSON report for agent self-check", () => {
  it("documents install --json in CLI usage", () => {
    expect(buildCliUsage()).toContain("install [--json]");
  });

  it("returns structured install actions plus post-install doctor checks", () => {
    const report = buildInstallReport(process.cwd(), { bootstrapGraph: false });

    expect(report).toMatchObject({
      command: "install",
      globalConfig: {
        path: expect.any(String),
        status: expect.stringMatching(/^(created|skipped|error)$/),
      },
      skills: expect.any(Object),
      mcp: expect.any(Array),
      claudeCodeHooks: {
        status: expect.stringMatching(/^(created|updated|skipped|error)$/),
      },
      dshHarness: {
        status: expect.stringMatching(/^(created|updated|skipped|error)$/),
      },
      doctor: {
        command: "doctor",
        checks: expect.any(Array),
        summary: {
          total: expect.any(Number),
          installed: expect.any(Number),
          missing: expect.any(Number),
          na: expect.any(Number),
        },
        ok: expect.any(Boolean),
        remediation: expect.any(Array),
      },
      ok: expect.any(Boolean),
      remediation: expect.any(Array),
    } satisfies Partial<InstallReport>);

    expect(report.skills).toMatchObject({
      traeSkills: expect.any(Array),
      cursorRules: expect.any(Array),
      claudeMd: expect.any(Array),
      agentInstructions: expect.any(Array),
      agentSkills: expect.any(Array),
      projectRules: expect.any(Array),
    });

    for (const item of report.mcp) {
      expect(item).toMatchObject({
        agentId: expect.any(String),
        agentName: expect.any(String),
        configPath: expect.any(String),
        scope: expect.stringMatching(/^(user|workspace)$/),
        status: expect.stringMatching(/^(injected|created|skipped|error|updated)$/),
      });
    }

    // Install is only ok when post-install doctor finds no missing registrations.
    expect(report.ok).toBe(
      report.doctor.ok &&
        !report.mcp.some((m) => m.status === "error") &&
        report.claudeCodeHooks.status !== "error" &&
        report.dshHarness.status !== "error"
    );
    if (!report.ok) {
      expect(report.remediation.length).toBeGreaterThan(0);
    }
  });

  it("formats human-readable install text from the same report", () => {
    const report = buildInstallReport(process.cwd(), { bootstrapGraph: false });
    const text = formatInstallLegacyText(report);
    expect(text).toContain("[START] Installing GraphFlow");
    expect(text).toContain("[FINISH] Installation complete");
    expect(text).toMatch(/doctor ok=/);
  });
});
