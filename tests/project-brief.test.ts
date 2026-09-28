import { describe, expect, it } from "vitest";
import type { GraphNode } from "../src/core/types";
import { buildRefResolver } from "../src/learning/memory-freshness";
import {
  buildProjectBrief,
  isProjectBriefEnabled,
  ProjectBriefCache,
  validateProjectBrief,
} from "../src/graph/project-brief";

function module_(id: string, sourcePath?: string): GraphNode {
  return {
    id,
    type: "Module",
    content: `module: ${sourcePath ?? id.replace(/^module:/, "")}`,
    ...(sourcePath ? { metadata: { sourcePath } } : {}),
  };
}

function file(id: string, sourcePath?: string): GraphNode {
  return {
    id,
    type: "File",
    content: sourcePath ?? id.replace(/^file:/, ""),
    ...(sourcePath ? { metadata: { sourcePath } } : {}),
  };
}

const REPO: GraphNode[] = [
  module_("module:src/core", "src/core"),
  module_("module:src/graph", "src/graph"),
  module_("module:src/graph", "src/graph"),
  file("file:src/core/a.ts"),
  file("file:src/core/b.ts"),
  file("file:src/graph/c.ts"),
  file("file:package.json"),
  file("file:README.md"),
  file("file:tsconfig.json"),
];

describe("project brief", () => {
  it("produces module, file and entry-point sections in a fixed order", () => {
    const brief = buildProjectBrief(REPO);
    expect(brief.lines[0]).toContain("stable across turns");
    expect(brief.lines.some((l) => l === "brief: modules=2")).toBe(true);
    // Duplicate module nodes must not inflate the count.
    expect(brief.lines.some((l) => l === "module: src/core")).toBe(true);
    expect(brief.lines.some((l) => l === "files: src/core (2)")).toBe(true);
    expect(brief.lines.some((l) => l.startsWith("brief: entry points="))).toBe(true);
    // Entry points appear in the fixed candidate order, not arbitrary order.
    const entry = brief.lines.find((l) => l.startsWith("brief: entry points="))!;
    expect(entry.indexOf("package.json")).toBeLessThan(entry.indexOf("README.md"));
  });

  it("is byte-identical across calls and across input ordering", () => {
    const a = buildProjectBrief(REPO);
    const b = buildProjectBrief(REPO);
    const shuffled = buildProjectBrief([...REPO].reverse());
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.lines).toEqual(b.lines);
    // The host's cache is a byte match, so a reordered input must not reorder
    // our output.
    expect(shuffled.fingerprint).toBe(a.fingerprint);
  });

  it("truncates long inventories and says how much it dropped", () => {
    // 30 distinct directories, so the per-directory cap never bites and only the
    // global one does.
    const many = Array.from({ length: 30 }, (_, i) => module_(`module:pkg${i}/mod`));
    const brief = buildProjectBrief(many, { maxModules: 5 });
    expect(brief.lines.filter((l) => l.startsWith("module: ")).length).toBe(5);
    expect(brief.lines.some((l) => l.includes("+25 more modules"))).toBe(true);
  });

  it("spends its budget where the code actually is", () => {
    // Three attempts to fix the map by ordering alone all failed identically:
    // any name-ordered cap is eaten by whichever directory sorts first. On this
    // repo that was `benchmarks/*` and `docs/*`, so `src/*` never appeared. The
    // file counts already know the answer, so the map follows them.
    const files = (dir: string, n: number): GraphNode[] =>
      Array.from({ length: n }, (_, i) => file(`file:${dir}/f${i}.ts`));
    const lopsided = [
      ...Array.from({ length: 40 }, (_, i) => module_(`module:benchmarks/run-${i}`)),
      ...Array.from({ length: 8 }, (_, i) => module_(`module:src/graph/mod${i}`)),
      ...Array.from({ length: 8 }, (_, i) => module_(`module:src/core/mod${i}`)),
      ...files("benchmarks", 2),
      ...files("src/graph", 50),
      ...files("src/core", 19),
    ];
    const brief = buildProjectBrief(lopsided, { maxModules: 6, maxPerDirectory: 3 });
    const listed = brief.lines.filter((l) => l.startsWith("module: "));
    // The two heaviest directories lead, three entries each.
    expect(listed).toHaveLength(6);
    expect(listed.filter((l) => l.startsWith("module: src/graph/"))).toHaveLength(3);
    expect(listed.filter((l) => l.startsWith("module: src/core/"))).toHaveLength(3);
    // The 40-entry lightweight directory gets nothing, and that is the point.
    expect(listed.some((l) => l.startsWith("module: benchmarks/"))).toBe(false);
    expect(brief.lines.some((l) => l.includes("per directory"))).toBe(true);
  });

  it("omits module nodes that are not project paths, and counts them", () => {
    // The live graph carried 888 module nodes for a repo with a few dozen
    // source directories: the rest were bare names (`argparse`, `AUDIT.md`)
    // derived from things that were never directories here. Listing them would
    // not make the map worse — it would make it a map of something else.
    const polluted = [
      ...REPO,
      module_("module:argparse"),
      module_("module:asyncio"),
      module_("module:AUDIT.md"),
      module_("module:调研报告-v1.9.5"),
    ];
    const brief = buildProjectBrief(polluted);
    expect(brief.lines.some((l) => l.includes("argparse"))).toBe(false);
    expect(brief.lines.some((l) => l.includes("AUDIT.md"))).toBe(false);
    expect(brief.lines.some((l) => l.includes("not project paths, omitted"))).toBe(true);
    // Real directories still listed.
    expect(brief.lines.some((l) => l === "module: src/core")).toBe(true);
  });

  it("validates a brief whose refs all still resolve", () => {
    const brief = buildProjectBrief(REPO);
    const validity = validateProjectBrief(brief, REPO);
    expect(validity.valid).toBe(true);
    expect(validity.deadRefs).toEqual([]);
    expect(validity.reason).toContain("still resolve");
  });

  it("fails validation when the repository moved", () => {
    const brief = buildProjectBrief(REPO);
    // A deleted file retires its node id, exactly as an edited symbol retires a
    // content-hashed symbol id.
    const shrunken = REPO.filter((n) => n.id !== "file:src/core/b.ts");
    const validity = validateProjectBrief(brief, shrunken);
    expect(validity.valid).toBe(false);
    expect(validity.deadRefs).toContain("src/core/b.ts");
    expect(validity.reason).toContain("repository moved");
  });

  it("validates in the freshness resolver's own vocabulary", () => {
    // The brief records refs in exactly the form buildRefResolver indexes: a
    // file by its stripped path, everything else by raw id. If that indexing
    // ever changes, this test fails here — otherwise every stored brief would
    // silently report itself stale and rebuild on every single call.
    const brief = buildProjectBrief(REPO);
    const resolves = buildRefResolver(REPO);
    for (const ref of brief.refs) {
      expect(resolves(ref), `ref ${ref} must resolve in the shared resolver`).toBe(true);
    }
    expect(brief.refs).toContain("src/core/b.ts");
    expect(brief.refs).toContain("module:src/core");
  });

  it("refuses to validate a brief with no refs", () => {
    // An empty brief must not read as "valid" — that would let an empty
    // artefact live in the cache forever.
    const empty = buildProjectBrief([]);
    expect(empty.refs).toEqual([]);
    const validity = validateProjectBrief(empty, REPO);
    expect(validity.valid).toBe(false);
    expect(validity.reason).toContain("no refs");
  });

  it("reuses a stored brief when the repository has not moved", () => {
    const cache = new ProjectBriefCache();
    const first = cache.resolve("/w", REPO);
    expect(first.reused).toBe(false);
    expect(first.validity).toBeNull();

    const second = cache.resolve("/w", REPO);
    expect(second.reused).toBe(true);
    expect(second.brief!.fingerprint).toBe(first.brief!.fingerprint);
    expect(second.reason).toContain("still resolve");
  });

  it("rebuilds when refs die, and says so", () => {
    const cache = new ProjectBriefCache();
    cache.resolve("/w", REPO);
    const grown = [...REPO, file("file:src/graph/d.ts")];
    const third = cache.resolve("/w", grown);
    // A pure addition invalidates nothing, so this must be a reuse — a brief
    // that rebuilds on every unrelated edit is exactly the churn we avoid.
    expect(third.reused).toBe(true);

    const shrunken = REPO.filter((n) => n.id !== "file:src/core/b.ts");
    const fourth = cache.resolve("/w", shrunken);
    expect(fourth.reused).toBe(false);
    expect(fourth.reason).toContain("rebuilt");
    expect(fourth.validity!.deadRefs).toContain("src/core/b.ts");
  });

  it("keeps briefs separate per workspace", () => {
    const cache = new ProjectBriefCache();
    const a = cache.resolve("/a", REPO);
    const b = cache.resolve("/b", REPO);
    expect(a.reused).toBe(false);
    expect(b.reused).toBe(false);
    expect(a.brief!.fingerprint).toBe(b.brief!.fingerprint);
  });

  it("bounds the cache instead of leaking", () => {
    const cache = new ProjectBriefCache(2);
    cache.resolve("/a", REPO);
    cache.resolve("/b", REPO);
    cache.resolve("/c", REPO);
    // The third resolve must have cleared rather than growing past the bound.
    const again = cache.resolve("/a", REPO);
    expect(again.reused).toBe(false);
  });

  it("excludes paths outside the workspace and says how many", () => {
    // Live on this repo the unfiltered map was dominated by sibling checkouts
    // and a dotfile skill dir. Those paths are stable, so they passed every
    // stability check while making the map confidently wrong about *this*
    // project — the worst combination, because the host caches it and trusts it.
    const polluted = [
      ...REPO,
      module_("module:../LightNav-0/tests"),
      module_("module:../Robot_Screw/hmi"),
      file("file:../other-project/main.ts"),
      file("file:src/ok.ts"),
    ];
    const brief = buildProjectBrief(polluted);
    expect(brief.outOfScopePaths).toBe(3);
    expect(brief.lines.some((l) => l.includes("LightNav"))).toBe(false);
    expect(brief.lines.some((l) => l.includes("Robot_Screw"))).toBe(false);
    expect(brief.lines.some((l) => l.includes("outside the workspace"))).toBe(true);
    // In-scope content survives. Files render as directory counts rather than
    // individual paths, so assert on the ref surface and on the file total.
    expect(brief.refs).toContain("src/ok.ts");
    expect(brief.lines.some((l) => /^brief: files=\d+/.test(l))).toBe(true);
    expect(brief.lines.some((l) => l.startsWith("files: src "))).toBe(true);
    // Skipped paths must not become validation refs either, or the brief would
    // demand they come back.
    expect(brief.refs.some((ref) => ref.includes("LightNav"))).toBe(false);
  });

  it("keeps dotfile paths that are genuinely inside the workspace", () => {
    const dotted = [...REPO, file("file:.agents/skills/x/SKILL.md"), module_("module:.cursor/rules")];
    const brief = buildProjectBrief(dotted);
    expect(brief.outOfScopePaths).toBe(0);
    expect(brief.lines.some((l) => l.includes(".agents"))).toBe(true);
  });

  it("spends its module budget on the project, not on tooling or dependencies", () => {
    // Three rounds of this, each caught live: dotfile skill dirs, then npm
    // scoped packages, then bare names — all stable, all sorting ahead of every
    // `src/` path, all quietly taking the map's budget. They are now omitted and
    // counted rather than ranked or listed.
    const noisy = [
      ...REPO,
      ...Array.from({ length: 40 }, (_, i) => module_(`module:.agents/skills/s${i}`)),
      ...Array.from({ length: 30 }, (_, i) => module_(`module:@scope/pkg-${i}/dist/index`)),
      ...Array.from({ length: 20 }, (_, i) => module_(`module:pkg${i}/mod`)),
    ];
    const brief = buildProjectBrief(noisy, { maxModules: 8, maxPerDirectory: 8 });
    const listed = brief.lines.filter((l) => l.startsWith("module: "));
    expect(listed.length).toBe(8);
    expect(listed.every((l) => !l.includes(".agents") && !l.includes("@scope"))).toBe(true);
    // The totals still account for everything, so the map is visibly partial
    // rather than silently curated.
    expect(brief.lines.some((l) => /^brief: modules=\d+$/.test(l))).toBe(true);
    expect(brief.lines.some((l) => l.includes("not project paths, omitted"))).toBe(true);
  });

  it("reads the switch", () => {
    expect(isProjectBriefEnabled({})).toBe(false);
    expect(isProjectBriefEnabled({ GRAPHFLOW_PROJECT_BRIEF: "0" })).toBe(false);
    expect(isProjectBriefEnabled({ GRAPHFLOW_PROJECT_BRIEF: "1" })).toBe(true);
    expect(isProjectBriefEnabled({ GRAPHFLOW_PROJECT_BRIEF: "TRUE" })).toBe(true);
  });
});
