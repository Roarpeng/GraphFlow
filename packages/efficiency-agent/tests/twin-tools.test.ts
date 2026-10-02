import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProjectTwin, type ProjectTwinFacts } from "../src/project-twin.js";
import {
  createToolRegistry,
  type ToolCapability,
} from "../src/tools/capability-registry.js";
import { routeTools } from "../src/tools/tool-router.js";

/** Realistic facts: a small TypeScript package with lockfile, tests, build. */
const facts: ProjectTwinFacts = {
  root: "/work/efficiency-agent",
  packageJson: {
    name: "@roarpeng/efficiency-agent",
    main: "dist/index.js",
    scripts: {
      build: "tsc -p .",
      typecheck: "tsc -p . --noEmit",
      test: "vitest run",
      "benchmark:eff": "tsx benchmarks/run-eff-bench.ts",
      dev: "tsx src/cli.ts",
    },
    dependencies: ["vitest", "typescript", "tsx"],
  },
  fileMap: [
    { path: "package.json", symbols: [] },
    { path: "package-lock.json", symbols: [] },
    { path: "src/measurement.ts", symbols: ["Measurement", "measured", "estimated", "proxy"] },
    { path: "src/trace.ts", symbols: ["TaskTrace", "Measurement", "validateTraceProvenance"] },
    { path: "src/tools/capability-registry.ts", symbols: ["ToolCapability", "createToolRegistry"] },
    { path: "src/tools/tool-router.ts", symbols: ["ToolCapability", "routeTools"] },
    { path: "src/core/deep/nested.ts", symbols: ["orphan"] },
    { path: "README.md", symbols: [] },
  ],
  recentCommits: Array.from({ length: 12 }, (_, index) => `commit-${index}`),
};

type CapabilityOverrides = Partial<Omit<ToolCapability, "name">>;

/** Minimal capability with test-friendly defaults (neutral 0/0 history). */
function makeCap(name: string, overrides: CapabilityOverrides = {}): ToolCapability {
  return {
    name,
    capabilities: overrides.capabilities ?? ["search"],
    requiredContext: overrides.requiredContext ?? [],
    successHistory: overrides.successHistory ?? { attempts: 0, successes: 0 },
    ...(overrides.costPerCallUsd !== undefined
      ? { costPerCallUsd: overrides.costPerCallUsd }
      : {}),
    ...(overrides.latencyMsP50 !== undefined ? { latencyMsP50: overrides.latencyMsP50 } : {}),
    ...(overrides.precision !== undefined ? { precision: overrides.precision } : {}),
  };
}

describe("project twin derivation (§10)", () => {
  const twin = buildProjectTwin(facts);

  it("derives project identity from package.json name", () => {
    expect(twin.project).toBe("@roarpeng/efficiency-agent");
    expect(twin.root).toBe("/work/efficiency-agent");
  });

  it("falls back to the root basename (POSIX and Windows) without package.json", () => {
    expect(buildProjectTwin({ root: "/work/graphflow-repo", fileMap: [], recentCommits: [] }).project).toBe("graphflow-repo");
    expect(buildProjectTwin({ root: "C:\\work\\demo", fileMap: [], recentCommits: [] }).project).toBe("demo");
  });

  it("derives sorted, deduped modules with depth capped at 2", () => {
    // src/measurement.ts + src/trace.ts → "src"; both tools files → "src/tools" once;
    // src/core/deep/nested.ts → "src/core" (depth 2); root-level files map to nothing.
    expect(twin.modules).toEqual(["src", "src/core", "src/tools"]);
  });

  it("accepts backslash-separated paths in the file map", () => {
    const windowsTwin = buildProjectTwin({
      root: "C:\\work\\demo",
      fileMap: [{ path: "src\\tools\\registry.ts", symbols: [] }],
      recentCommits: [],
    });
    expect(windowsTwin.modules).toEqual(["src/tools"]);
  });

  it("detects entrypoints: main plus start-like script commands, filtered and sorted", () => {
    // main + "dev" command; no "start" script; "benchmark:eff"/"typecheck" are not start-like.
    expect(twin.entrypoints).toEqual(["dist/index.js", "tsx src/cli.ts"]);
  });

  it("detects build and test script NAMES, not commands", () => {
    expect(twin.build).toEqual(["build"]);
    expect(twin.tests).toEqual(["test"]);
  });

  it("keeps only symbols appearing in >= 2 files, ranked by file count then name", () => {
    expect(twin.importantSymbols).toEqual(["Measurement", "ToolCapability"]);
  });

  it("orders equal-count symbols by name and drops single-file symbols", () => {
    const ranked = buildProjectTwin({
      root: "/w/rank",
      fileMap: [
        { path: "src/a.ts", symbols: ["z", "b", "a"] },
        { path: "src/b.ts", symbols: ["z", "a"] },
        { path: "src/c.ts", symbols: ["z", "solo"] },
      ],
      recentCommits: [],
    });
    expect(ranked.importantSymbols).toEqual(["z", "a"]);
  });

  it("caps important symbols at 20", () => {
    const many = Array.from({ length: 21 }, (_, index) => `sym-${String(index + 1).padStart(2, "0")}`);
    const capped = buildProjectTwin({
      root: "/w/many",
      fileMap: [
        { path: "src/one.ts", symbols: many },
        { path: "src/two.ts", symbols: many },
      ],
      recentCommits: [],
    });
    expect(capped.importantSymbols).toHaveLength(20);
    expect(capped.importantSymbols[0]).toBe("sym-01");
    expect(capped.importantSymbols).not.toContain("sym-21");
  });

  it("sorts dependencies as-is and derives conventions heuristically", () => {
    expect(twin.dependencies).toEqual(["tsx", "typescript", "vitest"]);
    expect(twin.conventions).toEqual(["node", "npm-workspace", "typescript", "vitest"]);
  });

  it("reports only the baseline convention for a bare facts set", () => {
    const bare = buildProjectTwin({ root: "/work/bare", fileMap: [], recentCommits: [] });
    expect(bare.conventions).toEqual(["node"]);
    expect(bare.modules).toEqual([]);
    expect(bare.entrypoints).toEqual([]);
    expect(bare.importantSymbols).toEqual([]);
    expect(bare.dependencies).toEqual([]);
  });

  it("caps recentChanges at 10 preserving recency order", () => {
    expect(twin.recentChanges).toHaveLength(10);
    expect(twin.recentChanges[0]).toBe("commit-0");
    expect(twin.recentChanges[9]).toBe("commit-9");
    expect(twin.recentChanges).not.toContain("commit-10");
  });

  it("is honest in v0: no known issues, no preferred tools yet", () => {
    expect(twin.knownIssues).toEqual([]);
    expect(twin.preferredTools).toEqual([]);
  });

  it("is deterministic and JSON-serializable: same facts → deep-equal twin", () => {
    const again = buildProjectTwin(facts);
    expect(again).toEqual(twin);
    expect(JSON.parse(JSON.stringify(twin))).toEqual(twin);
    // purity: the input facts are left untouched
    expect(facts.recentCommits).toHaveLength(12);
    expect(facts.fileMap.map((entry) => entry.symbols.length)).toEqual([0, 0, 4, 3, 2, 2, 1, 0]);
  });
});

describe("tool capability registry (§9)", () => {
  it("ranks by success rate with attempts 0 as neutral 0.5", () => {
    const cold = makeCap("cold-ripgrep", { successHistory: { attempts: 3, successes: 0 } });
    const neutral = makeCap("neutral-grep");
    const registry = createToolRegistry([cold, neutral]);
    expect(registry.byCapability("search").map((tool) => tool.name)).toEqual([
      "neutral-grep",
      "cold-ripgrep",
    ]);
  });

  it("order flips after outcomes: 0/3 then three wins climbs above the neutral tool", () => {
    const cold = makeCap("cold-ripgrep", { successHistory: { attempts: 3, successes: 0 } });
    const neutral = makeCap("neutral-grep");
    const registry = createToolRegistry([cold, neutral]);
    expect(registry.recordOutcome("cold-ripgrep", true)).toBe(true);
    registry.recordOutcome("cold-ripgrep", true);
    registry.recordOutcome("cold-ripgrep", true);
    const stored = registry.list().find((tool) => tool.name === "cold-ripgrep");
    expect(stored?.successHistory).toEqual({ attempts: 6, successes: 3 });
    expect(registry.byCapability("search").map((tool) => tool.name)).toEqual([
      "cold-ripgrep",
      "neutral-grep",
    ]);
  });

  it("breaks rate ties by latency asc, then cost asc, then name — undefined metrics last", () => {
    const registry = createToolRegistry([
      makeCap("no-meta"), // latency/cost undefined → last among equal rates
      makeCap("a-slow", { latencyMsP50: 900, costPerCallUsd: 0.001 }),
      makeCap("zzz-fast-cheap", { latencyMsP50: 100, costPerCallUsd: 0.001 }),
      makeCap("mmm-fast-pricey", { latencyMsP50: 100, costPerCallUsd: 0.5 }),
      makeCap("aaa-fast-cheap", { latencyMsP50: 100, costPerCallUsd: 0.001 }),
    ]);
    expect(registry.byCapability("search").map((tool) => tool.name)).toEqual([
      "aaa-fast-cheap",
      "zzz-fast-cheap",
      "mmm-fast-pricey",
      "a-slow",
      "no-meta",
    ]);
  });

  it("recordOutcome for an unknown tool is a no-op returning false", () => {
    const registry = createToolRegistry([makeCap("known")]);
    expect(registry.recordOutcome("ghost", true)).toBe(false);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.successHistory).toEqual({ attempts: 0, successes: 0 });
  });

  it("registers failures as well as successes", () => {
    const registry = createToolRegistry([makeCap("flaky")]);
    registry.recordOutcome("flaky", false);
    registry.recordOutcome("flaky", true);
    registry.recordOutcome("flaky", false);
    expect(registry.list()[0]?.successHistory).toEqual({ attempts: 3, successes: 1 });
  });

  it("never mutates the caller's objects and hands out fresh copies", () => {
    const original = makeCap("orig", { capabilities: ["search", "read"] });
    const registry = createToolRegistry();
    registry.register(original);
    original.capabilities.push("write");
    original.successHistory.attempts = 99;
    const stored = registry.list()[0];
    expect(stored?.capabilities).toEqual(["search", "read"]);
    expect(stored?.successHistory).toEqual({ attempts: 0, successes: 0 });
    // mutating a returned copy must not leak back into the registry
    const copy = registry.byCapability("search")[0];
    copy.capabilities.push("write");
    copy.successHistory.attempts = 7;
    expect(registry.byCapability("search")[0]?.capabilities).toEqual(["search", "read"]);
    expect(registry.byCapability("search")[0]?.successHistory).toEqual({ attempts: 0, successes: 0 });
    // recording an outcome must not touch the caller's object either
    registry.recordOutcome("orig", true);
    expect(original.successHistory).toEqual({ attempts: 99, successes: 0 });
    expect(registry.list()[0]?.successHistory).toEqual({ attempts: 1, successes: 1 });
  });

  it("filters byCapability to tools declaring the need", () => {
    const registry = createToolRegistry([
      makeCap("reader", { capabilities: ["read"] }),
      makeCap("both", { capabilities: ["read", "grep"] }),
    ]);
    expect(registry.byCapability("grep").map((tool) => tool.name)).toEqual(["both"]);
    expect(registry.byCapability("teleport")).toEqual([]);
  });
});

describe("tool router (§9)", () => {
  it("prefers the precision-adequate tool over the higher-history-but-imprecise head", () => {
    const impreciseHero = makeCap("imprecise-hero", {
      precision: 0.5,
      successHistory: { attempts: 10, successes: 10 },
    });
    const adequateRookie = makeCap("adequate-rookie", { precision: 0.9 });
    const registry = createToolRegistry([impreciseHero, adequateRookie]);
    // registry rank puts the hero first (rate 1.0) — the router must look past it
    expect(registry.byCapability("search")[0]?.name).toBe("imprecise-hero");
    const selection = routeTools(["search"], registry);
    expect(selection.selected.map((tool) => tool.name)).toEqual(["adequate-rookie"]);
    expect(selection.rejected).toEqual([]);
  });

  it("treats undefined precision as adequate and takes the rank head", () => {
    const registry = createToolRegistry([
      makeCap("untested-head"),
      makeCap("measured-but-losing", {
        precision: 0.85,
        successHistory: { attempts: 2, successes: 0 },
      }),
    ]);
    expect(routeTools(["search"], registry).selected.map((tool) => tool.name)).toEqual([
      "untested-head",
    ]);
  });

  it("falls back to the highest-precision candidate when nothing is adequate", () => {
    const registry = createToolRegistry([
      makeCap("low", { precision: 0.3, successHistory: { attempts: 4, successes: 4 } }),
      makeCap("mid", { precision: 0.6 }),
    ]);
    expect(routeTools(["search"], registry).selected.map((tool) => tool.name)).toEqual(["mid"]);
  });

  it("rejects needs no registered tool can serve with reason no-capability", () => {
    const registry = createToolRegistry([makeCap("reader", { capabilities: ["read"] })]);
    const selection = routeTools(["read", "teleport"], registry);
    expect(selection.selected.map((tool) => tool.name)).toEqual(["reader"]);
    expect(selection.rejected).toEqual([{ name: "teleport", reason: "no-capability" }]);
  });

  it("dedupes one tool serving several needs", () => {
    const swiss = makeCap("swiss", { capabilities: ["read", "grep"] });
    const selection = routeTools(["read", "grep"], createToolRegistry([swiss]));
    expect(selection.selected.map((tool) => tool.name)).toEqual(["swiss"]);
    expect(selection.rejected).toEqual([]);
  });
});

describe("tool capability schema (schemas/tool-capability-v1.schema.json)", () => {
  interface ParsedSchema {
    $id: string;
    required: string[];
    properties: Record<string, { required?: string[] }>;
  }

  const schema = JSON.parse(
    readFileSync(new URL("../schemas/tool-capability-v1.schema.json", import.meta.url), "utf8")
  ) as ParsedSchema;

  it("parses and its required array matches the local type's required fields", () => {
    // ToolCapability's non-optional fields, exactly
    expect([...schema.required].sort()).toEqual([
      "capabilities",
      "name",
      "requiredContext",
      "successHistory",
    ]);
  });

  it("mirrors ToolCapability's full property set, no more, no less", () => {
    expect(Object.keys(schema.properties).sort()).toEqual([
      "capabilities",
      "costPerCallUsd",
      "latencyMsP50",
      "name",
      "permission",
      "precision",
      "requiredContext",
      "risk",
      "successHistory",
      "version",
    ]);
    expect(schema.properties.successHistory?.required).toEqual(["attempts", "successes"]);
    expect(schema.$id.endsWith("tool-capability-v1.schema.json")).toBe(true);
  });
});
