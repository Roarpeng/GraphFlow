import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GRAPHFLOW_BLOCK_BEGIN,
  GRAPHFLOW_BLOCK_END,
  removeManagedBlockFile,
  stripManagedBlockText,
  upsertManagedBlockText,
  wrapManagedBlock,
  writeManagedBlockFile,
} from "../src/integrations/managed-block";
import { buildCliUsage, buildCommandUsage, parseCliOptions } from "../src/surfaces/cli/output";

const tempRoots: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ISOLATED_ENV_KEYS = [
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "GRAPHFLOW_CONFIG_HOME",
  "GRAPHFLOW_DSH_HOME",
  "DSH_HOME",
  "KIMI_CODE_HOME",
] as const;

/**
 * Every host path derives from these variables; modules capture them on first
 * import, so the registry is reset before and after.
 */
async function withIsolatedHome<T>(run: (home: string) => Promise<T> | T): Promise<T> {
  const home = tmp("gf-m151-home-");
  const saved = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.GRAPHFLOW_CONFIG_HOME = home;
  process.env.GRAPHFLOW_DSH_HOME = join(home, ".dsh");
  process.env.DSH_HOME = join(home, ".dsh");
  delete process.env.KIMI_CODE_HOME;
  mkdirSync(process.env.APPDATA, { recursive: true });
  mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
  vi.resetModules();
  try {
    return await run(home);
  } finally {
    vi.resetModules();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function listTree(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
    }
  };
  walk(root, "");
  return out.sort();
}

describe("managed instruction blocks (CLAUDE.md is the user's file)", () => {
  it("round-trips user text byte-for-byte and is idempotent", () => {
    const user = "# Personal\nMY OWN RULES\n";
    const block = wrapManagedBlock("GraphFlow guidance");
    const installed = upsertManagedBlockText(user, block);
    expect(installed.startsWith(user)).toBe(true);
    expect(installed).toContain(GRAPHFLOW_BLOCK_BEGIN);
    expect(installed).toContain(GRAPHFLOW_BLOCK_END);
    expect(upsertManagedBlockText(installed, block)).toBe(installed);
    expect(stripManagedBlockText(installed)).toBe(user);
  });

  it("installs CLAUDE.md as a block next to user content and uninstall removes only the block", async () => {
    await withIsolatedHome(async (home) => {
      const claudeDir = join(home, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      const file = join(claudeDir, "CLAUDE.md");
      writeFileSync(file, "# Personal\nMY OWN RULES\n", "utf8");
      const skills = await import("../src/integrations/skill-installer");
      const source = skills.resolveClaudeMdSourcePath();
      expect(source).toBeDefined();

      expect(skills.installManagedTemplateFile(source!, file).status).toBe("updated");
      const afterInstall = readFileSync(file, "utf8");
      expect(afterInstall).toContain("MY OWN RULES");
      expect(afterInstall).toContain(GRAPHFLOW_BLOCK_BEGIN);
      expect(skills.isManagedTemplateInstalled(file)).toBe(true);
      expect(skills.installManagedTemplateFile(source!, file).status).toBe("skipped");

      expect(skills.removeGraphFlowOwnedFile(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("# Personal\nMY OWN RULES\n");
    });
  });

  it("treats an unmodified legacy full-file copy as fully managed", async () => {
    await withIsolatedHome(async (home) => {
      const skills = await import("../src/integrations/skill-installer");
      const source = skills.resolveClaudeMdSourcePath()!;
      const file = join(home, ".claude", "CLAUDE.md");
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(file, readFileSync(source, "utf8"), "utf8");

      skills.installManagedTemplateFile(source, file);
      const converted = readFileSync(file, "utf8");
      expect(converted.startsWith(GRAPHFLOW_BLOCK_BEGIN)).toBe(true);
      expect(converted.split(GRAPHFLOW_BLOCK_BEGIN)).toHaveLength(2);

      expect(skills.removeGraphFlowOwnedFile(file)).toBe(true);
      expect(existsSync(file)).toBe(false);
    });
  });

  it("deletes a file that only held the block, keeps a file without one", () => {
    const dir = tmp("gf-m151-block-");
    const owned = join(dir, "AGENTS.md");
    writeManagedBlockFile(owned, wrapManagedBlock("x"));
    expect(removeManagedBlockFile(owned)).toBe(true);
    expect(existsSync(owned)).toBe(false);

    const foreign = join(dir, "NOTES.md");
    writeFileSync(foreign, "mentions graphflow_context but is mine\n");
    expect(removeManagedBlockFile(foreign)).toBe(false);
    expect(readFileSync(foreign, "utf8")).toBe("mentions graphflow_context but is mine\n");
  });
});

describe("doctor/status paths are read-only; install keeps one backup", () => {
  it("reading a Codex TOML config for status writes no .bak", async () => {
    await withIsolatedHome(async (home) => {
      const codex = join(home, ".codex");
      mkdirSync(codex, { recursive: true });
      const toml = join(codex, "config.toml");
      writeFileSync(toml, 'model = "o3"\n\n[mcp_servers.keepme]\ncommand = "echo"\n', "utf8");
      const mcp = await import("../src/integrations/agent-mcp-installer");
      mcp.getMcpInstallStatus();
      mcp.probeMcpEntryPoint(toml, { workspaceRoot: home });
      mcp.probeDanglingGraphflowEntry(toml);
      expect(readdirSync(codex).sort()).toEqual(["config.toml"]);
      expect(readFileSync(toml, "utf8")).toContain("[mcp_servers.keepme]");
    });
  });

  it("a corrupt JSON config is backed up to a single .bak across runs", async () => {
    await withIsolatedHome(async (home) => {
      const cursor = join(home, ".cursor");
      mkdirSync(cursor, { recursive: true });
      const config = join(cursor, "mcp.json");
      const mcp = await import("../src/integrations/agent-mcp-installer");
      for (let run = 0; run < 2; run += 1) {
        writeFileSync(config, "{ not json", "utf8");
        mcp.installMcpToDetectedAgents({ strategy: "npx", agentIdsOverride: ["cursor"], globalInstallOverride: null });
      }
      expect(readdirSync(cursor).filter((name) => name.startsWith("mcp.json.bak"))).toEqual(["mcp.json.bak"]);
    });
  });

  it("uninstall deletes a config it emptied but keeps user servers", async () => {
    const dir = tmp("gf-m151-mcp-");
    const mcp = await import("../src/integrations/agent-mcp-installer");
    const onlyOurs = join(dir, "a.json");
    writeFileSync(onlyOurs, JSON.stringify({ mcpServers: { graphflow: { command: "npx", args: [] } } }));
    expect(mcp.removeMcpEntry(onlyOurs, "mcpServers", "graphflow")).toBe(true);
    expect(existsSync(onlyOurs)).toBe(false);

    const shared = join(dir, "b.json");
    writeFileSync(shared, JSON.stringify({ mcpServers: { graphflow: { command: "npx", args: [] }, keepme: { command: "echo", args: [] } } }));
    mcp.removeMcpEntry(shared, "mcpServers", "graphflow");
    expect(JSON.parse(readFileSync(shared, "utf8"))).toEqual({ mcpServers: { keepme: { command: "echo", args: [] } } });
  });

  it("Claude Code hooks uninstall leaves no settings stub or empty hooks dir", async () => {
    const home = tmp("gf-m151-claude-");
    const settingsPath = join(home, "settings.json");
    const hooksDir = join(home, "graphflow-hooks");
    const hooks = await import("../src/integrations/claude-code-hooks");
    hooks.installClaudeCodeHooks({ settingsPath, hooksDir });
    expect(existsSync(settingsPath)).toBe(true);
    hooks.uninstallClaudeCodeHooks(settingsPath, hooksDir);
    expect(listTree(home)).toEqual([]);
  });
});

describe("only detected hosts are configured", () => {
  it("skips an undetected profile host and writes it only when forced", async () => {
    await withIsolatedHome(async (home) => {
      const profile = await import("../src/integrations/profile-host-installer");
      const skipped = profile.installProfileHost("windsurf");
      expect(skipped?.status).toBe("skipped");
      expect(existsSync(join(home, ".codeium"))).toBe(false);

      const forced = profile.installProfileHost("windsurf", { force: true });
      expect(forced?.status).not.toBe("skipped");
      expect(existsSync(join(home, ".codeium", "windsurf", "mcp_config.json"))).toBe(true);
    });
  });

  it("does not create a secondary target for an app that is not installed", async () => {
    await withIsolatedHome(async (home) => {
      mkdirSync(join(home, ".cursor"), { recursive: true });
      const mcp = await import("../src/integrations/agent-mcp-installer");
      expect(mcp.isUserTargetPresent(join(home, ".cursor", "mcp.json"))).toBe(true);
      expect(mcp.isUserTargetPresent(join(process.env.APPDATA!, "Cursor", "User", "globalStorage", "roval.cursor", "mcp.json"))).toBe(false);
      expect(mcp.isUserTargetPresent(join(home, ".claude.json"))).toBe(true);
      mcp.installMcpToDetectedAgents({ strategy: "npx", globalInstallOverride: null });
      expect(existsSync(join(process.env.APPDATA!, "Cursor"))).toBe(false);
      expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
    });
  });

  it("writes project files only for detected hosts and never into a home-directory root", async () => {
    await withIsolatedHome(async (home) => {
      const skills = await import("../src/integrations/skill-installer");
      const project = tmp("gf-m151-proj-");
      skills.installProjectLevelRules(project, undefined, () => undefined, { detectedHostIds: new Set(["cursor"]) });
      expect(listTree(project)).toEqual([".cursor/", ".cursor/rules/", ".cursor/rules/graphflow.mdc", "AGENTS.md"]);

      const empty = tmp("gf-m151-proj-");
      skills.installProjectLevelRules(empty, undefined, () => undefined, { detectedHostIds: new Set() });
      expect(listTree(empty)).toEqual([]);

      const before = listTree(home);
      skills.installTraeSkills(undefined, home, { detectedHostIds: new Set(["trae"]) });
      skills.installProjectLevelRules(home, undefined, () => undefined, { detectedHostIds: new Set(["cursor", "trae"]) });
      expect(listTree(home)).toEqual(before);
    });
  });

  it("uninstall prunes the directories it emptied", async () => {
    await withIsolatedHome(async (home) => {
      mkdirSync(join(home, ".cursor"), { recursive: true });
      const skills = await import("../src/integrations/skill-installer");
      const project = tmp("gf-m151-proj-");
      writeFileSync(join(project, "keep.txt"), "x");
      skills.installProjectLevelRules(project, undefined, () => undefined, { detectedHostIds: new Set(["cursor"]) });
      skills.installAgentSkills();
      skills.uninstallAllSkillsAndRules(project);
      expect(listTree(project)).toEqual(["keep.txt"]);
      expect(listTree(join(home, ".cursor"))).toEqual([]);
    });
  });

  it("doctor reports one verdict per host and DSH glue is n/a without the dsh package", async () => {
    await withIsolatedHome(async (home) => {
      mkdirSync(join(home, ".dsh", "profiles", "web"), { recursive: true });
      writeFileSync(join(home, ".dsh", "profiles", "web", "package.json"), JSON.stringify({ name: "p", private: true }));
      const hostInstall = await import("../src/integrations/host-adapter-install");
      hostInstall.installViaHostAdapter("deepseek-harness");
      const init = await import("../src/surfaces/cli/init");
      const report = init.buildDoctorReport(tmp("gf-m151-proj-"));
      const glue = report.checks.find((check) => check.agent === "DeepSeek Harness glue");
      expect(glue?.status).toBe("n/a");
      expect(report.hosts.find((host) => host.hostId === "deepseek-harness")?.verdict).toBe("installed");
      for (const host of report.hosts) {
        const own = report.checks.filter((check) => check.hostId === host.hostId);
        expect(host.missing).toBe(own.filter((check) => check.status === "missing").length);
      }
    });
  });
});

describe("CLI arguments", () => {
  it("treats --help/-h after a command as a help request, not an argument", () => {
    expect(parseCliOptions(["graph", "index", "--help"])).toMatchObject({ command: "graph", args: ["index"], help: true });
    expect(parseCliOptions(["install", "-h"])).toMatchObject({ command: "install", args: [], help: true });
    expect(parseCliOptions(["--help"])).toMatchObject({ command: "--help", args: [] });
    expect(parseCliOptions(["--help"]).help).toBeUndefined();
    expect(buildCommandUsage("graph", ["index"])).toContain("graph index [path]");
    expect(buildCommandUsage("graph", ["index"])).not.toContain("graph file");
  });

  it("documents the new install / preview flags", () => {
    const usage = buildCliUsage();
    expect(usage).toContain("--no-record");
    expect(usage).toContain("--all-hosts");
    expect(usage).toContain("--host <id[,id]>");
    expect(usage).toContain("uninstall [--json]");
    expect(usage).toMatch(/--skip-deps.*embedding model/);
  });

  it("`graph index --help` prints usage, exits 0 and indexes nothing", () => {
    const home = tmp("gf-m151-cli-home-");
    const cwd = tmp("gf-m151-cli-cwd-");
    const repo = resolve(__dirname, "..");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"),
      GRAPHFLOW_CONFIG_HOME: home,
      GRAPHFLOW_DSH_HOME: join(home, ".dsh"),
      DSH_HOME: join(home, ".dsh"),
    };
    delete env.VITEST;
    delete env.VITEST_WORKER_ID;
    const result = spawnSync(
      process.execPath,
      [join(repo, "node_modules", "tsx", "dist", "cli.mjs"), join(repo, "src", "surfaces", "cli", "index.ts"), "graph", "index", "--help"],
      { cwd, env, encoding: "utf8", timeout: 120_000 }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("graph index [path]");
    expect(listTree(cwd)).toEqual([]);
    expect(listTree(home)).toEqual([]);
  }, 150_000);
});
