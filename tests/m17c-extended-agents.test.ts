import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import os from "os";
import {
  buildAgentProfiles,
} from "../src/integrations/agent-mcp-installer";
import {
  getAgentInstructionTargets,
  getAgentSkillTargets,
  removeManagedBlock,
  removeAgentSkill,
} from "../src/integrations/skill-installer";

// Helper to create temp dir
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gf-test-"));
}

describe("Extended Agent Profiles (Kilo Code / PearAI / Amazon Q)", () => {
  it("should include kilocode in agent profiles", () => {
    const profiles = buildAgentProfiles();
    const kilocode = profiles.find((p) => p.id === "kilocode");
    expect(kilocode).toBeDefined();
    expect(kilocode!.name).toBe("Kilo Code");
    expect(kilocode!.userTargets.length).toBeGreaterThan(0);
    // All user targets should use mcpServers
    for (const t of kilocode!.userTargets) {
      expect(t.serversKey).toBe("mcpServers");
    }
  });

  it("should include pearai in agent profiles", () => {
    const profiles = buildAgentProfiles();
    const pearai = profiles.find((p) => p.id === "pearai");
    expect(pearai).toBeDefined();
    expect(pearai!.name).toBe("PearAI");
    // At least one target should use mcpServers
    const hasMcpServers = pearai!.userTargets.some((t) => t.serversKey === "mcpServers");
    expect(hasMcpServers).toBe(true);
  });

  it("should include amazon-q in agent profiles", () => {
    const profiles = buildAgentProfiles();
    const aq = profiles.find((p) => p.id === "amazon-q");
    expect(aq).toBeDefined();
    expect(aq!.name).toBe("Amazon Q");
    expect(aq!.userTargets.length).toBeGreaterThan(0);
  });

  it("Kilo Code targets should reference kilocode.kilocode-ai extension", () => {
    const profiles = buildAgentProfiles();
    const kilocode = profiles.find((p) => p.id === "kilocode")!;
    for (const target of kilocode.userTargets) {
      expect(target.configPath).toContain("kilocode.kilocode-ai");
    }
    for (const mp of kilocode.markerPaths) {
      if (mp.includes("globalStorage")) {
        expect(mp).toContain("kilocode.kilocode-ai");
      }
    }
  });

  it("PearAI targets should reference .pearai directory", () => {
    const profiles = buildAgentProfiles();
    const pearai = profiles.find((p) => p.id === "pearai")!;
    const hasPearaiHome = pearai.userTargets.some((t) => t.configPath.includes(".pearai"));
    expect(hasPearaiHome).toBe(true);
  });

  it("Roo Code should use rooveterinaryinc.roo-cline extension ID", () => {
    const profiles = buildAgentProfiles();
    const roo = profiles.find((p) => p.id === "roo-code");
    expect(roo).toBeDefined();
    for (const mp of roo!.markerPaths) {
      if (mp.includes("globalStorage")) {
        expect(mp).toContain("rooveterinaryinc.roo-cline");
      }
    }
  });
});

describe("Agent Instruction Targets (Roo Code / Kilo Code / Cline)", () => {
  it("should include Roo Code instruction target", () => {
    const targets = getAgentInstructionTargets();
    const roo = targets.find((t) => t.agent === "Roo Code");
    expect(roo).toBeDefined();
    expect(roo!.filePath).toContain("AGENTS.md");
    expect(roo!.filePath).toContain(".roo");
  });

  it("should include Kilo Code instruction target", () => {
    const targets = getAgentInstructionTargets();
    const kilo = targets.find((t) => t.agent === "Kilo Code");
    expect(kilo).toBeDefined();
    expect(kilo!.filePath).toContain(".kilocode");
    expect(kilo!.filePath).toContain("AGENTS.md");
  });

  it("should include Cline global rules target", () => {
    const targets = getAgentInstructionTargets();
    // May have multiple Cline entries (global + project)
    const clineTargets = targets.filter((t) => t.agent === "Cline");
    expect(clineTargets.length).toBeGreaterThanOrEqual(1);
    // At least one should reference Documents/Cline/Rules
    const hasGlobal = clineTargets.some((t) => t.filePath.includes("Cline") && t.filePath.includes("Rules"));
    expect(hasGlobal).toBe(true);
  });
});

describe("Agent Skill Targets (Roo Code / Kilo Code)", () => {
  it("should include Roo Code skill target", () => {
    const targets = getAgentSkillTargets();
    const roo = targets.find((t) => t.agent === "Roo Code");
    expect(roo).toBeDefined();
    expect(roo!.skillsRoot).toContain(".roo");
  });

  it("should include Kilo Code skill target", () => {
    const targets = getAgentSkillTargets();
    const kilo = targets.find((t) => t.agent === "Kilo Code");
    expect(kilo).toBeDefined();
    expect(kilo!.skillsRoot).toContain(".kilocode");
  });
});

describe("removeManagedBlock", () => {
  it("should remove managed block from file", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "test-rules.md");
    const content = `# My Rules\nSome rules here.\n\n<!-- GRAPHFLOW:BEGIN managed block — edit outside these markers only -->\nGraphFlow instructions.\n<!-- GRAPHFLOW:END -->\n\nMore rules.`;
    fs.writeFileSync(fp, content, "utf8");
    expect(removeManagedBlock(fp)).toBe(true);
    const result = fs.readFileSync(fp, "utf8");
    expect(result).not.toContain("GRAPHFLOW");
    expect(result).toContain("My Rules");
    expect(result).toContain("More rules");
    fs.rmSync(dir, { recursive: true });
  });

  it("should delete file if only managed content remains", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "only-managed.md");
    fs.writeFileSync(fp, `<!-- GRAPHFLOW:BEGIN managed block — edit outside these markers only -->\nOnly graphflow.\n<!-- GRAPHFLOW:END -->`, "utf8");
    expect(removeManagedBlock(fp)).toBe(true);
    expect(fs.existsSync(fp)).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  it("should return false if no managed block exists", () => {
    const dir = tmpDir();
    const fp = path.join(dir, "no-block.md");
    fs.writeFileSync(fp, "No graphflow content here.", "utf8");
    expect(removeManagedBlock(fp)).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  it("should return false if file does not exist", () => {
    expect(removeManagedBlock("/nonexistent/path/file.md")).toBe(false);
  });
});

describe("removeAgentSkill", () => {
  it("should remove skill directory", () => {
    const dir = tmpDir();
    const skillDir = path.join(dir, "graphflow");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "content");
    expect(removeAgentSkill(dir)).toBe(true);
    expect(fs.existsSync(skillDir)).toBe(false);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("should return false if skill dir does not exist", () => {
    expect(removeAgentSkill("/nonexistent/path")).toBe(false);
  });
});
