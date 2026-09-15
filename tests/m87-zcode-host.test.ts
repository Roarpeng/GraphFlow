import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAgentProfiles,
  installMcpToDetectedAgents,
  resolveGlobalGraphflowInstall,
} from "../src/integrations/agent-mcp-installer";
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
      // Direct installer call with the global-install probe pinned to null:
      // this case locks the npx fallback shape regardless of whether the
      // machine running the suite has a global install.
      const results = installMcpToDetectedAgents({
        strategy: "npx",
        installScope: "user",
        agentIdsOverride: ["zcode"],
        preferGlobalInstall: true,
        globalInstallOverride: null,
      });
      expect(results.some((r) => r.agentId === "zcode")).toBe(true);

      const configPath = join(home, ".zcode", "cli", "config.json");
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        mcp?: {
          servers?: Record<string, {
            command?: string;
            args?: string[];
            env?: Record<string, string>;
            timeoutMs?: number;
            type?: string;
          }>;
        };
      };
      // Windows launchers use an absolute node + npx-cli.js path instead of
      // bare "npx", so assert the package/target args, not the command.
      const entry = config.mcp?.servers?.graphflow;
      const args = entry?.args ?? [];
      expect(args).toContain("--package=@roarpeng/graphflow");
      expect(args).toContain("graphflow-mcp");
      // ZCode never expands ${...} in config-file entries; the injector must
      // drop the literal placeholder and raise the 30s default timeout.
      expect(entry?.env?.GRAPHFLOW_WORKSPACE_ROOT).toBeUndefined();
      expect(entry?.timeoutMs).toBe(120000);

      // Idempotent re-run keeps one server entry.
      installMcpToDetectedAgents({
        strategy: "npx",
        installScope: "user",
        agentIdsOverride: ["zcode"],
        preferGlobalInstall: true,
        globalInstallOverride: null,
      });
      const again = JSON.parse(readFileSync(configPath, "utf8")) as {
        mcp?: { servers?: Record<string, unknown> };
      };
      expect(Object.keys(again.mcp?.servers ?? {})).toEqual(["graphflow"]);
    });
  });

  it("writes a direct node + server.js entry when a global install exists", () => {
    const home = makeTempRoot("gf-zcode-global-");
    mkdirSync(join(home, ".zcode"), { recursive: true });
    const globalRoot = makeTempRoot("gf-zcode-global-pkg-");
    const serverPath = join(globalRoot, "dist", "surfaces", "mcp", "server.js");

    withIsolatedHome(home, () => {
      installMcpToDetectedAgents({
        strategy: "npx",
        installScope: "user",
        agentIdsOverride: ["zcode"],
        preferGlobalInstall: true,
        globalInstallOverride: { serverPath, runtimeRoot: globalRoot },
      });
      const configPath = join(home, ".zcode", "cli", "config.json");
      const entry = (JSON.parse(readFileSync(configPath, "utf8")) as {
        mcp?: { servers?: Record<string, { command?: string; args?: string[]; cwd?: string; env?: Record<string, string> }> };
      }).mcp?.servers?.graphflow;
      // Direct launch: node + absolute server.js, package root as cwd, and no
      // NODE/NPX_CLI launcher env left over from the npx path.
      expect(entry?.args?.[0]).toBe(serverPath);
      expect(entry?.cwd).toBe(globalRoot);
      expect(entry?.env?.NODE).toBeUndefined();
      expect(entry?.env?.NPX_CLI).toBeUndefined();
      expect(entry?.args ?? []).not.toContain("--package=@roarpeng/graphflow");
    });
  });

  it("resolveGlobalGraphflowInstall probes npm root -g and fails open", () => {
    const found = resolveGlobalGraphflowInstall({
      runNpmRoot: () => "/opt/node/lib/node_modules",
      exists: (p) => p.endsWith(join("@roarpeng", "graphflow", "dist", "surfaces", "mcp", "server.js")),
    });
    expect(found?.runtimeRoot).toBe(join("/opt/node/lib/node_modules", "@roarpeng", "graphflow"));
    expect(found?.serverPath).toBe(join(found!.runtimeRoot, "dist", "surfaces", "mcp", "server.js"));

    // npm missing / server.js absent / empty root all fail open to undefined.
    expect(resolveGlobalGraphflowInstall({ runNpmRoot: () => { throw new Error("npm not found"); }, exists: () => true })).toBeUndefined();
    expect(resolveGlobalGraphflowInstall({ runNpmRoot: () => "/x", exists: () => false })).toBeUndefined();
    expect(resolveGlobalGraphflowInstall({ runNpmRoot: () => "", exists: () => true })).toBeUndefined();
  });

  it("resolveGlobalGraphflowInstall tolerates BOM, CRLF and stray banner lines (Windows npm stdout)", () => {
    const expected = (root: string) =>
      join(root, "@roarpeng", "graphflow", "dist", "surfaces", "mcp", "server.js");
    // BOM + CRLF (Windows npm), banner line before the path, blank lines.
    // Pass the npm root per case — do not guess from `path.includes("\\")`.
    // On win32, `path.join("/usr/lib/node_modules", ...)` still contains
    // backslashes, so that heuristic treats a POSIX root as a Windows path
    // and the mock `exists` returns false (`found` undefined).
    for (const { raw, root } of [
      { raw: "\uFEFFC:\\npm\\node_modules\r\n", root: "C:\\npm\\node_modules" },
      { raw: "npm warn config\r\n\r\nC:\\npm\\node_modules\r\n", root: "C:\\npm\\node_modules" },
      { raw: "\n\n/usr/lib/node_modules\n\n", root: "/usr/lib/node_modules" },
    ]) {
      const found = resolveGlobalGraphflowInstall({
        runNpmRoot: () => raw,
        exists: (p) => p === expected(root),
      });
      expect(found).toBeDefined();
      expect(found?.runtimeRoot).toBe(join(root, "@roarpeng", "graphflow"));
    }
  });

  it("on Windows the injected direct entry resolves to an existing node + server.js", () => {
    if (process.platform !== "win32") return; // covered by validate-platforms (windows-latest)
    const probe = resolveGlobalGraphflowInstall();
    if (probe === undefined) return; // no global install on this runner — npx fallback path
    const home = makeTempRoot("gf-zcode-win-direct-");
    mkdirSync(join(home, ".zcode"), { recursive: true });
    withIsolatedHome(home, () => {
      installMcpToDetectedAgents({
        strategy: "npx",
        installScope: "user",
        agentIdsOverride: ["zcode"],
        preferGlobalInstall: true,
      });
      const entry = (JSON.parse(readFileSync(join(home, ".zcode", "cli", "config.json"), "utf8")) as {
        mcp?: { servers?: Record<string, { command?: string; args?: string[] }> };
      }).mcp?.servers?.graphflow;
      // command must be an existing node binary (short-path form allowed) and
      // args[0] must be the globally-installed server.js.
      expect(existsSync(entry?.args?.[0] ?? "")).toBe(true);
      expect(existsSync(entry?.command ?? "") || entry?.command === "node").toBe(true);
    });
  });

  it("adapter installs the full three-piece set and reports status", () => {
    const home = makeTempRoot("gf-zcode-adapter-");
    mkdirSync(join(home, ".zcode"), { recursive: true });

    withIsolatedHome(home, () => {
      const created = installViaHostAdapter("zcode");
      expect(created.hostId).toBe("zcode");
      expect(["created", "injected", "updated"]).toContain(created.status);

      expect(existsSync(join(home, ".zcode", "cli", "config.json"))).toBe(true);
      expect(existsSync(join(home, ".zcode", "skills", "graphflow", "SKILL.md"))).toBe(true);
      const agents = readFileSync(join(home, ".zcode", "AGENTS.md"), "utf8");
      expect(agents).toContain("graphflow");

      const status = getHostAdapterInstallStatus("zcode");
      expect(status?.detected).toBe(true);
      expect(status?.mcpInstalled).toBe(true);
      expect(status?.skillInstalled).toBe(true);
      expect(status?.rulesInstalled).toBe(true);
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
