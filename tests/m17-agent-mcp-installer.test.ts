import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMcpServerNode,
  detectInstalledAgents,
  getMcpInstallStatus,
  installMcpToDetectedAgents,
  resolveMcpNodeLaunch,
  resolveSystemNodeCommand,
} from "../src/integrations/agent-mcp-installer";

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("M17 agent MCP installer", () => {
  it("builds npx and bundled MCP nodes", () => {
    const npxNode = buildMcpServerNode({ strategy: "npx", workspaceRoot: "/repo" });
    if (process.platform === "win32") {
      expect(npxNode.args).toEqual(
        expect.arrayContaining(["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"])
      );
    } else {
      expect(npxNode.command).toContain("npx");
      expect(npxNode.args).toEqual(["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"]);
    }
    expect(npxNode.cwd).toBe("/repo");
    expect(npxNode.env).toMatchObject({
      GRAPHFLOW_WORKSPACE_ROOT: "/repo",
      GRAPHFLOW_MCP_STDIO: "1",
      GRAPHFLOW_LOG_JSON: "1",
    });

    const nodeCommand = existsSync("/usr/bin/node") ? "/usr/bin/node" : process.execPath;

    const bundledNode = buildMcpServerNode({
      strategy: "node-bundled",
      bundledServerPath: "/tmp/server.js",
      bundledRuntimeRoot: "/tmp/runtime",
      nodeCommand,
    });
    expect(bundledNode.command).toBe(nodeCommand);
    expect(bundledNode.args).toEqual(["/tmp/server.js"]);
    expect(bundledNode.cwd).toBe("/tmp/runtime");
    expect(bundledNode.env).toMatchObject({
      GRAPHFLOW_MCP_STDIO: "1",
      GRAPHFLOW_LOG_JSON: "1",
    });
    // GRAPHFLOW_WORKSPACE_ROOT is omitted when no workspaceRoot is provided,
    // allowing the MCP server to discover the workspace at runtime.
    expect(bundledNode.env?.GRAPHFLOW_WORKSPACE_ROOT).toBeUndefined();

    const winLauncher = "C:\\ext\\mcp-launcher.cmd";
    const unixLauncher = "/ext/mcp-launcher.cjs";
    const launcherNode = buildMcpServerNode({
      strategy: "node-bundled",
      bundledServerPath: "/tmp/server.js",
      bundledRuntimeRoot: "/tmp/runtime",
      launcherPath: process.platform === "win32" ? winLauncher : unixLauncher,
      nodeCommand,
      workspaceRoot: "/repo",
    });
    if (process.platform === "win32") {
      expect(launcherNode.command).toBe(winLauncher);
      expect(launcherNode.args).toEqual([]);
    } else {
      expect(launcherNode.command).toBe(nodeCommand);
      expect(launcherNode.args).toEqual([unixLauncher]);
    }
    expect(launcherNode.cwd).toBeUndefined();
    expect(launcherNode.env).toMatchObject({
      GRAPHFLOW_WORKSPACE_ROOT: "/repo",
    });
  });

  it("creates MCP config when agent marker exists", () => {
    const fakeHome = createTempRoot("graphflow-agent-home");
    const workspaceRoot = createTempRoot("graphflow-agent-workspace");
    const cursorMarker = join(fakeHome, ".cursor");
    mkdirSync(cursorMarker, { recursive: true });

    const previousHome = process.env.USERPROFILE ?? process.env.HOME;
    if (process.platform === "win32") {
      process.env.USERPROFILE = fakeHome;
    } else {
      process.env.HOME = fakeHome;
    }

    try {
      const detected = detectInstalledAgents();
      expect(detected.some((agent) => agent.id === "cursor")).toBe(true);

      const results = installMcpToDetectedAgents({
        strategy: "npx",
        workspaceRoot,
        installScope: "all",
        agentIdsOverride: ["cursor"],
      });

      const userResult = results.find((result) => result.scope === "user" && result.agentId === "cursor");
      expect(userResult?.status).toBe("created");
      expect(existsSync(join(fakeHome, ".cursor", "mcp.json"))).toBe(true);

      const workspaceResult = results.find(
        (result) => result.scope === "workspace" && result.agentId === "cursor"
      );
      expect(workspaceResult?.status).toBe("created");

      const userConfig = JSON.parse(readFileSync(join(fakeHome, ".cursor", "mcp.json"), "utf8")) as {
        mcpServers?: Record<string, { command: string; args: string[] }>;
      };
      expect(userConfig.mcpServers?.graphflow?.args).toEqual(
        expect.arrayContaining(["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"])
      );
    } finally {
      if (process.platform === "win32") {
        if (previousHome) {
          process.env.USERPROFILE = previousHome;
        } else {
          delete process.env.USERPROFILE;
        }
      } else if (previousHome) {
        process.env.HOME = previousHome;
      } else {
        delete process.env.HOME;
      }
    }
  });

  it("defaults to user scope without workspace MCP config", () => {
    const fakeHome = createTempRoot("graphflow-agent-home-user-only");
    const workspaceRoot = createTempRoot("graphflow-agent-workspace-user-only");
    const cursorMarker = join(fakeHome, ".cursor");
    mkdirSync(cursorMarker, { recursive: true });

    const previousHome = process.env.USERPROFILE ?? process.env.HOME;
    if (process.platform === "win32") {
      process.env.USERPROFILE = fakeHome;
    } else {
      process.env.HOME = fakeHome;
    }

    try {
      const results = installMcpToDetectedAgents({
        strategy: "npx",
        workspaceRoot,
        agentIdsOverride: ["cursor"],
      });

      expect(results.some((result) => result.scope === "user" && result.status === "created")).toBe(true);
      expect(results.some((result) => result.scope === "workspace")).toBe(false);
    } finally {
      if (process.platform === "win32") {
        if (previousHome) {
          process.env.USERPROFILE = previousHome;
        } else {
          delete process.env.USERPROFILE;
        }
      } else if (previousHome) {
        process.env.HOME = previousHome;
      } else {
        delete process.env.HOME;
      }
    }
  });

  it("returns skipped result when no agents are selected", () => {
    const results = installMcpToDetectedAgents({ strategy: "npx", agentIdsOverride: [] });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("skipped");
  });

  it("reports MCP install status for detected agents", () => {
    const fakeHome = createTempRoot("graphflow-agent-home-status");
    const cursorMarker = join(fakeHome, ".cursor");
    mkdirSync(cursorMarker, { recursive: true });
    const mcpPath = join(fakeHome, ".cursor", "mcp.json");

    const previousHome = process.env.USERPROFILE ?? process.env.HOME;
    if (process.platform === "win32") {
      process.env.USERPROFILE = fakeHome;
    } else {
      process.env.HOME = fakeHome;
    }

    try {
      let statuses = getMcpInstallStatus();
      expect(statuses.some((item) => item.agentId === "cursor" && !item.installed)).toBe(true);

      installMcpToDetectedAgents({ strategy: "npx", agentIdsOverride: ["cursor"] });
      statuses = getMcpInstallStatus();
      expect(statuses.some((item) => item.configPath === mcpPath && item.installed)).toBe(true);
    } finally {
      if (process.platform === "win32") {
        if (previousHome) {
          process.env.USERPROFILE = previousHome;
        } else {
          delete process.env.USERPROFILE;
        }
      } else if (previousHome) {
        process.env.HOME = previousHome;
      } else {
        delete process.env.HOME;
      }
    }
  });

  it("writes Codex MCP config into config.toml", () => {
    const fakeHome = createTempRoot("graphflow-agent-home-codex");
    const codexDir = join(fakeHome, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const configPath = join(codexDir, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5"\n', "utf8");

    const previousHome = process.env.USERPROFILE ?? process.env.HOME;
    if (process.platform === "win32") {
      process.env.USERPROFILE = fakeHome;
    } else {
      process.env.HOME = fakeHome;
    }

    try {
      const results = installMcpToDetectedAgents({
        strategy: "npx",
        agentIdsOverride: ["codex"],
      });
      expect(results.some((result) => result.agentId === "codex" && result.status !== "error")).toBe(true);
      const raw = readFileSync(configPath, "utf8");
      expect(raw).toContain("[mcp_servers.graphflow]");
      expect(getMcpInstallStatus().some((item) => item.agentId === "codex" && item.installed)).toBe(true);
    } finally {
      if (process.platform === "win32") {
        if (previousHome) {
          process.env.USERPROFILE = previousHome;
        } else {
          delete process.env.USERPROFILE;
        }
      } else if (previousHome) {
        process.env.HOME = previousHome;
      } else {
        delete process.env.HOME;
      }
    }
  });

  it("rejects ephemeral fnm node paths and falls back to system node or electron", () => {
    const launch = resolveMcpNodeLaunch({
      nodeCommand: "/run/user/1000/fnm_multishells/202671_1781939913391/bin/node",
      electronExecPath: process.execPath,
    });
    // fnm path should be rejected; system Node is preferred over Electron when available
    const systemNode = resolveSystemNodeCommand();
    if (systemNode && systemNode !== "node") {
      expect(launch.command).toBe(systemNode);
      expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    } else {
      // No system Node → Electron fallback
      expect(launch.command).toBe(process.execPath);
      expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
    }
  });

  it("updates Trae CN mcp.json when marker exists", () => {
    const fakeHome = createTempRoot("graphflow-trae-cn-home");
    const traeCnConfigDir = join(fakeHome, ".config", "Trae CN", "User");
    mkdirSync(traeCnConfigDir, { recursive: true });
    mkdirSync(join(fakeHome, ".trae-cn"), { recursive: true });

    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      const results = installMcpToDetectedAgents({
        strategy: "npx",
        workspaceRoot: "/repo",
        agentIdsOverride: ["trae"],
      });
      const traeResult = results.find((result) => result.configPath.includes("Trae CN"));
      expect(traeResult?.status).toMatch(/created|updated|injected/);
      const config = JSON.parse(readFileSync(join(traeCnConfigDir, "mcp.json"), "utf8")) as {
        mcpServers?: { graphflow?: { command: string; env?: Record<string, string> } };
      };
      expect(config.mcpServers?.graphflow?.command).not.toContain("fnm_multishells");
      expect(config.mcpServers?.graphflow?.env?.GRAPHFLOW_WORKSPACE_ROOT).toBe("/repo");
    } finally {
      if (previousHome) {
        process.env.HOME = previousHome;
      } else {
        delete process.env.HOME;
      }
    }
  });
});
