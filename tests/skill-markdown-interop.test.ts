import { describe, expect, it } from "vitest";
import { parseSkillMarkdown, skillToSkillMarkdown } from "../src/learning/skill-markdown";
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

describe("SKILL.md interoperability", () => {
  it("serializes stable frontmatter and playbook bullets without success evidence", () => {
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
        'name: "local skill"',
        "metadata:",
        '  id: "skill:local-skill"',
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
    expect(markdown).not.toContain("success");
    expect(markdown).not.toContain("canary");
  });

  it("round-trips portable fields and imports conservatively", () => {
    const source = skill({
      guidance: "Use the existing adapter\n- Preserve error semantics",
      provenance: { source: "local" },
    });
    const imported = parseSkillMarkdown(skillToSkillMarkdown(source));

    expect(imported).toMatchObject({
      id: "skill:local-skill",
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
    expect(skillToSkillMarkdown(imported!)).toBe(skillToSkillMarkdown(source));
  });

  it("accepts a reasonable external SKILL.md and generates a kebab-case id", () => {
    const markdown = [
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
    ].join("\n");

    const imported = parseSkillMarkdown(markdown);
    expect(imported?.id).toBe("skill:team-release-check");
    expect(imported?.name).toBe("Team Release Check");
    expect(imported?.score).toBe(4);
    expect(imported?.uses).toBe(9);
    expect(imported?.guidance).toBe("- Verify signatures");
    expect(imported?.outcomeKind).toBe("correctable");
    expect(imported?.provenance?.source).toBe("import");
  });

  it("rejects markdown without frontmatter or a name", () => {
    expect(parseSkillMarkdown("just guidance\n- bullet")).toBeUndefined();
    expect(parseSkillMarkdown("---\ndescription: no name\n---\n- bullet")).toBeUndefined();
  });
});
