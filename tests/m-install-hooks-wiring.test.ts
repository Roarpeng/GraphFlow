import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getClaudeCodeHooksStatus,
  installClaudeCodeHooks,
  SESSION_HOOK_SCRIPT,
} from "../src/integrations/claude-code-hooks";
import {
  buildDoctorReport,
  buildInstallReport,
  formatInstallLegacyText,
} from "../src/surfaces/cli/init";

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
      // ignore cleanup failures
    }
  }
});

describe("Claude Code hooks status helper", () => {
  it("reports not detected when Claude Code home is absent", () => {
    const dir = makeTempRoot("gf-hooks-status-");
    const status = getClaudeCodeHooksStatus({
      claudeHome: join(dir, "missing-claude"),
      settingsPath: join(dir, "missing-claude", "settings.json"),
      hooksDir: join(dir, "missing-claude", "graphflow-hooks"),
    });
    expect(status.detected).toBe(false);
    expect(status.installed).toBe(false);
    expect(status.agent).toBe("Claude Code hooks");
  });

  it("reports installed only when settings + session script are present", () => {
    const dir = makeTempRoot("gf-hooks-status-");
    const claudeHome = join(dir, ".claude");
    const hooksDir = join(claudeHome, "graphflow-hooks");
    const settingsPath = join(claudeHome, "settings.json");
    mkdirSync(claudeHome, { recursive: true });

    const before = getClaudeCodeHooksStatus({ claudeHome, settingsPath, hooksDir });
    expect(before.detected).toBe(true);
    expect(before.installed).toBe(false);

    installClaudeCodeHooks({ settingsPath, hooksDir });
    const after = getClaudeCodeHooksStatus({ claudeHome, settingsPath, hooksDir });
    expect(after.installed).toBe(true);
    expect(after.scriptPath).toContain(SESSION_HOOK_SCRIPT);
    expect(readFileSync(after.scriptPath, "utf8")).toContain("outcome report");
  });
});

describe("install/doctor wire Claude Code hooks", () => {
  it("includes claudeCodeHooks in InstallReport and formats it in legacy text", () => {
    const report = buildInstallReport(process.cwd(), { bootstrapGraph: false });
    expect(report.claudeCodeHooks).toMatchObject({
      status: expect.stringMatching(/^(created|updated|skipped|error)$/),
    });
    const text = formatInstallLegacyText(report);
    expect(text).toMatch(/Claude Code hooks/i);
  });

  it("doctor reports hooks check when Claude Code is detected", () => {
    const dir = makeTempRoot("gf-doctor-hooks-");
    const claudeHome = join(dir, ".claude");
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), "{}\n");

    // Inject via env override used by status helper / doctor wiring.
    const prev = process.env.GRAPHFLOW_CLAUDE_HOME;
    process.env.GRAPHFLOW_CLAUDE_HOME = claudeHome;
    try {
      const report = buildDoctorReport(process.cwd());
      const hooksChecks = report.checks.filter((c) => c.category === "hooks");
      expect(hooksChecks.length).toBeGreaterThan(0);
      expect(hooksChecks[0]).toMatchObject({
        agent: "Claude Code hooks",
        status: expect.stringMatching(/^(installed|missing)$/),
        detected: true,
      });
    } finally {
      if (prev === undefined) delete process.env.GRAPHFLOW_CLAUDE_HOME;
      else process.env.GRAPHFLOW_CLAUDE_HOME = prev;
    }
  });
});
