import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * opencode is the one host where a config entry and plugin registration compete,
 * and opencode prefers the config entry. These tests pin the arrangement local
 * development depends on: with the plugin opted in, no code path may write a
 * graphflow entry into opencode.json.
 *
 * The enforcement lives in `installMcpToDetectedAgents` rather than in an
 * installer slice because a slice-level guard was measurably insufficient — the
 * global install pass re-added the entry right after the slice removed it.
 *
 * Isolation note: agent profiles call `resolveHomePaths()` and register
 * themselves at *module load*, so redirecting `HOME` after the import is too
 * late. Each test therefore resets the module registry and re-imports, which is
 * the only way to make the registry resolve the sandbox rather than the real
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

function readServerNames(): string[] {
  const json = JSON.parse(readFileSync(configPath, "utf8")) as { mcp?: Record<string, unknown> };
  return Object.keys(json.mcp ?? {});
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

describe("opencode MCP plugin registration", () => {
  it("removes the config entry when the plugin is opted in, and reports it", async () => {
    writeConfigWithEntry();
    const { installer, plugin } = await loadWithSandboxHome();
    expect(plugin.setOpenCodeMcpRegistration({ enabled: true }).status).toBe("created");

    const opencode = runInstall(installer).find((r) => r.agentId === "opencode");

    // The entry is what outranks plugin registration, so it has to go.
    expect(readServerNames()).toEqual(["pencil"]);
    expect(opencode?.status).toBe("updated");
    expect(opencode?.message).toMatch(/removed the graphflow entry/i);
  });

  it("re-adds the config entry once the plugin opt-in is withdrawn", async () => {
    writeConfigWithEntry();
    const { installer, plugin } = await loadWithSandboxHome();
    plugin.setOpenCodeMcpRegistration({ enabled: true });
    runInstall(installer);
    expect(readServerNames()).toEqual(["pencil"]);

    // Without this arm the opt-in would be a one-way door: turning it off would
    // silently leave the user with no registration at all.
    plugin.setOpenCodeMcpRegistration({ enabled: false });
    runInstall(installer);
    expect(readServerNames()).toContain("graphflow");
  });

  it("keeps injecting normally when no marker exists", async () => {
    writeConfigWithEntry();
    const { installer, plugin } = await loadWithSandboxHome();
    expect(plugin.getOpenCodeMcpRegistration().enabled).toBe(false);

    runInstall(installer);
    expect(readServerNames()).toContain("graphflow");
  });

  it("treats a corrupt marker as opted out rather than throwing", async () => {
    writeFileSync(join(openCodeHome, "plugins", "graphflow-mcp.json"), "{ not json", "utf8");
    const { plugin } = await loadWithSandboxHome();

    expect(plugin.getOpenCodeMcpRegistration().status).toBe("error");
    expect(plugin.getOpenCodeMcpRegistration().enabled).toBe(false);
  });

  it("leaves other agents' entries in opencode.json alone", async () => {
    writeConfigWithEntry();
    const { installer, plugin } = await loadWithSandboxHome();
    plugin.setOpenCodeMcpRegistration({ enabled: true });

    runInstall(installer);
    expect(readFileSync(configPath, "utf8")).toContain("pencil-mcp");
    expect(existsSync(configPath)).toBe(true);
  });

  it("agrees on the config path, so the marker is read from the home it writes to", async () => {
    const { installer, plugin } = await loadWithSandboxHome();
    // A marker read from one home while the installer writes to another would
    // make the opt-in silently inert. This is the check that would have caught
    // the earlier split, where the guard keyed off `resolveOpenCodeHome` and the
    // registry keyed off the loaded profile.
    expect(plugin.resolveOpenCodeHome()).toBe(openCodeHome);
    const profile = installer.buildAgentProfiles().find((p) => p.id === "opencode");
    expect(profile?.userTargets?.[0]?.configPath).toBe(configPath);
  });
});
