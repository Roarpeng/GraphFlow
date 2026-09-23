import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import {
  applySkillLearning,
  extractSkillAtoms,
  pruneLegacyNoiseSkills,
} from "../src/learning/skill-flywheel";
const skillNodesOf = (client: GraphifyClient) =>
  (client.readSnapshot?.().nodes ?? []).filter((n) => n.type === "Skill");

describe("task echoes never become skills (junk-skill gate)", () => {
  it("a one-sentence task verbatim atom is dropped, lessons still seed", async () => {
    const client = new GraphifyClient();
    const task = "create a tiny file test-tmp.txt with content hi";
    // The extractor returns the task verbatim as a single atom.
    expect(extractSkillAtoms(task)).toContain(task);

    const updated = await applySkillLearning(client, task, { status: "FAILED", attempts: 1, feedback: "" }, []);
    expect(updated).toBe(0);
    expect(skillNodesOf(client).filter((n) => n.id.includes("test-tmp"))).toHaveLength(0);

    // A distilled lesson (sub-phrase, not the task) still learns.
    const lesson = "file creation tasks must use the bridge descriptor workspace root";
    const updated2 = await applySkillLearning(
      client,
      task,
      { status: "COMPLETED", attempts: 1, feedback: "" },
      [lesson]
    );
    expect(updated2).toBeGreaterThanOrEqual(1);
  });

  it("pruneLegacyNoiseSkills cleans names carrying ANY file extension (txt etc.)", async () => {
    const client = new GraphifyClient();
    await client.upsertNodes([
      {
        id: "skill:create-marker-file-verify-honesty-txt",
        type: "Skill",
        content: JSON.stringify({
          kind: "atomic",
          id: "skill:create-marker-file-verify-honesty-txt",
          name: "create marker file verify-honesty.txt",
          score: 1,
          uses: 2,
          hidden: false,
        }),
      },
    ]);
    const result = await pruneLegacyNoiseSkills(client);
    expect(result.pruned).toBe(1);
    expect(skillNodesOf(client)).toHaveLength(0);
  });
});
