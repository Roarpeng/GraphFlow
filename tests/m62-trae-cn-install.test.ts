import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getProjectLevelRuleTargets,
  getTraeInstallStatus,
  installProjectLevelRules,
  installTraeSkills,
} from "../src/integrations/skill-installer";

describe("M62 Trae CN project install", () => {
  it("includes .trae/rules and .trae/skills in project install targets", () => {
    const targets = getProjectLevelRuleTargets("/tmp/myproject");
    const agents = targets.map((t) => t.agent);
    expect(agents).toContain("Trae CN (project rules)");
    expect(agents).toContain("Trae CN (project skills)");
    expect(targets.find((t) => t.agent.includes("Trae CN (project rules)"))?.filePath).toMatch(
      /\.trae[\/\\]rules[\/\\]graphflow\.md/
    );
  });

  it("installs Trae project rules and skills into workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "gf-trae-"));
    const results = installProjectLevelRules(dir);
    const traeRule = results.find((r) => r.target.includes("Trae CN (project rules)"));
    const traeSkill = results.find((r) => r.target.includes("Trae CN (project skills)"));
    expect(traeRule?.status).toMatch(/created|updated/);
    expect(traeSkill?.status).toMatch(/created|updated/);
    expect(existsSync(join(dir, ".trae", "rules", "graphflow.md"))).toBe(true);
    expect(existsSync(join(dir, ".trae", "skills", "graphflow", "SKILL.md"))).toBe(true);

    const rule = readFileSync(join(dir, ".trae", "rules", "graphflow.md"), "utf8");
    expect(rule).toContain("alwaysApply: true");
    expect(rule).toContain("graphflow_preview_context");

    const status = getTraeInstallStatus(dir);
    expect(status.every((s) => s.installed)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("installTraeSkills writes project .trae/skills when workspaceRoot provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "gf-trae-sk-"));
    const results = installTraeSkills(undefined, dir);
    expect(results.some((r) => r.target.includes("Trae project skill"))).toBe(true);
    expect(existsSync(join(dir, ".trae", "skills", "graphflow", "SKILL.md"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
