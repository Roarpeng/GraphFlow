import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SKILL_BODY_CHAR_LIMIT,
  SKILL_BODY_TOKEN_LIMIT,
  extractSkillReferences,
  skillDirectoryFor,
  skillToSkillMarkdown,
  skillToSkillMarkdownBundle,
  toSpecName,
  validateSkillBundle,
  validateSkillMarkdown,
} from "../src/learning/skill-markdown";
import {
  exportSkillsToMarkdownRuntime,
  importSkillsFromMarkdownRuntime,
} from "../src/surfaces/cli/runtime/knowledge";
import type { SkillState } from "../src/learning/skill-types";

const skill = (guidance: string): SkillState =>
  ({
    id: "s1",
    name: "Prefer Targeted Reads",
    score: 1,
    uses: 2,
    lastOutcome: "pass",
    updatedAt: 100,
    outcomeKind: "proven",
    guidance,
  }) as SkillState;

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function newWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "gf-skill-md-"));
  dirs.push(dir);
  return dir;
}

describe("progressive disclosure bundle", () => {
  it("keeps small skills as a single SKILL.md without references", () => {
    const bundle = skillToSkillMarkdownBundle(skill("- keep reads targeted"));
    expect(bundle.references).toEqual([]);
    expect(bundle.markdown).toBe(skillToSkillMarkdown(skill("- keep reads targeted")));
  });

  it("moves oversized guidance into references/ and keeps the body a pointer", () => {
    const bullets: string[] = [];
    for (let i = 0; i < 500; i++) bullets.push(`- rule ${i}: ${"x".repeat(40)}`);
    const big = skill(bullets.join("\n"));
    const bundle = skillToSkillMarkdownBundle(big);
    expect(bundle.references.length).toBeGreaterThan(0);
    // SKILL.md body is now the compact pointer, under the char budget.
    const body = bundle.markdown.slice(bundle.markdown.indexOf("\n---\n", 3) + 5);
    expect(body.length).toBeLessThanOrEqual(SKILL_BODY_CHAR_LIMIT);
    // Pointers to every reference file are present in the body.
    for (const reference of bundle.references) {
      expect(body).toContain(reference.path);
    }
    // References carry the full content and stay under the budget themselves.
    const joined = bundle.references.map((r) => r.content).join("\n");
    expect(joined).toContain("rule 499");
    for (const reference of bundle.references) {
      expect(reference.content.length).toBeLessThanOrEqual(SKILL_BODY_CHAR_LIMIT);
    }
  });

  it("documents the ~5000-token body guidance constants", () => {
    expect(SKILL_BODY_TOKEN_LIMIT).toBe(5000);
    expect(SKILL_BODY_CHAR_LIMIT).toBe(20000);
  });

  it("derives the layout directory from the spec name and flags oversized bodies", () => {
    expect(skillDirectoryFor(skill("guidance"))).toBe(toSpecName("Prefer Targeted Reads"));
    const bullets = Array.from({ length: 1200 }, (_, i) => `- rule ${i}: ${"y".repeat(40)}`);
    const violations = validateSkillMarkdown(skillToSkillMarkdown(skill(bullets.join("\n"))));
    expect(violations.some((v) => v.includes("references/"))).toBe(true);
    // The bundled export must repair it.
    const bundle = skillToSkillMarkdownBundle(skill(bullets.join("\n")));
    expect(validateSkillMarkdown(bundle.markdown)).toEqual([]);
  });
});

describe("skills-ref gate (bundle reference integrity)", () => {
  const bigSkill = () => {
    const bullets = Array.from({ length: 500 }, (_, i) => `- rule ${i}: ${"x".repeat(40)}`);
    return skillToSkillMarkdownBundle(skill(bullets.join("\n")));
  };

  it("exporter-produced bundles pass the gate (pointer ⇄ file 1:1)", () => {
    const bundle = bigSkill();
    expect(bundle.references.length).toBeGreaterThan(0);
    expect(validateSkillBundle(bundle)).toEqual([]);
    // Small bundle without references is also clean.
    expect(validateSkillBundle(skillToSkillMarkdownBundle(skill("- small")))).toEqual([]);
  });

  it("extractSkillReferences returns pointer paths in body order", () => {
    const bundle = bigSkill();
    const refs = extractSkillReferences(bundle.markdown);
    expect(refs.length).toBe(bundle.references.length);
    for (const reference of bundle.references) {
      expect(refs).toContain(reference.path);
    }
  });

  it("flags a dangling pointer (SKILL.md points at a missing file)", () => {
    const bundle = bigSkill();
    const broken = { markdown: bundle.markdown, references: bundle.references.slice(1) };
    const violations = validateSkillBundle(broken);
    expect(violations.some((v) => v.includes("dangling reference"))).toBe(true);
  });

  it("flags an orphan reference file (shipped but never pointed at)", () => {
    const bundle = bigSkill();
    const orphan = {
      markdown: bundle.markdown,
      references: [
        ...bundle.references,
        { path: "references/extra-never-pointed.md", content: "# Extra\n" },
      ],
    };
    const violations = validateSkillBundle(orphan);
    expect(violations.some((v) => v.includes("orphan reference file"))).toBe(true);
  });

  it("rejects traversal / non-references pointer paths", () => {
    const bundle = bigSkill();
    const split = bundle.markdown.indexOf("\n---\n", 3);
    const frontmatter = bundle.markdown.slice(0, split + 5);
    const markdown = `${frontmatter}\n- keep reads targeted\n- details: ../evil.md (load on demand)\n`;
    const violations = validateSkillBundle({
      markdown,
      references: [{ path: "../evil.md", content: "# Evil\n" }],
    });
    // The malformed pointer is flagged by the path-shape rule. The file itself
    // is not an orphan (it IS pointed at) — traversal is the violation, not
    // missing linkage.
    expect(violations.some((v) => v.includes("must be a relative references/*.md path"))).toBe(true);
    expect(violations.some((v) => v.includes("orphan reference file"))).toBe(false);
  });
});

describe("spec layout export/import roundtrip", () => {
  it("exports one directory per skill with SKILL.md inside", async () => {
    const ws = newWorkspace();
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(ws, "graphflow.config.json"),
      JSON.stringify({ graphPolicy: { transport: "file", workspaceRoot: ws } })
    );
    // Seed a skill via the flat legacy import path, then export and verify
    // the agentskills.io directory layout appears.
    const importDir = join(ws, "in");
    mkdirSync(importDir, { recursive: true });
    writeFileSync(
      join(importDir, "prefer-targeted-reads.md"),
      skillToSkillMarkdown(skill("- keep reads targeted"))
    );
    const imported = await importSkillsFromMarkdownRuntime(undefined, { rootDir: ws, inputPath: importDir });
    expect(imported.imported).toBe(1);

    const outDir = join(ws, "out");
    const exported = await exportSkillsToMarkdownRuntime(undefined, { rootDir: ws, outputDir: outDir });
    expect(exported.fileCount).toBe(1);
    expect(exported.referenceFileCount).toBe(0);
    const specName = toSpecName("Prefer Targeted Reads");
    const markdown = readFileSync(join(outDir, specName, "SKILL.md"), "utf8");
    expect(validateSkillMarkdown(markdown)).toEqual([]);

    // Roundtrip through the spec layout re-imports cleanly (force: id is
    // unchanged so the updatedAt gate would skip otherwise).
    const reimport = await importSkillsFromMarkdownRuntime(undefined, {
      rootDir: ws,
      inputPath: outDir,
      force: true,
    });
    expect(reimport.updated).toBe(1);
    expect(reimport.invalid).toEqual([]);
  });

  it("directory scans accept SKILL.md only and enforce the parent-directory name", async () => {
    const ws = newWorkspace();
    writeFileSync(
      join(ws, "graphflow.config.json"),
      JSON.stringify({ graphPolicy: { transport: "file", workspaceRoot: ws } })
    );
    const inDir = join(ws, "in");
    const specName = toSpecName("Prefer Targeted Reads");
    const goodDir = join(inDir, specName);
    mkdirSync(goodDir, { recursive: true });
    writeFileSync(join(goodDir, "SKILL.md"), skillToSkillMarkdown(skill("- a")));
    // references/ files must NOT be treated as skills.
    const refsDir = join(goodDir, "references");
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(join(refsDir, "guidance-1.md"), "# Guidance\n\n- a\n");
    // Wrong parent directory name is rejected (agentskills.io).
    const badDir = join(inDir, "wrong-dir-name");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "SKILL.md"), skillToSkillMarkdown(skill("- b")));

    const result = await importSkillsFromMarkdownRuntime(undefined, { rootDir: ws, inputPath: inDir });
    expect(result.imported).toBe(1);
    expect(result.invalid.length).toBe(1);
    expect(result.invalid[0].violations[0]).toContain("agentskills.io");
  });
});
