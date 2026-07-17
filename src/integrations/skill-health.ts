import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { profileRegistry } from "./agent-profiles/registry";

export interface SkillHealthCheck {
  agent: string;
  markerDir: string;
  skillsRoot: string;
  skillPath: string;
  exists: boolean;
  size: number;
  hasFrontmatter: boolean;
  hasName: boolean;
  hasDescription: boolean;
  isValid: boolean;
  issues: string[];
}

export interface SkillHealthSummary {
  total: number;
  valid: number;
  invalid: number;
  missing: number;
  checks: SkillHealthCheck[];
}

function checkSkillFile(path: string): Pick<SkillHealthCheck, "exists" | "size" | "hasFrontmatter" | "hasName" | "hasDescription" | "isValid" | "issues"> {
  if (!existsSync(path)) {
    return {
      exists: false,
      size: 0,
      hasFrontmatter: false,
      hasName: false,
      hasDescription: false,
      isValid: false,
      issues: ["Skill file does not exist"],
    };
  }

  const content = readFileSync(path, "utf8");
  const size = content.length;
  const issues: string[] = [];

  const hasFrontmatter = /^---\s*\n/.test(content);
  if (!hasFrontmatter) {
    issues.push("Missing YAML frontmatter");
  }

  const hasName = /^---\s*\n[\s\S]*?name:\s*.+?\s*\n/.test(content);
  if (!hasName) {
    issues.push("Missing 'name' in frontmatter");
  }

  const hasDescription = /^---\s*\n[\s\S]*?description:\s*.+?\s*\n/.test(content);
  if (!hasDescription) {
    issues.push("Missing 'description' in frontmatter");
  }

  if (size < 100) {
    issues.push(`Skill file too small (${size} bytes)`);
  }

  return {
    exists: true,
    size,
    hasFrontmatter,
    hasName,
    hasDescription,
    isValid: issues.length === 0,
    issues,
  };
}

export function checkSkillHealth(workspaceRoot?: string): SkillHealthSummary {
  const targets = profileRegistry.getSkillTargets();
  const checks: SkillHealthCheck[] = [];

  for (const target of targets) {
    const skillPath = join(target.skillsRoot, "graphflow", "SKILL.md");
    const fileCheck = checkSkillFile(skillPath);

    checks.push({
      agent: target.agent,
      markerDir: target.markerDir,
      skillsRoot: target.skillsRoot,
      skillPath,
      ...fileCheck,
    });
  }

  if (workspaceRoot) {
    const workspaceSkillPath = join(workspaceRoot, ".graphflow", "skills", "graphflow", "SKILL.md");
    const fileCheck = checkSkillFile(workspaceSkillPath);

    checks.push({
      agent: "Workspace",
      markerDir: workspaceRoot,
      skillsRoot: join(workspaceRoot, ".graphflow", "skills"),
      skillPath: workspaceSkillPath,
      ...fileCheck,
    });
  }

  const valid = checks.filter((c) => c.isValid).length;
  const invalid = checks.filter((c) => c.exists && !c.isValid).length;
  const missing = checks.filter((c) => !c.exists).length;

  return {
    total: checks.length,
    valid,
    invalid,
    missing,
    checks,
  };
}

export function getSkillHealthReport(workspaceRoot?: string): string {
  const summary = checkSkillHealth(workspaceRoot);
  const lines: string[] = [];

  lines.push(`Skill Health Report`);
  lines.push(`=====================`);
  lines.push(`Total: ${summary.total} | Valid: ${summary.valid} | Invalid: ${summary.invalid} | Missing: ${summary.missing}`);
  lines.push("");

  for (const check of summary.checks) {
    const status = check.isValid ? "✅" : check.exists ? "⚠️" : "❌";
    lines.push(`${status} ${check.agent}`);
    lines.push(`   Path: ${check.skillPath}`);
    lines.push(`   Exists: ${check.exists} | Size: ${check.size} bytes`);

    if (check.issues.length > 0) {
      lines.push(`   Issues:`);
      for (const issue of check.issues) {
        lines.push(`     - ${issue}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

export function isAnySkillValid(workspaceRoot?: string): boolean {
  const summary = checkSkillHealth(workspaceRoot);
  return summary.valid > 0;
}
