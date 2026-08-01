import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
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

function buildConfig(): Record<string, unknown> {
  return {
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
  };
}

function writeConfig(): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "demo.ts"), "export function demo() { return 1; }", "utf8");
  writeFileSync(configPath, JSON.stringify(buildConfig()), "utf8");
}

/** 直接向本地图写入一个 Skill 节点（绕过学习飞轮，便于构造确定性的冲突场景）。 */
async function seedLocalSkill(id: string, name: string, updatedAt: number): Promise<void> {
  const seedConfig = validateConfig(JSON.parse(JSON.stringify(buildConfig())));
  const client = createGraphClient(seedConfig);
  await client.upsertNodes([makeSkill(id, name, updatedAt)]);
}

function makeSkill(id: string, name: string, updatedAt: number) {
  return {
    id,
    type: "Skill" as const,
    content: JSON.stringify({
      kind: "atomic",
      id,
      name,
      score: 5,
      uses: 2,
      lastOutcome: "pass",
      updatedAt,
    }),
  };
}

function writePackage(fileName: string, pkg: unknown): void {
  writeFileSync(join(root, fileName), JSON.stringify(pkg, null, 2), "utf8");
}

function localSkillNodes(): Array<{ id: string; content: string }> {
  const cfg = validateConfig(JSON.parse(JSON.stringify(buildConfig())));
  const client = createGraphClient(cfg);
  return (client.readSnapshot?.().nodes ?? []).filter(
    (n): n is { id: string; content: string; type: string } => n.type === "Skill"
  );
}

function localSkillContent(id: string): string | undefined {
  return localSkillNodes().find((n) => n.id === id)?.content;
}

describe("skill sync (git-based team sharing)", () => {
  it("exports to and imports from the committable team package path", async () => {
    writeConfig();

    // Seed local skills through the real learning path.
    const seedConfig = validateConfig(JSON.parse(JSON.stringify(buildConfig())));
    const seedClient = createGraphClient(seedConfig);
    await applySkillLearning(seedClient, "refactor planner module in planner.ts and add tests", {
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
      expect(imported.updated).toBe(0);
    }

    // Re-import is idempotent (existing skills kept local on ties).
    const reimported = await syncSkillPackageRuntime(configPath, "import");
    if (reimported.direction === "import") {
      expect(reimported.imported).toBe(0);
      expect(reimported.skipped).toBe(seededCount);
      expect(reimported.updated).toBe(0);
    }
  });

  it("imports with merge: newer updatedAt wins, ties keep local, older keeps local", async () => {
    writeConfig();
    const base = 1_700_000_000_000;
    const skillId = "skill:merge-demo";
    await seedLocalSkill(skillId, "local-version", base);

    // Incoming package carries a NEWER revision → wins the conflict.
    writePackage("pkg-newer.json", {
      version: "1.1",
      exportedAt: new Date().toISOString(),
      skills: [makeSkill(skillId, "team-version", base + 100_000)],
    });
    const newerImport = await syncSkillPackageRuntime(configPath, "import", "pkg-newer.json");
    expect(newerImport.direction).toBe("import");
    if (newerImport.direction === "import") {
      expect(newerImport.imported).toBe(1);
      expect(newerImport.updated).toBe(1);
      expect(newerImport.skipped).toBe(0);
    }
    expect(JSON.parse(localSkillContent(skillId) ?? "{}").name).toBe("team-version");

    // Re-import of the identical package → updatedAt tie keeps local (idempotent).
    const tieImport = await syncSkillPackageRuntime(configPath, "import", "pkg-newer.json");
    if (tieImport.direction === "import") {
      expect(tieImport.imported).toBe(0);
      expect(tieImport.updated).toBe(0);
      expect(tieImport.skipped).toBe(1);
    }

    // Incoming package carries an OLDER revision → local wins.
    writePackage("pkg-older.json", {
      version: "1.1",
      exportedAt: new Date().toISOString(),
      skills: [makeSkill(skillId, "stale-version", base - 100_000)],
    });
    const olderImport = await syncSkillPackageRuntime(configPath, "import", "pkg-older.json");
    if (olderImport.direction === "import") {
      expect(olderImport.imported).toBe(0);
      expect(olderImport.updated).toBe(0);
      expect(olderImport.skipped).toBe(1);
    }
    expect(JSON.parse(localSkillContent(skillId) ?? "{}").name).toBe("team-version");
  });

  it("preserves local-only skills on import", async () => {
    writeConfig();
    const base = 1_700_000_000_000;
    await seedLocalSkill("skill:local-only", "local-skill", base);
    writePackage("pkg-team.json", {
      version: "1.1",
      exportedAt: new Date().toISOString(),
      skills: [makeSkill("skill:team-only", "team-skill", base + 1000)],
    });
    const imported = await syncSkillPackageRuntime(configPath, "import", "pkg-team.json");
    if (imported.direction === "import") {
      expect(imported.imported).toBe(1);
      expect(imported.skipped).toBe(0);
    }
    const ids = localSkillNodes().map((n) => n.id);
    expect(ids).toContain("skill:local-only");
    expect(ids).toContain("skill:team-only");
  });

  it("merges golden queries into .graphflow/team-golden.json (dedupe, local-first) and bundles them on export", async () => {
    writeConfig();
    const sidecar = join(root, ".graphflow", "team-golden.json");
    writeFileSync(sidecar, JSON.stringify(["local-q1", "shared-q"], null, 2), "utf8");
    writePackage("pkg-golden.json", {
      version: "1.1",
      exportedAt: new Date().toISOString(),
      skills: [],
      goldenQueries: ["shared-q", "team-q2", "local-q1"],
    });

    // Import merges: local-first order, dedupe by exact query text.
    const imported = await syncSkillPackageRuntime(configPath, "import", "pkg-golden.json");
    if (imported.direction === "import") {
      expect(imported.goldenPath).toBe(sidecar);
      expect(imported.goldenQueries).toBe(3);
    }
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual(["local-q1", "shared-q", "team-q2"]);

    // Re-import is idempotent for the golden set.
    await syncSkillPackageRuntime(configPath, "import", "pkg-golden.json");
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual(["local-q1", "shared-q", "team-q2"]);

    // Export bundles the canonical team golden query list into the package.
    const exported = await syncSkillPackageRuntime(configPath, "export");
    expect(exported.direction).toBe("export");
    const teamPkg = JSON.parse(
      readFileSync(join(root, ".graphflow", "skills", "team-skills.json"), "utf8")
    ) as { goldenQueries?: string[] };
    expect(Array.isArray(teamPkg.goldenQueries)).toBe(true);
    expect(teamPkg.goldenQueries?.length).toBeGreaterThan(0);
    expect(teamPkg.goldenQueries).toContain("orchestrate task routing");
  });

  it("--force restores overwrite semantics on import", async () => {
    writeConfig();
    const base = 1_700_000_000_000;
    const skillId = "skill:force-demo";
    await seedLocalSkill(skillId, "local-newer", base + 1_000_000);
    const sidecar = join(root, ".graphflow", "team-golden.json");
    writeFileSync(sidecar, JSON.stringify(["local-q1"], null, 2), "utf8");
    writePackage("pkg-force.json", {
      version: "1.1",
      exportedAt: new Date().toISOString(),
      skills: [makeSkill(skillId, "package-stale", base)],
      goldenQueries: ["force-q1", "force-q2"],
    });

    // force: stale package unconditionally overwrites the newer local skill.
    const forced = await syncSkillPackageRuntime(configPath, "import", "pkg-force.json", {
      force: true,
    });
    if (forced.direction === "import") {
      expect(forced.imported).toBe(1);
      expect(forced.updated).toBe(0);
      expect(forced.skipped).toBe(0);
    }
    expect(JSON.parse(localSkillContent(skillId) ?? "{}").name).toBe("package-stale");

    // force: golden sidecar is overwritten wholesale (no local-first merge).
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual(["force-q1", "force-q2"]);
  });
});
