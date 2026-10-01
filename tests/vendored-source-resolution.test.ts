import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveCopilotInstructionsSourcePath,
  resolveCursorRulesSourcePath,
  resolveSkillSourcePath,
  resolveTraeRulesSourcePath,
} from "../src/integrations/skill-installer";

/**
 * Project-scope rule/skill copies used to report "Source file not found" for
 * every real user. The source files ship inside the published package
 * (`dist/surfaces/...`, `skills/graphflow`), but every resolver computed the
 * package-relative path with one `..` too many
 * (`join(__dirname, "..", "..", "surfaces", ...)` from `dist/integrations/`
 * lands on a `<pkg>/surfaces/` that does not exist), so the only candidates
 * that ever matched were the `process.cwd()` fallbacks — i.e. resolution
 * worked only when the user happened to run from the repo checkout.
 *
 * Observed on both Ubuntu and Windows install logs: Trae / Cursor /
 * Antigravity / Copilot project entries all skipped with "Source file not
 * found", while the files were sitting in the installed package.
 *
 * These tests pin the contract: from an arbitrary working directory that is
 * neither the repo nor the package, every resolver must still find its source
 * next to the running module — never via cwd luck.
 */
const tempRoots: string[] = [];
let previousCwd = "";

beforeEach(() => {
  previousCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "gf-resolver-cwd-"));
  tempRoots.push(dir);
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(previousCwd);
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("vendored source resolution is cwd-independent", () => {
  it("finds the Copilot instructions source next to the module", () => {
    expect(resolveCopilotInstructionsSourcePath()).toMatch(/surfaces.copilot-instructions$/);
  });

  it("finds the Cursor rules source next to the module", () => {
    expect(resolveCursorRulesSourcePath()).toMatch(/surfaces.cursor-rules$/);
  });

  it("finds the Trae rules source next to the module", () => {
    expect(resolveTraeRulesSourcePath()).toMatch(/surfaces.trae-rules$/);
  });

  it("finds the skill source next to the module", () => {
    expect(resolveSkillSourcePath()).toMatch(/skills.graphflow$/);
  });

  it("never takes sources from the working directory", () => {
    const cwd = process.cwd();
    for (const dir of [join("skills", "graphflow"), join("src", "surfaces", "cursor-rules"), join("dist", "surfaces", "trae-rules")]) {
      mkdirSync(join(cwd, dir), { recursive: true });
    }
    writeFileSync(join(cwd, "skills", "graphflow", "SKILL.md"), "planted");
    writeFileSync(join(cwd, "src", "surfaces", "cursor-rules", "graphflow.mdc"), "planted");
    writeFileSync(join(cwd, "dist", "surfaces", "trae-rules", "graphflow.md"), "planted");
    for (const resolved of [resolveSkillSourcePath(), resolveCursorRulesSourcePath(), resolveTraeRulesSourcePath()]) {
      expect(resolved).toBeDefined();
      expect(resolved!.startsWith(cwd)).toBe(false);
    }
  });
});
