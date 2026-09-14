import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentProfiles } from "../src/integrations/agent-mcp-installer";
import { getHostAdapter } from "../src/integrations/host-adapter";
import {
  getHostAdapterInstallStatus,
  installViaHostAdapter,
  uninstallViaHostAdapter,
} from "../src/integrations/host-adapter-install";
import { isProfileHost } from "../src/integrations/profile-host-installer";

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

function withIsolatedHome<T>(home: string, run: () => T): T {
  const prevProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  const prevAppData = process.env.APPDATA;
  if (process.platform === "win32") process.env.USERPROFILE = home;
  else process.env.HOME = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  try {
    return run();
  } finally {
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
  }
}

describe("M87 ZCode host", () => {
  it("registers the zcode adapter and profile with nested mcp.servers targets", () => {
    const adapter = getHostAdapter("zcode");
    expect(adapter).toBeDefined();
    expect(adapter!.displayName).toBe("ZCode");
    expect(adapter!.capabilities).toEqual(["mcp-stdio", "skills", "rules"]);
    expect(isProfileHost("zcode")).toBe(true);

    const profile = buildAgentProfiles().find((p) => p.id === "zcode");
    expect(profile).toBeDefined();
    expect(profile!.userTargets[0]?.configPath).toBe(
      join(homedirSafe(), ".zcode", "cli", "config.json")
    );
    expect(profile!.userTargets[0]?.configFormat).toBe("zcode");
    expect(profile!.workspaceRelativePaths?.[0]?.relativePath).toBe(
      join(".zcode", "config.json")
    );
    expect(profile!.workspaceRelativePaths?.[0]?.configFormat).toBe("zcode");
  });

  it("installs MCP + skill + AGENTS.md instructions and reports status", () => {
    const home = makeTempRoot("gf-zcode-install-");
    mkdirSync(join(home, ".zcode"), { recursive: true });

    withIsolatedHome(home, () => {
      const created = installViaHostAdapter("zcode");
      expect(created.hostId).toBe("zcode");
      expect(["created", "injected"]).toContain(created.status);

      const configPath = join(home, ".zcode", "cli", "config.json");
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        mcp?: { servers?: Record<string, { command?: string; args?: string[] }> };
      };
      expect(config.mcp?.servers?.graphflow?.command).toBe("npx");
      expect(config.mcp?.servers?.graphflow?.args).toEqual([
        "-y",
        "--package=@roarpeng/graphflow",
        "graphflow-mcp",
      ]);

      expect(existsSync(join(home, ".zcode", "skills", "graphflow", "SKILL.md"))).toBe(true);
      const agents = readFileSync(join(home, ".zcode", "AGENTS.md"), "utf8");
      expect(agents).toContain("graphflow");

      const status = getHostAdapterInstallStatus("zcode");
      expect(status?.detected).toBe(true);
      expect(status?.mcpInstalled).toBe(true);
      expect(status?.skillInstalled).toBe(true);
      expect(status?.rulesInstalled).toBe(true);

      // Idempotent re-run keeps one server entry.
      installViaHostAdapter("zcode");
      const again = JSON.parse(readFileSync(configPath, "utf8")) as {
        mcp?: { servers?: Record<string, unknown> };
      };
      expect(Object.keys(again.mcp?.servers ?? {})).toEqual(["graphflow"]);
    });
  });

  it("preserves existing mcp.servers entries and top-level keys on inject/remove", () => {
    const home = makeTempRoot("gf-zcode-preserve-");
    const configPath = join(home, ".zcode", "cli", "config.json");
    mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        hooks: { enabled: true },
        mcp: { servers: { other: { command: "foo", args: [] } } },
      }),
      "utf8"
    );

    withIsolatedHome(home, () => {
      installViaHostAdapter("zcode");
      const injected = JSON.parse(readFileSync(configPath, "utf8")) as {
        hooks?: unknown;
        mcp?: { servers?: Record<string, unknown> };
      };
      expect(injected.hooks).toEqual({ enabled: true });
      expect(Object.keys(injected.mcp?.servers ?? {}).sort()).toEqual(["graphflow", "other"]);

      const removed = uninstallViaHostAdapter("zcode");
      expect(["updated", "skipped"]).toContain(removed.status);
      const after = JSON.parse(readFileSync(configPath, "utf8")) as {
        hooks?: unknown;
        mcp?: { servers?: Record<string, unknown> };
      };
      expect(after.mcp?.servers?.graphflow).toBeUndefined();
      expect(after.mcp?.servers?.other).toEqual({ command: "foo", args: [] });
      expect(after.hooks).toEqual({ enabled: true });
    });
  });
});

function homedirSafe(): string {
  // Profile paths resolve through os.homedir(); outside an isolated HOME the
  // real home is the correct expectation.
  const { homedir } = require("node:os") as typeof import("node:os");
  return homedir();
}
