import { describe, expect, it } from "vitest";
import {
  classifyCacheLine,
  isCacheLayoutEnabled,
  planCacheLayout,
} from "../src/graph/cache-layout";

describe("cache layout planner", () => {
  it("classes repo-map and convention lines as stable", () => {
    expect(classifyCacheLine("module:orchestrator")).toBe("stable");
    expect(classifyCacheLine("repo-map: 12 modules, 40 files")).toBe("stable");
    expect(classifyCacheLine("convention: 前稳后动 (stable prefix first)")).toBe("stable");
  });

  it("catches the slicer's prose form of a module line", () => {
    // The live run showed the slicer emits "Module: <path>" in the summary
    // channel as well as the bare `module:` id. Classing the prose form as
    // volatile loses real cache reuse, which is the failure this module exists
    // to prevent — so the regression is pinned here.
    expect(classifyCacheLine("Module: src/core/orchestrator-phases")).toBe("stable");
  });

  it("classes the project brief's own line kinds as stable", () => {
    // The brief is stable by construction — it is rebuilt only when its refs stop
    // resolving. Classing its lines as volatile put all ~3k tokens in the delta
    // bucket, which is the difference between the host caching them every turn
    // and caching none of them.
    expect(classifyCacheLine("brief: project map (stable across turns)")).toBe("stable");
    expect(classifyCacheLine("brief: modules=888")).toBe("stable");
    expect(classifyCacheLine("exports: src/graph/cache-layout.ts -> planCacheLayout")).toBe("stable");
    expect(classifyCacheLine("files: src/graph (50)")).toBe("stable");
    expect(classifyCacheLine("brief: entry points=package.json,README.md")).toBe("stable");
  });

  it("classes query-scoped lines as per-turn delta", () => {
    expect(classifyCacheLine("file:graph/cache-layout.ts")).toBe("delta");
    expect(classifyCacheLine("symbol:graph/cache-layout.ts:ab12cd")).toBe("delta");
    expect(classifyCacheLine("dialogue:ab:0001")).toBe("delta");
    expect(classifyCacheLine("handle:src/one.ts:12")).toBe("delta");
    expect(classifyCacheLine("summary: 3 anchors")).toBe("delta");
  });

  it("defaults an unrecognised line to volatile", () => {
    // The one error that silently breaks a host's cache is assuming stability
    // for a line we cannot place, so the default must be the safe side.
    expect(classifyCacheLine("some prose we have never seen before")).toBe("delta");
    expect(classifyCacheLine("")).toBe("delta");
  });

  it("puts every stable line before every delta line", () => {
    // Stability is a property of the sequence, not just of each line: a host
    // that concatenates stable-then-delta must get the right order for free.
    const plan = planCacheLayout({
      lines: [
        "file:src/a.ts",
        "repo-map: 3 modules",
        "symbol:src/b.ts:11",
        "convention: keep the prefix stable",
        "dialogue:ab:0002",
      ],
    });
    expect(plan.stablePrefix.lines).toEqual([
      "repo-map: 3 modules",
      "convention: keep the prefix stable",
    ]);
    expect(plan.delta.lines).toEqual([
      "file:src/a.ts",
      "symbol:src/b.ts:11",
      "dialogue:ab:0002",
    ]);
    expect(plan.stablePrefix.tokens).toBeGreaterThan(0);
    expect(plan.delta.tokens).toBeGreaterThan(0);
  });

  it("reports null rather than zero when the host prefix is unknown", () => {
    // 0 would claim "nothing in the request is reusable" — a much stronger and
    // almost certainly false statement than admitting we cannot see the host.
    const plan = planCacheLayout({ lines: ["repo-map: 3 modules", "file:src/a.ts"] });
    expect(plan.reusablePrefixShare).toBeNull();
    const known = planCacheLayout({
      lines: ["repo-map: 3 modules", "file:src/a.ts"],
      staticPrefixTokens: 8_000,
    });
    expect(known.reusablePrefixShare).not.toBeNull();
    expect(known.reusablePrefixShare!).toBeGreaterThan(0.99);
  });

  it("says so when the package is entirely query-scoped", () => {
    const plan = planCacheLayout({ lines: ["file:src/a.ts", "symbol:src/b.ts:11"] });
    expect(plan.stablePrefix.tokens).toBe(0);
    expect(plan.stableShare).toBe(0);
    expect(plan.note).toContain("entirely query-scoped");
  });

  it("handles an empty package without dividing by zero", () => {
    const plan = planCacheLayout({ lines: [] });
    expect(plan.stablePrefix.tokens).toBe(0);
    expect(plan.delta.tokens).toBe(0);
    expect(plan.stableShare).toBe(0);
    expect(plan.note).toBe("empty package — nothing to lay out");
  });

  it("is deterministic", () => {
    const lines = ["repo-map: 1 module", "file:src/a.ts", "convention: x"];
    expect(planCacheLayout({ lines })).toEqual(planCacheLayout({ lines }));
  });

  it("reads the switch", () => {
    expect(isCacheLayoutEnabled({})).toBe(false);
    expect(isCacheLayoutEnabled({ GRAPHFLOW_CACHE_LAYOUT: "0" })).toBe(false);
    expect(isCacheLayoutEnabled({ GRAPHFLOW_CACHE_LAYOUT: "1" })).toBe(true);
    expect(isCacheLayoutEnabled({ GRAPHFLOW_CACHE_LAYOUT: "on" })).toBe(true);
  });
});
