import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildProjectFacts,
  factHash,
  isStale,
  mergeFacts,
  observeValidation,
  staleFacts,
  type ProjectFact,
} from "../src/project/facts.js";
import type { CollectedProjectFacts } from "../src/host/project-facts.js";

const NOW = Date.parse("2026-10-01T03:00:00.000Z");
const HEAD = "a".repeat(40);

const collected = (overrides?: Partial<CollectedProjectFacts>): CollectedProjectFacts => ({
  twinFacts: {
    root: "/repo",
    packageJson: {
      name: "demo-app",
      scripts: { test: "vitest run", build: "tsc -p ." },
      dependencies: ["react"],
    },
    fileMap: [
      { path: "src/a.ts", symbols: ["a"] },
      { path: "src/b.ts", symbols: [] },
      { path: "README.md", symbols: [] },
    ],
    recentCommits: ["abc123 fix", "def456 feat"],
  },
  projectState: {
    gitHead: HEAD,
    workingTreeHash: "0123456789abcdef",
    relevantFileHashes: { "src/a.ts": "1111111111111111" },
    dependencyLockHash: "package-lock.json:fedcba9876543210",
  },
  relevantFiles: ["src/a.ts", "src/b.ts"],
  symbolsByFile: new Map([["src/a.ts", ["a"]]]),
  isGitRepo: true,
  ...(overrides ?? {}),
});

const byKey = (facts: ProjectFact[]): Map<string, ProjectFact> => new Map(facts.map((f) => [f.key, f]));

const fact = (key: string, value: string, observedAt: string, extra?: Partial<ProjectFact>): ProjectFact => ({
  key,
  value,
  source: "git",
  observedAt,
  confidence: 1,
  provenance: "test",
  hash: factHash(key, value),
  ...(extra ?? {}),
});

describe("buildProjectFacts", () => {
  it("emits every fact family with source, provenance and confidence", () => {
    const facts = buildProjectFacts(collected(), { now: NOW, graphVersion: "graphflow-graph.json:1234:99" });
    const map = byKey(facts);
    expect([...map.keys()]).toEqual([
      "files.count",
      "files.relevant",
      "git.head",
      "git.recentCommits",
      "git.workingTree",
      "graph.version",
      "lockfile",
      "package.name",
      "package.scripts.build",
      "package.scripts.test",
    ]);
    expect(map.get("git.head")).toMatchObject({
      value: HEAD,
      source: "git",
      confidence: 1,
      provenance: "git rev-parse HEAD",
    });
    expect(map.get("git.workingTree")).toMatchObject({ value: "0123456789abcdef", source: "git", confidence: 1 });
    expect(map.get("git.workingTree")?.provenance).toContain("git status --porcelain");
    expect(map.get("git.recentCommits")).toMatchObject({ value: "2", source: "git", provenance: "git log --oneline -10" });
    expect(map.get("package.name")).toMatchObject({
      value: "demo-app",
      source: "package.json",
      confidence: 0.95,
      provenance: "package.json#name",
    });
    expect(map.get("package.scripts.test")).toMatchObject({
      value: "vitest run",
      source: "package.json",
      confidence: 0.95,
      provenance: "package.json#scripts.test",
    });
    expect(map.get("package.scripts.build")?.value).toBe("tsc -p .");
    expect(map.get("lockfile")).toMatchObject({
      value: "package-lock.json:fedcba9876543210",
      source: "lockfile",
      confidence: 1,
    });
    expect(map.get("lockfile")?.provenance).toContain("package-lock.json");
    expect(map.get("graph.version")).toMatchObject({
      value: "graphflow-graph.json:1234:99",
      source: "graph",
      confidence: 0.8,
    });
    expect(map.get("files.count")?.value).toBe("3");
    expect(map.get("files.relevant")?.value).toBe("src/a.ts,src/b.ts");
  });

  it("stamps observedAt, hashes key+value, and omits validAt unless a TTL is given", () => {
    const facts = buildProjectFacts(collected(), { now: NOW });
    for (const f of facts) {
      expect(f.observedAt).toBe("2026-10-01T03:00:00.000Z");
      expect(f.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(f.hash).toBe(createHash("sha256").update(f.key + f.value).digest("hex").slice(0, 16));
      expect(f).not.toHaveProperty("validAt");
      expect(f.confidence).toBeGreaterThan(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
    const withTtl = buildProjectFacts(collected(), { now: NOW, ttlMs: 60_000 });
    expect(withTtl.every((f) => f.validAt === "2026-10-01T03:01:00.000Z")).toBe(true);
  });

  it("omits facts the host could not observe (no placeholders)", () => {
    const bare = collected({
      twinFacts: { root: "/repo", fileMap: [], recentCommits: [] },
      projectState: { relevantFileHashes: {} },
      relevantFiles: [],
      isGitRepo: false,
    });
    const keys = buildProjectFacts(bare, { now: NOW }).map((f) => f.key);
    expect(keys).toEqual(["files.count", "files.relevant"]);
  });

  it("is deterministic for the same input", () => {
    expect(buildProjectFacts(collected(), { now: NOW })).toEqual(buildProjectFacts(collected(), { now: NOW }));
  });
});

describe("observeValidation", () => {
  it("adds build/test facts from checks with confidence 1.0", () => {
    const facts = observeValidation([], [
      { name: "tsc", passed: true },
      { name: "npm run build", passed: false },
      { name: "typecheck", passed: true },
      { name: "vitest", passed: false },
    ], NOW);
    const map = byKey(facts);
    expect(map.get("build.tsc")).toMatchObject({ value: "passed", source: "build", confidence: 1 });
    expect(map.get("build.npm run build")).toMatchObject({ value: "failed", source: "build" });
    expect(map.get("build.typecheck")?.source).toBe("build");
    expect(map.get("test.vitest")).toMatchObject({ value: "failed", source: "test", confidence: 1 });
    expect(map.get("test.vitest")?.observedAt).toBe(new Date(NOW).toISOString());
    expect(map.get("test.vitest")?.hash).toBe(factHash("test.vitest", "failed"));
    expect(facts.map((f) => f.key)).toEqual([...facts.map((f) => f.key)].sort());
  });

  it("current observations override older facts with the same key, even if dated later", () => {
    const prior = [
      fact("test.vitest", "passed", "2026-10-02T00:00:00.000Z", { source: "test" }),
      fact("git.head", HEAD, "2026-10-01T00:00:00.000Z"),
    ];
    const updated = observeValidation(prior, [{ name: "vitest", passed: false }], NOW);
    expect(updated).toHaveLength(2);
    const map = byKey(updated);
    expect(map.get("test.vitest")?.value).toBe("failed");
    expect(map.get("git.head")).toEqual(prior[1]);
    // Input is not mutated.
    expect(prior[0]?.value).toBe("passed");
  });

  it("the last check with a given name wins", () => {
    const facts = observeValidation([], [
      { name: "vitest", passed: false },
      { name: "vitest", passed: true },
    ], NOW);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.value).toBe("passed");
  });
});

describe("mergeFacts", () => {
  it("keeps the newest observation per key and sorts by key", () => {
    const previous = [
      fact("z.key", "old", "2026-10-01T00:00:00.000Z"),
      fact("a.key", "newer-in-previous", "2026-10-03T00:00:00.000Z"),
      fact("m.only-previous", "kept", "2026-09-01T00:00:00.000Z"),
    ];
    const fresh = [
      fact("z.key", "new", "2026-10-02T00:00:00.000Z"),
      fact("a.key", "older-in-fresh", "2026-10-02T00:00:00.000Z"),
      fact("b.only-fresh", "added", "2026-10-02T00:00:00.000Z"),
    ];
    const merged = mergeFacts(previous, fresh);
    expect(merged.map((f) => `${f.key}=${f.value}`)).toEqual([
      "a.key=newer-in-previous",
      "b.only-fresh=added",
      "m.only-previous=kept",
      "z.key=new",
    ]);
  });

  it("fresh wins ties and unparsable timestamps lose", () => {
    const at = "2026-10-01T00:00:00.000Z";
    expect(mergeFacts([fact("k", "prev", at)], [fact("k", "fresh", at)])[0]?.value).toBe("fresh");
    expect(mergeFacts([fact("k", "prev", at)], [fact("k", "fresh", "garbage")])[0]?.value).toBe("prev");
  });

  it("merging a rebuild over an old snapshot reflects the new HEAD", () => {
    const old = buildProjectFacts(collected(), { now: NOW - 60_000 });
    const newHead = "b".repeat(40);
    const fresh = buildProjectFacts(
      collected({ projectState: { ...collected().projectState, gitHead: newHead } }),
      { now: NOW }
    );
    const merged = byKey(mergeFacts(old, fresh));
    expect(merged.get("git.head")?.value).toBe(newHead);
    expect(merged.get("git.head")?.hash).toBe(factHash("git.head", newHead));
  });
});

describe("staleness", () => {
  it("a fact is stale once validAt is in the past", () => {
    const facts = [
      fact("no-expiry", "v", "2026-10-01T00:00:00.000Z"),
      fact("expired", "v", "2026-10-01T00:00:00.000Z", { validAt: "2026-10-01T02:59:59.999Z" }),
      fact("exactly-now", "v", "2026-10-01T00:00:00.000Z", { validAt: new Date(NOW).toISOString() }),
      fact("future", "v", "2026-10-01T00:00:00.000Z", { validAt: "2026-10-01T04:00:00.000Z" }),
      fact("garbage", "v", "2026-10-01T00:00:00.000Z", { validAt: "not-a-date" }),
    ];
    expect(isStale(facts[0]!, NOW)).toBe(false);
    expect(isStale(facts[1]!, NOW)).toBe(true);
    expect(isStale(facts[2]!, NOW)).toBe(false);
    expect(isStale(facts[3]!, NOW)).toBe(false);
    expect(isStale(facts[4]!, NOW)).toBe(true);
    expect(staleFacts(facts, NOW).map((f) => f.key)).toEqual(["expired", "garbage"]);
  });

  it("TTL-built facts become stale after the TTL elapses", () => {
    const facts = buildProjectFacts(collected(), { now: NOW, ttlMs: 1_000 });
    expect(staleFacts(facts, NOW + 1_000)).toEqual([]);
    expect(staleFacts(facts, NOW + 1_001)).toHaveLength(facts.length);
  });
});
