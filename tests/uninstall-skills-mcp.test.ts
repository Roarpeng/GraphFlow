import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  uninstallAllSkillsAndRules,
  removeGraphFlowOwnedFile,
  looksLikeGraphFlowOwnedContent,
  removeManagedBlock,
} from "../src/integrations/skill-installer";
import { removeMcpEntry } from "../src/integrations/agent-mcp-installer";

const INSTRUCTION_BEGIN = "<!-- GRAPHFLOW:BEGIN managed block — edit outside these markers only -->";
const INSTRUCTION_END = "<!-- GRAPHFLOW:END -->";

describe("uninstall skills and rules", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `gf-uninstall-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("looksLikeGraphFlowOwnedContent detects skill/rules signatures", () => {
    expect(looksLikeGraphFlowOwnedContent("call graphflow_context and 10 MCP tools")).toBe(true);
    expect(looksLikeGraphFlowOwnedContent("plain notes")).toBe(false);
  });

  it("removeManagedBlock strips only the GraphFlow section", () => {
    const filePath = join(root, "AGENTS.md");
    writeFileSync(
      filePath,
      `# User\nkeep me\n\n${INSTRUCTION_BEGIN}\nuse graphflow_context\n${INSTRUCTION_END}\n\n# After\n`,
      "utf8"
    );
    expect(removeManagedBlock(filePath)).toBe(true);
    const next = readFileSync(filePath, "utf8");
    expect(next).toContain("keep me");
    expect(next).not.toContain("graphflow_context");
    expect(next).not.toContain(INSTRUCTION_BEGIN);
  });

  it("removeGraphFlowOwnedFile deletes dedicated graphflow.* files", () => {
    const rulesDir = join(root, ".cursor", "rules");
    mkdirSync(rulesDir, { recursive: true });
    const filePath = join(rulesDir, "graphflow.mdc");
    writeFileSync(filePath, "always apply graphflow_context", "utf8");
    expect(removeGraphFlowOwnedFile(filePath)).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it("uninstallAllSkillsAndRules removes project skill dirs and rules", () => {
    const skillDir = join(root, ".trae", "skills", "graphflow");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: graphflow\n---\nuse graphflow_context\n", "utf8");

    const rulesDir = join(root, ".cursor", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "graphflow.mdc"), "Token-First Rule\ngraphflow_context\n", "utf8");

    const agentSkills = join(root, ".agent", "skills", "graphflow");
    mkdirSync(agentSkills, { recursive: true });
    writeFileSync(join(agentSkills, "SKILL.md"), "graphflow_context\n", "utf8");

    const wsSkills = join(root, ".graphflow", "skills", "graphflow");
    mkdirSync(wsSkills, { recursive: true });
    writeFileSync(join(wsSkills, "SKILL.md"), "graphflow_context\n", "utf8");

    const results = uninstallAllSkillsAndRules(root);
    const removedPaths = results.filter((r) => r.removed).map((r) => r.path);

    expect(existsSync(skillDir)).toBe(false);
    expect(existsSync(join(rulesDir, "graphflow.mdc"))).toBe(false);
    expect(existsSync(agentSkills)).toBe(false);
    expect(existsSync(wsSkills)).toBe(false);
    expect(removedPaths.some((p) => p.includes(".trae"))).toBe(true);
    expect(removedPaths.some((p) => p.includes("graphflow.mdc"))).toBe(true);
  });

  it("removeMcpEntry clears workspace mcp.json graphflow server", () => {
    const mcpPath = join(root, ".cursor", "mcp.json");
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            graphflow: { command: "npx", args: ["graphflow-mcp"] },
            other: { command: "echo" },
          },
        },
        null,
        2
      ),
      "utf8"
    );
    expect(removeMcpEntry(mcpPath, "mcpServers", "graphflow")).toBe(true);
    const next = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(next.mcpServers.graphflow).toBeUndefined();
    expect(next.mcpServers.other).toBeTruthy();
  });
});
