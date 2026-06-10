import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMcpServerNode,
  detectInstalledAgents,
  installMcpToDetectedAgents,
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
    expect(npxNode.command).toContain("npx");
    expect(npxNode.args).toEqual(["-y", "graphflow-mcp"]);
    expect(npxNode.cwd).toBe("/repo");

    const bundledNode = buildMcpServerNode({
      strategy: "node-bundled",
      bundledServerPath: "/tmp/server.js",
      bundledRuntimeRoot: "/tmp/runtime",
      nodeCommand: "/usr/bin/node",
    });
    expect(bundledNode.command).toBe("/usr/bin/node");
    expect(bundledNode.args).toEqual(["/tmp/server.js"]);
    expect(bundledNode.cwd).toBe("/tmp/runtime");
    expect(bundledNode.env).toMatchObject({
      GRAPHFLOW_MCP_STDIO: "1",
      GRAPHFLOW_LOG_JSON: "1",
    });

    const launcherNode = buildMcpServerNode({
      strategy: "node-bundled",
      bundledServerPath: "/tmp/server.js",
      bundledRuntimeRoot: "/tmp/runtime",
      launcherPath: "C:\\ext\\mcp-launcher.cmd",
      nodeCommand: "/usr/bin/node",
    });
    expect(launcherNode.command).toBe("C:\\ext\\mcp-launcher.cmd");
    expect(launcherNode.args).toEqual([]);
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
      expect(userConfig.mcpServers?.graphflow?.args).toEqual(["-y", "graphflow-mcp"]);
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
});
