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
        na: expect.any(Number),
      },
      ok: expect.any(Boolean),
      remediation: expect.any(Array),
    });

    expect(report.summary.total).toBe(report.checks.length);
    expect(
      report.summary.installed + report.summary.missing + report.summary.na
    ).toBe(report.summary.total);
    expect(report.ok).toBe(report.summary.missing === 0);

    for (const check of report.checks) {
      expect(check).toMatchObject({
        category: expect.stringMatching(/^(mcp|config|skill|instruction|project|hooks)$/),
        agent: expect.any(String),
        path: expect.any(String),
        status: expect.stringMatching(/^(installed|missing|n\/a)$/),
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
