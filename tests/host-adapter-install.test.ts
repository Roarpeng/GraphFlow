import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHostAdapter, HOST_ADAPTERS, hostsWithCapability } from "../src/integrations/host-adapter";
import {
  CLAUDE_CODE_HOST_ADAPTER_ID,
  CURSOR_HOST_ADAPTER_ID,
  DSH_HOST_ADAPTER_ID,
  HAND_WRITTEN_HOST_ADAPTER_IDS,
  HOST_ADAPTER_MIGRATED_IDS,
  KIMI_CODE_HOST_ADAPTER_ID,
  getHostAdapterInstallStatus,
  installViaHostAdapter,
  uninstallViaHostAdapter,
} from "../src/integrations/host-adapter-install";
import { PROFILE_HOST_IDS, isProfileHost } from "../src/integrations/profile-host-installer";
import { DSH_MCP_ROW_ID, DSH_PATCH_BEGIN } from "../src/integrations/dsh-harness-installer";
import { SESSION_HOOK_SCRIPT } from "../src/integrations/claude-code-hooks";
import { buildDoctorReport, buildInstallReport } from "../src/surfaces/cli/init";

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

describe("package.json narrative", () => {
  it("describes GraphFlow as a local-first memory & context harness, not an orchestrator", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      description?: string;
      keywords?: string[];
    };
    expect(pkg.description).toMatch(/memory & context harness/i);
    expect(pkg.description).not.toMatch(/orchestration engine/i);
    expect(pkg.keywords).toEqual(expect.arrayContaining(["local-first", "memory-harness", "dsh-plugin"]));
    expect(pkg.keywords).not.toContain("orchestration");
    expect(pkg.keywords).not.toContain("multi-agent");
  });
});

describe("HostAdapter registry", () => {
  it("lists DSH, Cursor, Claude, and Kimi Code with their capability slices", () => {
    const ids = HOST_ADAPTERS.map((adapter) => adapter.id);
    expect(ids.slice(0, 4)).toEqual([
      "deepseek-harness",
      "cursor",
      "claude-code",
      "kimi-code",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const hostId of HOST_ADAPTER_MIGRATED_IDS) {
      expect(ids).toContain(hostId);
    }
    expect(getHostAdapter(DSH_HOST_ADAPTER_ID)?.capabilities).toEqual(
      expect.arrayContaining(["mcp-stdio", "skills", "hooks", "client-panel"])
    );
    expect(getHostAdapter("cursor")?.homeMarker).toBe(".cursor");
    expect(getHostAdapter("kimi-code")?.toolPrefix).toBe("mcp__graphflow__");
    expect(hostsWithCapability("hooks").map((adapter) => adapter.id)).toEqual([
      "deepseek-harness",
      "cursor",
      "claude-code",
      "gemini",
      "codex",
      "opencode",
    ]);
  });

  it("has a profile-backed spec for every registry host that is not hand-written", () => {
    const handWritten = new Set<string>(HAND_WRITTEN_HOST_ADAPTER_IDS);
    for (const adapter of HOST_ADAPTERS) {
      if (handWritten.has(adapter.id)) continue;
      expect(isProfileHost(adapter.id)).toBe(true);
    }
    expect(PROFILE_HOST_IDS.length).toBe(HOST_ADAPTERS.length - handWritten.size);
  });
});

describe("HostAdapter DSH install slice", () => {
  it("installViaHostAdapter writes the DSH overlay and uninstall reverses it", () => {
    const dshHome = join(makeTempRoot("gf-host-adapter-dsh-"), ".dsh");
    mkdirSync(dshHome, { recursive: true });

    const created = installViaHostAdapter(DSH_HOST_ADAPTER_ID, { home: dshHome });
    expect(created.hostId).toBe(DSH_HOST_ADAPTER_ID);
    expect(created.displayName).toBe("DeepSeek Harness");
    expect(created.status).toBe("created");
    expect(created.filePath).toBe(join(dshHome, "cordis.patch.yml"));
    expect(created.message).toMatch(/glue omitted/i);

    const patch = readFileSync(created.filePath as string, "utf8");
    expect(patch).toContain(DSH_PATCH_BEGIN);
    expect(patch).toContain(`id: ${DSH_MCP_ROW_ID}`);
    expect(patch).not.toContain("graphflow-dsh");

    const status = getHostAdapterInstallStatus(DSH_HOST_ADAPTER_ID, { home: dshHome });
    expect(status?.detected).toBe(true);
    expect(status?.installed).toBe(true);
    expect(status?.glueInstalled).toBe(false);
    expect(status?.agent).toBe("DeepSeek Harness");

    const skipped = installViaHostAdapter(DSH_HOST_ADAPTER_ID, { home: dshHome });
    expect(skipped.status).toBe("skipped");
    expect(skipped.message).toMatch(/glue omitted/i);

    const removed = uninstallViaHostAdapter(DSH_HOST_ADAPTER_ID, { home: dshHome });
    expect(removed.status).toBe("updated");
    expect(getHostAdapterInstallStatus(DSH_HOST_ADAPTER_ID, { home: dshHome })?.installed).toBe(false);
  });

  it("rejects unknown hosts and lists every migrated host", () => {
    expect([...HOST_ADAPTER_MIGRATED_IDS].slice(0, 4)).toEqual([
      "deepseek-harness",
      "cursor",
      "claude-code",
      "kimi-code",
    ]);
    expect(HOST_ADAPTER_MIGRATED_IDS).toContain("windsurf");
    expect(HOST_ADAPTER_MIGRATED_IDS).toContain("codex");
    expect(HOST_ADAPTER_MIGRATED_IDS).toContain("opencode");

    const unknown = installViaHostAdapter("not-a-host");
    expect(unknown.status).toBe("error");
    expect(unknown.message).toMatch(/unknown host adapter/);
    expect(getHostAdapterInstallStatus("not-a-host")).toBeUndefined();
  });
});

describe("HostAdapter profile-backed install slice", () => {
  it("installs and uninstalls a profile host (Windsurf) through the adapter", () => {
    const home = makeTempRoot("gf-host-adapter-windsurf-");
    const windsurfDir = join(home, ".codeium", "windsurf");
    mkdirSync(windsurfDir, { recursive: true });

    const prevProfile = process.env.USERPROFILE;
    const prevHome = process.env.HOME;
    const prevAppData = process.env.APPDATA;
    if (process.platform === "win32") process.env.USERPROFILE = home;
    else process.env.HOME = home;
    process.env.APPDATA = join(home, "AppData", "Roaming");

    try {
      const created = installViaHostAdapter("windsurf");
      expect(created.hostId).toBe("windsurf");
      expect(created.displayName).toBe("Windsurf");
      expect(created.status).toBe("created");

      const mcpPath = join(windsurfDir, "mcp_config.json");
      expect(existsSync(mcpPath)).toBe(true);
      const config = JSON.parse(readFileSync(mcpPath, "utf8")) as {
        mcpServers?: { graphflow?: unknown };
      };
      expect(config.mcpServers?.graphflow).toBeTruthy();
      expect(existsSync(join(windsurfDir, "memories", "global_rules.md"))).toBe(true);

      const status = getHostAdapterInstallStatus("windsurf");
      expect(status?.detected).toBe(true);
      expect(status?.mcpInstalled).toBe(true);
      expect(status?.rulesInstalled).toBe(true);

      const again = installViaHostAdapter("windsurf");
      expect(["created", "updated", "skipped"]).toContain(again.status);

      const removed = uninstallViaHostAdapter("windsurf");
      expect(removed.status).toBe("updated");
      const after = JSON.parse(readFileSync(mcpPath, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      expect(after.mcpServers?.graphflow).toBeUndefined();
      expect(getHostAdapterInstallStatus("windsurf")?.mcpInstalled).toBe(false);
    } finally {
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prevAppData;
    }
  });

  it("reports a well-formed status and stays idle when the host is not installed", () => {
    const home = makeTempRoot("gf-host-adapter-zed-");
    const prevProfile = process.env.USERPROFILE;
    const prevHome = process.env.HOME;
    const prevAppData = process.env.APPDATA;
    if (process.platform === "win32") process.env.USERPROFILE = home;
    else process.env.HOME = home;
    process.env.APPDATA = join(home, "AppData", "Roaming");

    try {
      // Status before install: no marker, no MCP target.
      const before = getHostAdapterInstallStatus("zed");
      expect(before?.hostId).toBe("zed");
      expect(before?.agent).toBe("Zed");
      expect(before?.detected).toBe(false);
      expect(before?.mcpInstalled).toBe(false);
      expect(before?.mcpTargets).toEqual([]);

      const result = installViaHostAdapter("zed");
      expect(result.hostId).toBe("zed");
      expect(result.displayName).toBe("Zed");
      expect(["created", "updated", "skipped"]).toContain(result.status);
    } finally {
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prevAppData;
    }
  });
});

describe("HostAdapter Cursor install slice", () => {
  it("installViaHostAdapter writes MCP + rules + skill and uninstall reverses them", () => {
    const cursorHome = join(makeTempRoot("gf-host-adapter-cursor-"), ".cursor");
    mkdirSync(cursorHome, { recursive: true });

    const created = installViaHostAdapter(CURSOR_HOST_ADAPTER_ID, { home: cursorHome });
    expect(created.hostId).toBe(CURSOR_HOST_ADAPTER_ID);
    expect(created.displayName).toBe("Cursor");
    expect(created.status).toBe("created");
    expect(created.filePath).toBe(join(cursorHome, "mcp.json"));

    const mcp = JSON.parse(readFileSync(join(cursorHome, "mcp.json"), "utf8")) as {
      mcpServers?: { graphflow?: { command?: string } };
    };
    expect(mcp.mcpServers?.graphflow?.command).toBeTruthy();
    expect(existsSync(join(cursorHome, "rules", "graphflow.mdc"))).toBe(true);
    expect(existsSync(join(cursorHome, "skills", "graphflow", "SKILL.md"))).toBe(true);

    const status = getHostAdapterInstallStatus(CURSOR_HOST_ADAPTER_ID, { home: cursorHome });
    expect(status?.detected).toBe(true);
    expect(status?.installed).toBe(true);
    expect(status?.mcpInstalled).toBe(true);
    expect(status?.rulesInstalled).toBe(true);
    expect(status?.skillInstalled).toBe(true);
    expect(status?.agent).toBe("Cursor");

    const skipped = installViaHostAdapter(CURSOR_HOST_ADAPTER_ID, { home: cursorHome });
    expect(skipped.status).toBe("skipped");

    const removed = uninstallViaHostAdapter(CURSOR_HOST_ADAPTER_ID, { home: cursorHome });
    expect(removed.status).toBe("updated");
    expect(getHostAdapterInstallStatus(CURSOR_HOST_ADAPTER_ID, { home: cursorHome })?.installed).toBe(
      false
    );
    expect(existsSync(join(cursorHome, "skills", "graphflow", "SKILL.md"))).toBe(false);
    expect(existsSync(join(cursorHome, "rules", "graphflow.mdc"))).toBe(false);
  });

  it("skips Cursor when the host home is absent", () => {
    const missing = join(makeTempRoot("gf-host-adapter-cursor-missing-"), ".cursor");
    const skipped = installViaHostAdapter(CURSOR_HOST_ADAPTER_ID, { home: missing });
    expect(skipped.status).toBe("skipped");
    expect(skipped.message).toMatch(/not detected/i);
    expect(getHostAdapterInstallStatus(CURSOR_HOST_ADAPTER_ID, { home: missing })?.detected).toBe(false);
  });
});

describe("HostAdapter Claude Code install slice", () => {
  it("installViaHostAdapter writes MCP + CLAUDE.md + skill + hooks and uninstall reverses them", () => {
    const root = makeTempRoot("gf-host-adapter-claude-");
    const claudeHome = join(root, ".claude");
    mkdirSync(claudeHome, { recursive: true });

    const created = installViaHostAdapter(CLAUDE_CODE_HOST_ADAPTER_ID, { home: claudeHome });
    expect(created.hostId).toBe(CLAUDE_CODE_HOST_ADAPTER_ID);
    expect(created.displayName).toBe("Claude Code");
    expect(created.status).toBe("created");

    const mcpPath = join(root, ".claude.json");
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers?: { graphflow?: { command?: string } };
    };
    expect(mcp.mcpServers?.graphflow?.command).toBeTruthy();
    expect(existsSync(join(claudeHome, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(claudeHome, "skills", "graphflow", "SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeHome, "graphflow-hooks", SESSION_HOOK_SCRIPT))).toBe(true);
    const settings = readFileSync(join(claudeHome, "settings.json"), "utf8");
    expect(settings).toContain("SessionEnd");

    const status = getHostAdapterInstallStatus(CLAUDE_CODE_HOST_ADAPTER_ID, { home: claudeHome });
    expect(status?.detected).toBe(true);
    expect(status?.installed).toBe(true);
    expect(status?.mcpInstalled).toBe(true);
    expect(status?.rulesInstalled).toBe(true);
    expect(status?.skillInstalled).toBe(true);
    expect(status?.hooksInstalled).toBe(true);
    expect(status?.agent).toBe("Claude Code");
    expect(status?.mcpPath).toBe(mcpPath);

    const skipped = installViaHostAdapter(CLAUDE_CODE_HOST_ADAPTER_ID, { home: claudeHome });
    expect(skipped.status).toBe("skipped");

    const removed = uninstallViaHostAdapter(CLAUDE_CODE_HOST_ADAPTER_ID, { home: claudeHome });
    expect(removed.status).toBe("updated");
    const after = getHostAdapterInstallStatus(CLAUDE_CODE_HOST_ADAPTER_ID, { home: claudeHome });
    expect(after?.installed).toBe(false);
    expect(after?.hooksInstalled).toBe(false);
    expect(existsSync(join(claudeHome, "skills", "graphflow", "SKILL.md"))).toBe(false);
  });
});

describe("HostAdapter Kimi Code install slice", () => {
  it("installViaHostAdapter writes MCP + AGENTS.md + skill without ${workspaceFolder}", () => {
    const kimiHome = join(makeTempRoot("gf-host-adapter-kimi-"), ".kimi-code");
    mkdirSync(kimiHome, { recursive: true });

    const created = installViaHostAdapter(KIMI_CODE_HOST_ADAPTER_ID, { home: kimiHome });
    expect(created.hostId).toBe(KIMI_CODE_HOST_ADAPTER_ID);
    expect(created.displayName).toBe("Kimi Code");
    expect(created.status).toBe("created");
    expect(created.filePath).toBe(join(kimiHome, "mcp.json"));

    const mcp = JSON.parse(readFileSync(join(kimiHome, "mcp.json"), "utf8")) as {
      mcpServers?: { graphflow?: { command?: string; env?: Record<string, string> } };
    };
    expect(mcp.mcpServers?.graphflow?.command).toBeTruthy();
    expect(mcp.mcpServers?.graphflow?.env?.GRAPHFLOW_WORKSPACE_ROOT).toBeUndefined();
    expect(existsSync(join(kimiHome, "AGENTS.md"))).toBe(true);
    expect(readFileSync(join(kimiHome, "AGENTS.md"), "utf8")).toContain("GRAPHFLOW:BEGIN");
    expect(existsSync(join(kimiHome, "skills", "graphflow", "SKILL.md"))).toBe(true);

    const status = getHostAdapterInstallStatus(KIMI_CODE_HOST_ADAPTER_ID, { home: kimiHome });
    expect(status?.detected).toBe(true);
    expect(status?.installed).toBe(true);
    expect(status?.mcpInstalled).toBe(true);
    expect(status?.rulesInstalled).toBe(true);
    expect(status?.skillInstalled).toBe(true);
    expect(status?.agent).toBe("Kimi Code");

    const skipped = installViaHostAdapter(KIMI_CODE_HOST_ADAPTER_ID, { home: kimiHome });
    expect(skipped.status).toBe("skipped");

    const removed = uninstallViaHostAdapter(KIMI_CODE_HOST_ADAPTER_ID, { home: kimiHome });
    expect(removed.status).toBe("updated");
    expect(getHostAdapterInstallStatus(KIMI_CODE_HOST_ADAPTER_ID, { home: kimiHome })?.installed).toBe(
      false
    );
    expect(existsSync(join(kimiHome, "skills", "graphflow", "SKILL.md"))).toBe(false);
  });

  it("skips Kimi Code when the host home is absent", () => {
    const missing = join(makeTempRoot("gf-host-adapter-kimi-missing-"), ".kimi-code");
    const skipped = installViaHostAdapter(KIMI_CODE_HOST_ADAPTER_ID, { home: missing });
    expect(skipped.status).toBe("skipped");
    expect(skipped.message).toMatch(/not detected/i);
    expect(getHostAdapterInstallStatus(KIMI_CODE_HOST_ADAPTER_ID, { home: missing })?.detected).toBe(
      false
    );
  });
});

describe("M16 HostAdapter CLI wiring", () => {
  it("doctor reports Cursor checks from the adapter when GRAPHFLOW_CURSOR_HOME is set", () => {
    const cursorHome = join(makeTempRoot("gf-doctor-cursor-"), ".cursor");
    mkdirSync(cursorHome, { recursive: true });
    installViaHostAdapter(CURSOR_HOST_ADAPTER_ID, { home: cursorHome });

    const prev = process.env.GRAPHFLOW_CURSOR_HOME;
    process.env.GRAPHFLOW_CURSOR_HOME = cursorHome;
    try {
      const report = buildDoctorReport(process.cwd());
      const cursorMcp = report.checks.filter((check) => check.category === "mcp" && check.agent === "Cursor");
      expect(cursorMcp.length).toBeGreaterThan(0);
      expect(cursorMcp[0]?.status).toBe("installed");
      expect(cursorMcp[0]?.path).toBe(join(cursorHome, "mcp.json"));
      expect(
        report.checks.some((check) => check.category === "skill" && check.agent === "Cursor skill" && check.status === "installed")
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GRAPHFLOW_CURSOR_HOME;
      else process.env.GRAPHFLOW_CURSOR_HOME = prev;
    }
  });

  it("doctor reports Kimi Code checks from the adapter when GRAPHFLOW_KIMI_CODE_HOME is set", () => {
    const kimiHome = join(makeTempRoot("gf-doctor-kimi-"), ".kimi-code");
    mkdirSync(kimiHome, { recursive: true });
    installViaHostAdapter(KIMI_CODE_HOST_ADAPTER_ID, { home: kimiHome });

    const prev = process.env.GRAPHFLOW_KIMI_CODE_HOME;
    process.env.GRAPHFLOW_KIMI_CODE_HOME = kimiHome;
    try {
      const report = buildDoctorReport(process.cwd());
      const kimiMcp = report.checks.filter((check) => check.category === "mcp" && check.agent === "Kimi Code");
      expect(kimiMcp.length).toBeGreaterThan(0);
      expect(kimiMcp[0]?.status).toBe("installed");
      expect(kimiMcp[0]?.path).toBe(join(kimiHome, "mcp.json"));
      expect(
        report.checks.some(
          (check) => check.category === "skill" && check.agent === "Kimi Code skill" && check.status === "installed"
        )
      ).toBe(true);
      expect(
        report.checks.some(
          (check) =>
            check.category === "instruction" &&
            check.agent === "Kimi Code instructions" &&
            check.status === "installed"
        )
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GRAPHFLOW_KIMI_CODE_HOME;
      else process.env.GRAPHFLOW_KIMI_CODE_HOME = prev;
    }
  });

  it("install report still exposes claudeCodeHooks after HostAdapter routing", () => {
    const report = buildInstallReport(process.cwd(), { bootstrapGraph: false });
    expect(report.claudeCodeHooks).toMatchObject({
      status: expect.stringMatching(/^(created|updated|skipped|error)$/),
    });
  });
});
