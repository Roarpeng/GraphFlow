import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applySkillLearning } from "../src/learning/skill-flywheel";
import { createGraphClient } from "../src/graph/client-factory";
import { validateConfig } from "../src/config/loader";
import { syncSkillPackageRuntime } from "../src/surfaces/cli/runtime";

const root = mkdtempSync(join(tmpdir(), "graphflow-skill-sync-"));
const configPath = join(root, "graphflow.config.json");
const storePath = join(root, "graph.json");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "demo.ts"), "export function demo() { return 1; }", "utf8");
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: {},
      tiers: {
        smart: { provider: "openai", model: "gpt-4.1" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        workspaceRoot: root,
        transport: "file",
        graphStorePath: storePath,
        maxContextTokens: 200,
      },
      learningPolicy: {
        enableFlywheel: true,
        trainingCadence: "nightly",
        exportPath: join(root, "learning.jsonl"),
      },
      embeddingPolicy: { enabled: false },
    })
  );
}

describe("skill sync (git-based team sharing)", () => {
  it("exports to and imports from the committable team package path", async () => {
    writeConfig();

    // Seed local skills through the real learning path.
    const seedConfig = validateConfig(JSON.parse(JSON.stringify({
      providers: {},
      tiers: {
        smart: { provider: "openai", model: "gpt-4.1" },
        economy: { provider: "openai", model: "gpt-4.1-mini" },
      },
      budgetPolicy: { runTokenCap: 2000 },
      graphPolicy: {
        enableAutoBuild: true,
        workspaceRoot: root,
        transport: "file",
        graphStorePath: storePath,
        maxContextTokens: 200,
      },
      learningPolicy: {
        enableFlywheel: true,
        trainingCadence: "nightly",
        exportPath: join(root, "learning.jsonl"),
      },
    })));
    const seedClient = createGraphClient(seedConfig);
    await applySkillLearning(seedClient, "refactor planner module and add tests", {
      status: "COMPLETED",
      attempts: 1,
      feedback: "done",
    });
    const seededCount = (seedClient.readSnapshot?.().nodes ?? []).filter((n) => n.type === "Skill").length;
    expect(seededCount).toBeGreaterThan(0);

    // Export to the canonical committable path.
    const exported = await syncSkillPackageRuntime(configPath, "export");
    expect(exported.direction).toBe("export");
    const teamPath = join(root, ".graphflow", "skills", "team-skills.json");
    expect(exported.path).toBe(teamPath);
    expect(existsSync(teamPath)).toBe(true);
    if (exported.direction === "export") {
      expect(exported.skillCount).toBe(seededCount);
    }

    // Wipe the local graph and re-import from the team package.
    rmSync(storePath, { force: true });
    const imported = await syncSkillPackageRuntime(configPath, "import");
    expect(imported.direction).toBe("import");
    if (imported.direction === "import") {
      expect(imported.imported).toBe(seededCount);
      expect(imported.skipped).toBe(0);
    }

    // Re-import is idempotent (existing skills skipped).
    const reimported = await syncSkillPackageRuntime(configPath, "import");
    if (reimported.direction === "import") {
      expect(reimported.imported).toBe(0);
      expect(reimported.skipped).toBe(seededCount);
    }
  });
});
