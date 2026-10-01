import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCliUsage } from "../src/surfaces/cli/output";
import type { InstallReport } from "../src/surfaces/cli/init";

type InitModule = typeof import("../src/surfaces/cli/init");

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

/**
 * buildInstallReport rewrites configs for every detected agent home; isolate
 * HOME so the machine running the suite keeps its real agent configs intact.
 *
 * Resetting the module registry is the load-bearing part, not an optimisation.
 * Agent profiles call `resolveHomePaths()` and register themselves when their
 * module is first imported, so a statically imported installer has already
 * captured the real home by the time this runs. Pointing HOME at a temp dir
 * alone left the suite writing to the developer's real `~/.config/opencode` —
 * verified with a writeFileSync tracer, which caught
 * injectIntoOpencodeConfig <- installMcpToDetectedAgents landing on the real
 * path. Re-importing after the env is redirected is the only way the
 * isolation actually holds.
 */
async function withIsolatedHome<T>(run: (init: InitModule) => T): Promise<T> {
  const home = makeTempRoot("gf-isolated-home-");
  const keys = ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "GRAPHFLOW_DSH_HOME", "KIMI_CODE_HOME"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.GRAPHFLOW_DSH_HOME = join(home, ".dsh");
  delete process.env.KIMI_CODE_HOME;
  vi.resetModules();
  try {
    return run((await import("../src/surfaces/cli/init")) as InitModule);
  } finally {
    vi.resetModules();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("install JSON report for agent self-check", () => {
  it("documents install --json in CLI usage", () => {
    expect(buildCliUsage()).toContain("install [--json]");
  });

  it("returns structured install actions plus post-install doctor checks", async () => {
    const report = await withIsolatedHome((init) =>
      init.buildInstallReport(process.cwd(), { bootstrapGraph: false })
    );

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
      warnings: expect.any(Array),
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

    // Install is ok when post-install doctor finds no missing registrations and no
    // core write failed; optional extras that failed are warnings, not failures.
    expect(report.ok).toBe(
      report.doctor.ok &&
        !report.mcp.some((m) => m.status === "error") &&
        report.globalConfig.status !== "error"
    );
    expect(report.ok).toBe(report.remediation.length === 0);
  });

  it("does not configure hosts that are not detected", async () => {
    const report = await withIsolatedHome((init) =>
      init.buildInstallReport(makeTempRoot("gf-install-proj-"), { bootstrapGraph: false })
    );
    expect(report.doctor.detectedAgents).toEqual([]);
    expect(report.mcp.every((m) => m.status === "skipped")).toBe(true);
    expect(report.skills.projectRules.every((r) => r.status === "skipped")).toBe(true);
  });

  it("formats human-readable install text from the same report", async () => {
    const text = await withIsolatedHome((init) =>
      init.formatInstallLegacyText(init.buildInstallReport(process.cwd(), { bootstrapGraph: false }))
    );
    expect(text).toContain("[START] Installing GraphFlow");
    expect(text).toContain("[FINISH] Installation complete");
    expect(text).toMatch(/doctor ok=/);
  });
});
