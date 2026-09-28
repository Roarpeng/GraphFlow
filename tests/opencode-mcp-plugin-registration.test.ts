import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While developing GraphFlow, opencode must launch *this* workspace's build, not
 * whatever npm published. A plain entry pinned to the published package looks
 * completely healthy while loading none of your edits.
 *
 * These tests pin the two things that make that work and keep working:
 * the marker records which checkout was chosen, and the injection honours it.
 *
 * Isolation note: agent profiles call `resolveHomePaths()` and register
 * themselves at *module load*, so redirecting `HOME` after the import is too
 * late. Each test resets the module registry and re-imports, which is the only
 * way to make the registry resolve the sandbox rather than the real
 * `~/.config/opencode`.
 */

const tempRoots: string[] = [];
let previousHome: string | undefined;
let sandboxHome: string;
let openCodeHome: string;
let configPath: string;

type Installer = typeof import("../src/integrations/agent-mcp-installer");
type PluginModule = typeof import("../src/integrations/opencode-plugin");

/** Point HOME at the sandbox, then re-import so profiles register against it. */
async function loadWithSandboxHome(): Promise<{ installer: Installer; plugin: PluginModule }> {
  vi.resetModules();
  const installer = (await import("../src/integrations/agent-mcp-installer")) as Installer;
  const plugin = (await import("../src/integrations/opencode-plugin")) as PluginModule;
  return { installer, plugin };
}

function writeConfigWithEntry(): void {
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        mcp: {
          graphflow: {
            type: "local",
            command: ["node", "/published/graphflow/dist/surfaces/mcp/server.js"],
            enabled: true,
          },
          pencil: { type: "local", command: ["pencil-mcp"] },
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function readEntry(): { command?: string[]; environment?: Record<string, string> } {
  const json = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcp?: Record<string, { command?: string[]; environment?: Record<string, string> }>;
  };
  return json.mcp?.graphflow ?? {};
}

function readServerNames(): string[] {
  const json = JSON.parse(readFileSync(configPath, "utf8")) as { mcp?: Record<string, unknown> };
  return Object.keys(json.mcp ?? {});
}

/** Create the build the marker will point at, so the happy path is reachable. */
function createWorkspaceBuild(workspaceRoot: string): string {
  const serverPath = join(workspaceRoot, "dist", "surfaces", "mcp", "server.js");
  mkdirSync(join(workspaceRoot, "dist", "surfaces", "mcp"), { recursive: true });
  writeFileSync(serverPath, "// test build\n", "utf8");
  return serverPath;
}

/** Mirrors the installer's own opencode options, minus global-install drift. */
function runInstall(installer: Installer): Array<{ agentId: string; status: string; message?: string }> {
  return installer.installMcpToDetectedAgents({
    strategy: "npx",
    installScope: "user",
    agentIdsOverride: ["opencode"],
    preferGlobalInstall: true,
    globalInstallOverride: null,
  });
}

beforeEach(() => {
  previousHome = process.env.HOME;
  sandboxHome = mkdtempSync(join(tmpdir(), "gf-oc-mcp-"));
  tempRoots.push(sandboxHome);
  openCodeHome = join(sandboxHome, ".config", "opencode");
  configPath = join(openCodeHome, "opencode.json");
  mkdirSync(join(openCodeHome, "plugins"), { recursive: true });
  process.env.HOME = sandboxHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  vi.resetModules();
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("opencode launches the workspace build when opted in", () => {
  it("points the entry at the recorded workspace build", async () => {
    writeConfigWithEntry();
    const workspace = mkdtempSync(join(tmpdir(), "gf-oc-ws-"));
    tempRoots.push(workspace);
    const serverPath = createWorkspaceBuild(workspace);
    const { installer, plugin } = await loadWithSandboxHome();
    plugin.setOpenCodeMcpRegistration({ enabled: true, workspaceRoot: workspace });

    const result = runInstall(installer).find((r) => r.agentId === "opencode");

    expect(readEntry().command?.[1]).toBe(serverPath);
    expect(result?.status).not.toBe("error");
    expect(result?.message).toContain(serverPath);
  });

  it("records the workspace rather than assuming the current directory", async () => {
    const { plugin } = await loadWithSandboxHome();
    const workspace = mkdtempSync(join(tmpdir(), "gf-oc-ws-"));
    tempRoots.push(workspace);

    const set = plugin.setOpenCodeMcpRegistration({ enabled: true, workspaceRoot: workspace });
    // `install` can be run from anywhere. A marker that silently pointed at the
    // wrong checkout would write a plausible-looking entry that launches a stale
    // build, which is the exact failure this whole feature exists to prevent.
    expect(set.workspaceRoot).toBe(workspace);
    expect(plugin.getOpenCodeMcpRegistration().workspaceRoot).toBe(workspace);
    expect(plugin.openCodeWorkspaceServerPath(workspace)).toBe(
      join(workspace, "dist", "surfaces", "mcp", "server.js")
    );
  });

  it("keeps the recorded workspace when a later install omits it", async () => {
    const { plugin } = await loadWithSandboxHome();
    const workspace = mkdtempSync(join(tmpdir(), "gf-oc-ws-"));
    tempRoots.push(workspace);
    plugin.setOpenCodeMcpRegistration({ enabled: true, workspaceRoot: workspace });

    // Omitting workspaceRoot must not silently re-point at process.cwd().
    const set = plugin.setOpenCodeMcpRegistration({ enabled: true });
    expect(set.workspaceRoot).toBe(workspace);
    expect(set.status).toBe("unchanged");
  });

  it("reports an actionable error when the workspace has no build", async () => {
    writeConfigWithEntry();
    const workspace = mkdtempSync(join(tmpdir(), "gf-oc-ws-"));
    tempRoots.push(workspace);
    const { installer, plugin } = await loadWithSandboxHome();
    plugin.setOpenCodeMcpRegistration({ enabled: true, workspaceRoot: workspace });

    const result = runInstall(installer).find((r) => r.agentId === "opencode");

    // Better to fail loudly and name both escapes than to write an entry that
    // points at a file which is not there.
    expect(result?.status).toBe("error");
    expect(result?.message).toMatch(/npm run build/);
    expect(result?.message).toMatch(/--no-mcp-plugin/);
    expect(readEntry().command?.[1]).toContain("/published/");
  });

  it("restores the published entry once the opt-in is withdrawn", async () => {
    writeConfigWithEntry();
    const workspace = mkdtempSync(join(tmpdir(), "gf-oc-ws-"));
    tempRoots.push(workspace);
    createWorkspaceBuild(workspace);
    const { installer, plugin } = await loadWithSandboxHome();
    plugin.setOpenCodeMcpRegistration({ enabled: true, workspaceRoot: workspace });
    runInstall(installer);
    expect(readEntry().command?.[1]).toBe(join(workspace, "dist", "surfaces", "mcp", "server.js"));

    // Without this arm the opt-in would be a one-way door: turning it off would
    // leave the user pinned to a build that may be deleted.
    plugin.setOpenCodeMcpRegistration({ enabled: false });
    runInstall(installer);
    expect(readEntry().command?.[1]).not.toContain("gf-oc-ws-");
  });

  it("keeps injecting normally when no marker exists", async () => {
    writeConfigWithEntry();
    const { installer, plugin } = await loadWithSandboxHome();
    expect(plugin.getOpenCodeMcpRegistration().enabled).toBe(false);

    runInstall(installer);
    // No opt-in means the ordinary installer decision, which is the npx launcher
    // (or a global install when one exists) — never a workspace build.
    const command = (readEntry().command ?? []).join(" ");
    expect(command).not.toContain("dist/surfaces/mcp/server.js");
  });

  it("treats a corrupt marker as opted out rather than throwing", async () => {
    writeFileSync(join(openCodeHome, "plugins", "graphflow-mcp.json"), "{ not json", "utf8");
    const { plugin } = await loadWithSandboxHome();

    expect(plugin.getOpenCodeMcpRegistration().status).toBe("error");
    expect(plugin.getOpenCodeMcpRegistration().enabled).toBe(false);
  });

  it("leaves other agents' entries in opencode.json alone", async () => {
    writeConfigWithEntry();
    const workspace = mkdtempSync(join(tmpdir(), "gf-oc-ws-"));
    tempRoots.push(workspace);
    createWorkspaceBuild(workspace);
    const { installer, plugin } = await loadWithSandboxHome();
    plugin.setOpenCodeMcpRegistration({ enabled: true, workspaceRoot: workspace });

    runInstall(installer);
    expect(readServerNames()).toContain("pencil");
    expect(readFileSync(configPath, "utf8")).toContain("pencil-mcp");
    expect(existsSync(configPath)).toBe(true);
  });

  it("agrees on the config path, so the marker is read from the home it writes to", async () => {
    const { installer, plugin } = await loadWithSandboxHome();
    // A marker read from one home while the installer writes to another would
    // make the opt-in silently inert.
    expect(plugin.resolveOpenCodeHome()).toBe(openCodeHome);
    const profile = installer.buildAgentProfiles().find((p) => p.id === "opencode");
    expect(profile?.userTargets?.[0]?.configPath).toBe(configPath);
  });
});
