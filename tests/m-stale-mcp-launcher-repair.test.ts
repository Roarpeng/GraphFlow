import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findMissingGraphFlowMcpLauncher,
  isGraphFlowMcpLauncherPath,
  repairStaleGraphFlowMcpLaunchers,
} from "../src/integrations/agent-mcp-installer";

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

describe("stale GraphFlow mcp-launcher repair", () => {
  it("detects mcp-launcher path basenames", () => {
    expect(isGraphFlowMcpLauncherPath("/x/mcp-launcher.cjs")).toBe(true);
    expect(isGraphFlowMcpLauncherPath("C:\\ext\\mcp-launcher.cmd")).toBe(true);
    expect(isGraphFlowMcpLauncherPath("/x/server.js")).toBe(false);
  });

  it("finds missing launcher args without rewriting present ones", () => {
    const dir = makeTempRoot("gf-stale-launcher-");
    const present = join(dir, "mcp-launcher.cjs");
    writeFileSync(present, "ok\n", "utf8");
    expect(
      findMissingGraphFlowMcpLauncher({
        command: "node",
        args: [present],
      })
    ).toBeUndefined();
    expect(
      findMissingGraphFlowMcpLauncher({
        command: "node",
        args: [join(dir, "missing", "mcp-launcher.cjs")],
      })
    ).toContain("mcp-launcher.cjs");
  });

  it("rewrites user and workspace Cursor mcp.json when launcher path is gone", () => {
    const dir = makeTempRoot("gf-stale-repair-");
    const userConfig = join(dir, "user-mcp.json");
    const workspaceRoot = join(dir, "project");
    const workspaceConfig = join(workspaceRoot, ".cursor", "mcp.json");
    mkdirSync(join(workspaceRoot, ".cursor"), { recursive: true });

    const staleLauncher = join(dir, "roarpeng.graphflow-1.9.6", "mcp-launcher.cjs");
    const currentLauncher = join(dir, "roarpeng.graphflow-1.9.11-universal", "mcp-launcher.cjs");
    mkdirSync(join(dir, "roarpeng.graphflow-1.9.11-universal"), { recursive: true });
    writeFileSync(currentLauncher, "console.log('ok')\n", "utf8");

    const staleEntry = {
      mcpServers: {
        graphflow: {
          command: "/usr/bin/node",
          args: [staleLauncher],
          env: {
            GRAPHFLOW_MCP_STDIO: "1",
            GRAPHFLOW_LOG_JSON: "1",
          },
        },
      },
    };
    writeFileSync(userConfig, `${JSON.stringify(staleEntry, null, 2)}\n`, "utf8");
    writeFileSync(workspaceConfig, `${JSON.stringify(staleEntry, null, 2)}\n`, "utf8");

    const results = repairStaleGraphFlowMcpLaunchers({
      launcherPath: currentLauncher,
      workspaceRoot,
      targets: [
        {
          agentId: "cursor",
          agentName: "Cursor",
          configPath: userConfig,
          serversKey: "mcpServers",
        },
        {
          agentId: "cursor",
          agentName: "Cursor (workspace)",
          configPath: workspaceConfig,
          serversKey: "mcpServers",
        },
      ],
    });

    expect(results.filter((r) => r.repaired)).toHaveLength(2);
    for (const path of [userConfig, workspaceConfig]) {
      const next = JSON.parse(readFileSync(path, "utf8")).mcpServers.graphflow;
      expect(next.command).toBe("/usr/bin/node");
      expect(next.args).toEqual([currentLauncher]);
      expect(next.env.GRAPHFLOW_MCP_STDIO).toBe("1");
    }
  });

  it("does not rewrite when the existing launcher still exists", () => {
    const dir = makeTempRoot("gf-stale-ok-");
    const configPath = join(dir, "mcp.json");
    const currentLauncher = join(dir, "mcp-launcher.cjs");
    const otherLauncher = join(dir, "other-mcp-launcher.cjs");
    writeFileSync(currentLauncher, "ok\n", "utf8");
    writeFileSync(otherLauncher, "ok\n", "utf8");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            graphflow: {
              command: "node",
              args: [otherLauncher],
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const results = repairStaleGraphFlowMcpLaunchers({
      launcherPath: currentLauncher,
      targets: [
        {
          agentId: "cursor",
          agentName: "Cursor",
          configPath,
          serversKey: "mcpServers",
        },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.repaired).toBe(false);
    const after = JSON.parse(readFileSync(configPath, "utf8")).mcpServers.graphflow;
    expect(after.args).toEqual([otherLauncher]);
  });
});
