import { describe, expect, it } from "vitest";
import {
  isSpecName,
  parseSkillMarkdown,
  skillToSkillMarkdown,
  toSpecName,
  validateSkillMarkdown,
} from "../src/learning/skill-markdown";
import type { SkillState } from "../src/learning/skill-types";

function skill(partial: Partial<SkillState> = {}): SkillState {
  return {
    id: "skill:local-skill",
    name: "local skill",
    score: 7,
    uses: 12,
    lastOutcome: "pass",
    updatedAt: 1234,
    linkedSuccess: true,
    successCount: 2,
    canaryValidated: true,
    outcomeKind: "proven",
    ...partial,
  };
}

describe("SKILL.md interoperability (agentskills.io R7-a)", () => {
  it("serializes spec frontmatter: slug name + required description + portable metadata", () => {
    const markdown = skillToSkillMarkdown(
      skill({
        playbook: [
          { id: "a", text: "Read the caller first", helpful: 3, harmful: 0 },
          { id: "b", text: "- Add a focused test", helpful: 1, harmful: 1 },
        ],
      })
    );

    expect(markdown).toBe(
      [
        "---",
        'name: "local-skill"',
        'description: "Read the caller first; Add a focused test. Use when working on tasks related to local skill."',
        "metadata:",
        '  id: "skill:local-skill"',
        '  graphflow-name: "local skill"',
        "  score: 7",
        "  uses: 12",
        "  updatedAt: 1234",
        "---",
        "",
        "- Read the caller first",
        "- Add a focused test",
        "",
      ].join("\n")
    );
    // Learning evidence never leaves the graph
    expect(markdown).not.toContain("success");
    expect(markdown).not.toContain("canary");
    expect(markdown).not.toContain("proven");
    // Export always validates clean
    expect(validateSkillMarkdown(markdown)).toEqual([]);
  });

  it("slugifies display names to spec names (toSpecName/isSpecName)", () => {
    expect(toSpecName("Team Release Check")).toBe("team-release-check");
    expect(toSpecName("local skill")).toBe("local-skill");
    expect(toSpecName("  --Weird__Name!!  ")).toBe("weird-name");
    expect(isSpecName("team-release-check")).toBe(true);
    expect(isSpecName("Team Release Check")).toBe(false);
    expect(isSpecName("a".repeat(65))).toBe(false);
    expect(isSpecName("-leading")).toBe(false);
    expect(isSpecName("double--hyphen")).toBe(false);
  });

  it("derives a what+when description when none is stored", () => {
    const markdown = skillToSkillMarkdown(
      skill({ guidance: "Checklist discipline", playbook: undefined })
    );
    expect(markdown).toContain("description:");
    expect(markdown).toContain("Use when working on tasks related to");
    expect(validateSkillMarkdown(markdown)).toEqual([]);
  });

  it("round-trips portable fields and imports conservatively", () => {
    const source = skill({
      guidance: "Use the existing adapter\n- Preserve error semantics",
      provenance: { source: "local" },
    });
    const exported = skillToSkillMarkdown(source);
    const imported = parseSkillMarkdown(exported);

    expect(imported).toMatchObject({
      id: "skill:local-skill",
      // Display name survives via metadata.graphflow-name
      name: "local skill",
      score: 7,
      uses: 12,
      updatedAt: 1234,
      guidance: "- Use the existing adapter\n- Preserve error semantics",
      outcomeKind: "correctable",
    });
    expect(imported?.provenance).toEqual({ source: "import" });
    expect(imported?.linkedSuccess).toBeUndefined();
    expect(imported?.successCount).toBeUndefined();
    expect(imported?.successEpisodeIds).toBeUndefined();
    expect(imported?.canaryValidated).toBeUndefined();
    // Round-trip is byte-stable (export → import → export)
    expect(skillToSkillMarkdown(imported!)).toBe(exported);
  });

  it("imports leniently: third-party spec files and legacy display names", () => {
    // Third-party agentskills.io file: spec name, no graphflow metadata
    const thirdParty = parseSkillMarkdown(
      [
        "---",
        "name: pdf-processing",
        "description: Extract PDF text. Use when handling PDFs.",
        "---",
        "",
        "- Extract text",
        "",
      ].join("\n")
    );
    expect(thirdParty?.name).toBe("pdf-processing");
    expect(thirdParty?.outcomeKind).toBe("correctable");

    // Legacy hand-written file with a display name still imports (normalized)
    const legacy = parseSkillMarkdown(
      [
        "---",
        "name: Team Release Check",
        "description: Checks the release checklist.",
        "score: 4",
        "metadata:",
        "  score: 4",
        "  uses: 9",
        "---",
        "",
        "# Release",
        "",
        "* Verify signatures",
        "2. This numbered line is not a bullet",
      ].join("\n")
    );

    expect(legacy?.id).toBe("skill:team-release-check");
    expect(legacy?.name).toBe("Team Release Check");
    expect(legacy?.score).toBe(4);
    expect(legacy?.uses).toBe(9);
    expect(legacy?.guidance).toBe("- Verify signatures");
    expect(legacy?.outcomeKind).toBe("correctable");
    expect(legacy?.provenance?.source).toBe("import");
  });

  it("validateSkillMarkdown flags spec violations; rejects missing frontmatter/name", () => {
    expect(parseSkillMarkdown("just guidance\n- bullet")).toBeUndefined();
    expect(parseSkillMarkdown("---\ndescription: no name\n---\n- bullet")).toBeUndefined();
    expect(validateSkillMarkdown("---\nname: BAD NAME\n---\n- bullet")).toContain(
      "name must be 1-64 chars, lowercase alnum + hyphens, no leading/trailing/consecutive hyphens"
    );
    expect(validateSkillMarkdown("---\nname: ok-name\n---\n- bullet")).toContain(
      "description is required (what the skill does + when to use it)"
    );
  });
});
