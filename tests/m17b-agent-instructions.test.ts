import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectInstalledAgents,
  getMcpInstallStatus,
  installMcpToDetectedAgents,
} from "../src/integrations/agent-mcp-installer";
import {
  getAgentInstructionStatus,
  getAgentSkillStatus,
  installAgentInstructions,
  installAgentSkills,
} from "../src/integrations/skill-installer";

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function withFakeHome(fakeHome: string, fn: () => void): void {
  const previousHome = process.env.USERPROFILE ?? process.env.HOME;
  if (process.platform === "win32") {
    process.env.USERPROFILE = fakeHome;
  } else {
    process.env.HOME = fakeHome;
  }
  try {
    fn();
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
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("M17b Claude Code MCP target", () => {
  it("writes user-scope MCP into ~/.claude.json top-level mcpServers", () => {
    const fakeHome = createTempRoot("graphflow-claude-home");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    withFakeHome(fakeHome, () => {
      expect(detectInstalledAgents().some((agent) => agent.id === "claude-code")).toBe(true);

      const results = installMcpToDetectedAgents({
        strategy: "npx",
        agentIdsOverride: ["claude-code"],
      });
      expect(results.some((result) => result.agentId === "claude-code" && result.status !== "error")).toBe(true);

      const claudeJsonPath = join(fakeHome, ".claude.json");
      expect(existsSync(claudeJsonPath)).toBe(true);

      const config = JSON.parse(readFileSync(claudeJsonPath, "utf8")) as {
        mcpServers?: Record<string, { args?: string[] }>;
      };
      expect(config.mcpServers?.graphflow?.args).toEqual(
        expect.arrayContaining(["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"])
      );

      // 不应再写入旧的无效路径
      expect(existsSync(join(fakeHome, ".claude", "mcp.json"))).toBe(false);

      expect(getMcpInstallStatus().some((item) => item.agentId === "claude-code" && item.installed)).toBe(true);
    });
  });

  it("preserves other top-level keys in ~/.claude.json", () => {
    const fakeHome = createTempRoot("graphflow-claude-preserve");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    const claudeJsonPath = join(fakeHome, ".claude.json");
    writeFileSync(claudeJsonPath, JSON.stringify({ oauthAccount: "keep-me", projects: { a: 1 } }), "utf8");

    withFakeHome(fakeHome, () => {
      installMcpToDetectedAgents({ strategy: "npx", agentIdsOverride: ["claude-code"] });
      const config = JSON.parse(readFileSync(claudeJsonPath, "utf8")) as Record<string, unknown>;
      expect(config.oauthAccount).toBe("keep-me");
      expect(config.projects).toEqual({ a: 1 });
      expect((config.mcpServers as Record<string, unknown>)?.graphflow).toBeDefined();
    });
  });
});

describe("M17b agent instruction installer", () => {
  it("creates a managed instruction block for a detected agent (Codex)", () => {
    const fakeHome = createTempRoot("graphflow-instr-codex");
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });

    withFakeHome(fakeHome, () => {
      const results = installAgentInstructions();
      const codex = results.find((result) => result.target === "Codex");
      expect(codex?.status).toBe("created");

      const agentsPath = join(fakeHome, ".codex", "AGENTS.md");
      expect(existsSync(agentsPath)).toBe(true);
      const content = readFileSync(agentsPath, "utf8");
      expect(content).toContain("GRAPHFLOW:BEGIN");
      expect(content).toContain("graphflow_preview_context");

      expect(getAgentInstructionStatus().some((item) => item.agent === "Codex" && item.installed)).toBe(true);
    });
  });

  it("preserves existing user content and is idempotent", () => {
    const fakeHome = createTempRoot("graphflow-instr-preserve");
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    const agentsPath = join(fakeHome, ".codex", "AGENTS.md");
    writeFileSync(agentsPath, "# My personal rules\nAlways write tests.\n", "utf8");

    withFakeHome(fakeHome, () => {
      const first = installAgentInstructions().find((r) => r.target === "Codex");
      expect(first?.status).toBe("updated");

      const afterFirst = readFileSync(agentsPath, "utf8");
      expect(afterFirst).toContain("My personal rules");
      expect(afterFirst).toContain("Always write tests.");
      expect(afterFirst).toContain("GRAPHFLOW:BEGIN");

      // 再次安装应为幂等（不重复追加块）
      const second = installAgentInstructions().find((r) => r.target === "Codex");
      expect(second?.status).toBe("skipped");

      const afterSecond = readFileSync(agentsPath, "utf8");
      const occurrences = afterSecond.split("GRAPHFLOW:BEGIN").length - 1;
      expect(occurrences).toBe(1);
    });
  });

  it("skips agents that are not installed", () => {
    const fakeHome = createTempRoot("graphflow-instr-none");
    withFakeHome(fakeHome, () => {
      const results = installAgentInstructions();
      expect(results.every((result) => result.status === "skipped")).toBe(true);
    });
  });
});

describe("M17b agent skill installer", () => {
  it("installs a real Cursor skill at ~/.cursor/skills/graphflow/SKILL.md (not skills-cursor)", () => {
    const fakeHome = createTempRoot("graphflow-skill-cursor");
    mkdirSync(join(fakeHome, ".cursor"), { recursive: true });

    withFakeHome(fakeHome, () => {
      const results = installAgentSkills();
      const cursor = results.find((result) => result.target === "Cursor");
      expect(cursor?.status).toBe("created");

      const skillPath = join(fakeHome, ".cursor", "skills", "graphflow", "SKILL.md");
      expect(existsSync(skillPath)).toBe(true);
      const content = readFileSync(skillPath, "utf8");
      // 必须带合法的 Cursor frontmatter（name 与文件夹同名）
      expect(content).toContain('name: "graphflow"');
      expect(content).toContain("description:");

      // 绝不能写入 Cursor 内置 skill 的保留目录
      expect(existsSync(join(fakeHome, ".cursor", "skills-cursor", "graphflow"))).toBe(false);

      expect(getAgentSkillStatus().some((item) => item.agent === "Cursor skill" && item.installed)).toBe(true);
    });
  });

  it("is idempotent (second install skipped)", () => {
    const fakeHome = createTempRoot("graphflow-skill-idem");
    mkdirSync(join(fakeHome, ".cursor"), { recursive: true });

    withFakeHome(fakeHome, () => {
      expect(installAgentSkills().find((r) => r.target === "Cursor")?.status).toBe("created");
      expect(installAgentSkills().find((r) => r.target === "Cursor")?.status).toBe("skipped");
    });
  });

  it("skips agents that are not installed", () => {
    const fakeHome = createTempRoot("graphflow-skill-none");
    withFakeHome(fakeHome, () => {
      const results = installAgentSkills();
      expect(results.every((result) => result.status === "skipped")).toBe(true);
    });
  });
});
