import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHostAdapter, HOST_ADAPTERS, hostsWithCapability } from "../src/integrations/host-adapter";
import {
  CLAUDE_CODE_HOST_ADAPTER_ID,
  CURSOR_HOST_ADAPTER_ID,
  DSH_HOST_ADAPTER_ID,
  getHostAdapterInstallStatus,
  HOST_ADAPTER_MIGRATED_IDS,
  installViaHostAdapter,
  uninstallViaHostAdapter,
} from "../src/integrations/host-adapter-install";
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
  it("lists DSH, Cursor, and Claude with their capability slices", () => {
    expect(HOST_ADAPTERS.map((adapter) => adapter.id)).toEqual([
      "deepseek-harness",
      "cursor",
      "claude-code",
    ]);
    expect(getHostAdapter(DSH_HOST_ADAPTER_ID)?.capabilities).toEqual(
      expect.arrayContaining(["mcp-stdio", "skills", "hooks", "client-panel"])
    );
    expect(getHostAdapter("cursor")?.homeMarker).toBe(".cursor");
    expect(hostsWithCapability("hooks").map((adapter) => adapter.id)).toEqual([
      "deepseek-harness",
      "claude-code",
    ]);
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

    const patch = readFileSync(created.filePath as string, "utf8");
    expect(patch).toContain(DSH_PATCH_BEGIN);
    expect(patch).toContain(`id: ${DSH_MCP_ROW_ID}`);

    const status = getHostAdapterInstallStatus(DSH_HOST_ADAPTER_ID, { home: dshHome });
    expect(status?.detected).toBe(true);
    expect(status?.installed).toBe(true);
    expect(status?.glueInstalled).toBe(true);
    expect(status?.agent).toBe("DeepSeek Harness");

    const skipped = installViaHostAdapter(DSH_HOST_ADAPTER_ID, { home: dshHome });
    expect(skipped.status).toBe("skipped");

    const removed = uninstallViaHostAdapter(DSH_HOST_ADAPTER_ID, { home: dshHome });
    expect(removed.status).toBe("updated");
    expect(getHostAdapterInstallStatus(DSH_HOST_ADAPTER_ID, { home: dshHome })?.installed).toBe(false);
  });

  it("rejects unknown hosts and lists Cursor + Claude as migrated", () => {
    expect(HOST_ADAPTER_MIGRATED_IDS).toEqual([
      "deepseek-harness",
      "cursor",
      "claude-code",
    ]);

    const unknown = installViaHostAdapter("not-a-host");
    expect(unknown.status).toBe("error");
    expect(unknown.message).toMatch(/unknown host adapter/);
    expect(getHostAdapterInstallStatus("not-a-host")).toBeUndefined();
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

  it("install report still exposes claudeCodeHooks after HostAdapter routing", () => {
    const report = buildInstallReport(process.cwd(), { bootstrapGraph: false });
    expect(report.claudeCodeHooks).toMatchObject({
      status: expect.stringMatching(/^(created|updated|skipped|error)$/),
    });
  });
});
