import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  buildAgentProfiles,
  buildMcpServerNode,
  installMcpToDetectedAgents,
} from "../src/integrations/agent-mcp-installer";
import {
  getAntigravityInstallStatus,
  getCopilotInstallStatus,
  getProjectLevelRuleTargets,
  installProjectGeminiInstructions,
  installProjectLevelRules,
} from "../src/integrations/skill-installer";

describe("M63 Antigravity / Gemini / Copilot install", () => {
  it("Antigravity profile uses ~/.gemini/antigravity/mcp_config.json not VS Code mcp.json", () => {
    const profile = buildAgentProfiles().find((p) => p.id === "antigravity");
    expect(profile).toBeDefined();
    const paths = profile!.userTargets.map((t) => t.configPath);
    expect(paths).toContain(join(homedir(), ".gemini", "antigravity", "mcp_config.json"));
    expect(paths.some((p) => p.includes("Code") && p.endsWith("mcp.json"))).toBe(false);
    expect(profile!.userTargets.every((t) => t.serversKey === "mcpServers")).toBe(true);
    expect(profile!.workspaceRelativePaths?.[0]?.relativePath).toBe(
      join(".agents", "mcp_config.json")
    );
  });

  it("Gemini profile includes shared ~/.gemini/config/mcp_config.json", () => {
    const profile = buildAgentProfiles().find((p) => p.id === "gemini");
    expect(profile).toBeDefined();
    const paths = profile!.userTargets.map((t) => t.configPath);
    expect(paths).toContain(join(homedir(), ".gemini", "settings.json"));
    expect(paths).toContain(join(homedir(), ".gemini", "config", "mcp_config.json"));
  });

  it("user-scope MCP node omits GRAPHFLOW_WORKSPACE_ROOT", () => {
    const prev = process.env.GRAPHFLOW_WORKSPACE_ROOT;
    process.env.GRAPHFLOW_WORKSPACE_ROOT = "/should/not/leak";
    try {
      const node = buildMcpServerNode({
        strategy: "npx",
        workspaceRoot: undefined,
      });
      expect(node.env?.GRAPHFLOW_WORKSPACE_ROOT).toBeUndefined();
    } finally {
      if (prev === undefined) {
        delete process.env.GRAPHFLOW_WORKSPACE_ROOT;
      } else {
        process.env.GRAPHFLOW_WORKSPACE_ROOT = prev;
      }
    }
  });

  it("Windows node-bundled command avoids spaces for Trae-style unquoted spawn", () => {
    if (process.platform !== "win32") {
      return;
    }
    const spacedNode = "C:\\Program Files\\nodejs\\node.exe";
    if (!existsSync(spacedNode)) {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "gf-mcp-space-"));
    const launcher = join(dir, "mcp-launcher.cjs");
    const server = join(dir, "server.js");
    writeFileSync(launcher, "console.log('ok')\n", "utf8");
    writeFileSync(server, "console.log('server')\n", "utf8");
    try {
      const node = buildMcpServerNode({
        strategy: "node-bundled",
        bundledServerPath: server,
        launcherPath: launcher,
        nodeCommand: spacedNode,
      });
      expect(node.command).not.toMatch(/\s/);
      expect(existsSync(node.command) || node.command === "node").toBe(true);
      expect(node.args[0]).toBe(launcher);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizeMcpServerNodeForWindowsClients rewrites spaced Program Files command", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const spacedNode = "C:\\Program Files\\nodejs\\node.exe";
    if (!existsSync(spacedNode)) {
      return;
    }
    const { sanitizeMcpServerNodeForWindowsClients } = await import(
      "../src/integrations/agent-mcp-installer"
    );
    const sanitized = sanitizeMcpServerNodeForWindowsClients({
      command: spacedNode,
      args: ["launcher.cjs"],
    });
    expect(sanitized.command).not.toMatch(/\s/);
    expect(sanitized.command === "node" || existsSync(sanitized.command)).toBe(true);
  });

  it("repairUnsafeWindowsMcpCommands rewrites existing Trae-style mcp.json in place", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const spacedNode = "C:\\Program Files\\nodejs\\node.exe";
    if (!existsSync(spacedNode)) {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "gf-mcp-repair-"));
    const configPath = join(dir, "mcp.json");
    const launcher = join(dir, "mcp-launcher.cjs");
    writeFileSync(launcher, "console.log('ok')\n", "utf8");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            graphflow: {
              command: spacedNode,
              args: [launcher],
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );
    try {
      const { repairUnsafeWindowsMcpCommands } = await import(
        "../src/integrations/agent-mcp-installer"
      );
      const results = repairUnsafeWindowsMcpCommands("graphflow", {
        targets: [
          {
            agentId: "trae-solo-cn",
            agentName: "TRAE SOLO CN",
            configPath,
            serversKey: "mcpServers",
          },
        ],
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.repaired).toBe(true);
      expect(results[0]?.afterCommand).not.toMatch(/\s/);

      const after = JSON.parse(readFileSync(configPath, "utf8")).mcpServers.graphflow;
      expect(after.command).not.toMatch(/\s/);
      expect(after.command === "node" || existsSync(after.command)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs Antigravity rules, skills, Copilot instructions, and project GEMINI.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "gf-agents-"));
    const targets = getProjectLevelRuleTargets(dir);
    expect(targets.map((t) => t.agent)).toEqual(
      expect.arrayContaining([
        "Antigravity (project rules)",
        "Antigravity (project skills)",
        "GitHub Copilot (project instructions)",
      ])
    );

    const results = [
      ...installProjectLevelRules(dir),
      ...installProjectGeminiInstructions(dir),
    ];
    expect(results.find((r) => r.target.includes("Antigravity (project rules)"))?.status).toMatch(
      /created|updated/
    );
    expect(results.find((r) => r.target.includes("Copilot"))?.status).toMatch(/created|updated/);

    expect(existsSync(join(dir, ".agent", "rules", "graphflow.md"))).toBe(true);
    expect(existsSync(join(dir, ".agent", "skills", "graphflow", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".github", "copilot-instructions.md"))).toBe(true);
    expect(existsSync(join(dir, "GEMINI.md"))).toBe(true);

    const gemini = readFileSync(join(dir, "GEMINI.md"), "utf8");
    expect(gemini).toContain("graphflow_context");
    expect(gemini).not.toContain("graphflow_preview_context");
    expect(gemini).toContain("CallMcpTool");

    const copilot = readFileSync(join(dir, ".github", "copilot-instructions.md"), "utf8");
    expect(copilot).toContain("graphflow_context");
    expect(copilot).not.toContain("GraphFlow for Claude Code");

    const antigravityStatus = getAntigravityInstallStatus(dir);
    expect(antigravityStatus.some((s) => s.agent.includes("project rules") && s.installed)).toBe(true);
    expect(getCopilotInstallStatus(dir)[0]?.installed).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("installMcpToDetectedAgents writes npx config without WORKSPACE_ROOT for user scope", () => {
    const results = installMcpToDetectedAgents({
      strategy: "npx",
      installScope: "user",
      workspaceRoot: "/wrong/project/root",
      agentIdsOverride: ["antigravity"],
    });
    expect(results.some((r) => r.agentId === "antigravity")).toBe(true);

    const written = results.find((r) => r.configPath.includes("antigravity/mcp_config.json"));
    if (written && existsSync(written.configPath)) {
      const json = JSON.parse(readFileSync(written.configPath, "utf8")) as {
        mcpServers?: { graphflow?: { env?: Record<string, string> } };
      };
      expect(json.mcpServers?.graphflow?.env?.GRAPHFLOW_WORKSPACE_ROOT).toBeUndefined();
    }
  });
});
