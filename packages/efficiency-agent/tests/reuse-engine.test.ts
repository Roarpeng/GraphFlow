import { describe, expect, it } from "vitest";
import { buildTaskFingerprint, normalizeSemanticTask } from "../src/fingerprint";
import { createContextCache, type KVStore } from "../src/caches/context-cache";
import { createPlanCache } from "../src/caches/plan-cache";
import { createResultCache } from "../src/caches/result-cache";
import { decideReuse } from "../src/reuse-gate";
import type {
  CacheVerdict,
  ContextStateFacts,
  EnvironmentStateFacts,
  ProjectStateFacts,
} from "../src/domain";

// ───────────────────────── fixtures ─────────────────────────

const project: ProjectStateFacts = {
  gitHead: "0123456789abcdef0123456789abcdef01234567",
  workingTreeHash: "wt-1",
  relevantFileHashes: { "src/axis.ts": "h-axis", "package-lock.json": "h-lock" },
  dependencyLockHash: "lock-1",
};

const context: ContextStateFacts = {
  graphVersion: "g-1",
  contextPolicyVersion: "cp-1",
  workingSetHash: "ws-1",
};

const environment: EnvironmentStateFacts = {
  toolVersions: { node: "20.11.0", git: "2.43.0" },
  runtimeVersion: "node-20",
  selectedProvider: "glm",
  dynamicStateFingerprint: "dyn-1",
};

/** Map-based KV fake — the package itself never touches fs. */
function memoryStore(): KVStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
    },
  };
}

function verdictOf(kind: CacheVerdict["kind"], hit: boolean): CacheVerdict {
  return { kind, hit, reason: hit ? "hit" : "no-entry", fingerprintMatch: hit };
}

// ───────────────────────── fingerprint ─────────────────────────

describe("four-track fingerprint", () => {
  const input = { task: "Fix   AXIS ", project, context, environment };

  it("is deterministic: identical inputs → identical output", () => {
    expect(buildTaskFingerprint(input)).toEqual(buildTaskFingerprint(input));
  });

  it("derives reuseKey from the four joined hashes, each 16 hex chars", () => {
    const fp = buildTaskFingerprint(input);
    expect(fp.reuseKey).toBe(
      [fp.semanticTaskHash, fp.projectStateHash, fp.contextStateHash, fp.environmentStateHash].join("|")
    );
    expect(fp.semanticTaskHash).toMatch(/^[0-9a-f]{16}$/);
    expect(fp.projectStateHash).toMatch(/^[0-9a-f]{16}$/);
    expect(fp.contextStateHash).toMatch(/^[0-9a-f]{16}$/);
    expect(fp.environmentStateHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("normalizes task semantics: 'Fix   AXIS ' ≡ 'fix axis'", () => {
    expect(normalizeSemanticTask("Fix   AXIS ")).toBe("fix axis");
    const messy = buildTaskFingerprint({ ...input, task: "Fix   AXIS " });
    const clean = buildTaskFingerprint({ ...input, task: "fix axis" });
    expect(messy.semanticTaskHash).toBe(clean.semanticTaskHash);
    expect(messy.reuseKey).toBe(clean.reuseKey);
  });

  it("isolates tracks: a gitHead change moves ONLY projectStateHash", () => {
    const before = buildTaskFingerprint(input);
    const after = buildTaskFingerprint({
      ...input,
      project: { ...project, gitHead: "ffffffffffffffffffffffffffffffffffffffff" },
    });
    expect(after.projectStateHash).not.toBe(before.projectStateHash);
    expect(after.semanticTaskHash).toBe(before.semanticTaskHash);
    expect(after.contextStateHash).toBe(before.contextStateHash);
    expect(after.environmentStateHash).toBe(before.environmentStateHash);
    expect(after.reuseKey).not.toBe(before.reuseKey);
  });

  it("isolates tracks: a tool-version change moves ONLY environmentStateHash", () => {
    const before = buildTaskFingerprint(input);
    const after = buildTaskFingerprint({
      ...input,
      environment: { ...environment, toolVersions: { ...environment.toolVersions, git: "2.44.0" } },
    });
    expect(after.environmentStateHash).not.toBe(before.environmentStateHash);
    expect(after.semanticTaskHash).toBe(before.semanticTaskHash);
    expect(after.projectStateHash).toBe(before.projectStateHash);
    expect(after.contextStateHash).toBe(before.contextStateHash);
  });

  it("canonicalizes record key order: file/tool maps hash independent of insertion order", () => {
    const before = buildTaskFingerprint(input);
    const after = buildTaskFingerprint({
      ...input,
      project: {
        ...project,
        relevantFileHashes: { "package-lock.json": "h-lock", "src/axis.ts": "h-axis" },
      },
      environment: {
        ...environment,
        toolVersions: { git: "2.43.0", node: "20.11.0" },
      },
    });
    expect(after.projectStateHash).toBe(before.projectStateHash);
    expect(after.environmentStateHash).toBe(before.environmentStateHash);
    expect(after).toEqual(before);
  });
});

// ───────────────────────── context cache ─────────────────────────

describe("context cache (ttl + fingerprint validation)", () => {
  const TTL = 60_000;
  const fp = buildTaskFingerprint({ task: "fix axis", project, context, environment });

  it("misses with 'no-entry' on an empty store", () => {
    const cache = createContextCache(memoryStore(), { ttlMs: TTL });
    const result = cache.get(fp, 1_000);
    expect(result.verdict).toEqual({
      kind: "context",
      hit: false,
      reason: "no-entry",
      fingerprintMatch: false,
    });
    expect("payload" in result).toBe(false);
  });

  it("hits within ttl and replays the payload; age == ttl is still a hit", () => {
    const cache = createContextCache(memoryStore(), { ttlMs: TTL });
    cache.put(fp, { anchors: ["symbol:src/axis.ts"] }, 1_000);
    const atBoundary = cache.get(fp, 1_000 + TTL);
    expect(atBoundary.verdict.hit).toBe(true);
    expect(atBoundary.verdict.reason).toBe("hit");
    expect(atBoundary.verdict.fingerprintMatch).toBe(true);
    expect(atBoundary.verdict.entryAgeMs).toBe(TTL);
    expect(atBoundary.payload).toEqual({ anchors: ["symbol:src/axis.ts"] });
  });

  it("misses with 'ttl-expired' past the ttl (fingerprint still matched)", () => {
    const cache = createContextCache(memoryStore(), { ttlMs: TTL });
    cache.put(fp, "ctx", 1_000);
    const result = cache.get(fp, 1_000 + TTL + 1);
    expect(result.verdict.hit).toBe(false);
    expect(result.verdict.reason).toBe("ttl-expired");
    expect(result.verdict.fingerprintMatch).toBe(true);
    expect(result.verdict.entryAgeMs).toBe(TTL + 1);
    expect("payload" in result).toBe(false);
  });

  it("misses with 'fingerprint-mismatch' when any state track changed", () => {
    const cache = createContextCache(memoryStore(), { ttlMs: TTL });
    cache.put(fp, "ctx", 1_000);
    const drifted = buildTaskFingerprint({
      task: "fix axis",
      project: { ...project, gitHead: "ffffffffffffffffffffffffffffffffffffffff" },
      context,
      environment,
    });
    const result = cache.get(drifted, 2_000);
    expect(result.verdict.hit).toBe(false);
    expect(result.verdict.reason).toBe("fingerprint-mismatch");
    expect(result.verdict.fingerprintMatch).toBe(false);
    expect("payload" in result).toBe(false);
  });
});

// ───────────────────────── plan cache ─────────────────────────

describe("plan cache (state validation before a hit)", () => {
  const fp = buildTaskFingerprint({ task: "fix axis", project, context, environment });

  it("hits when the full fingerprint is unchanged", () => {
    const cache = createPlanCache(memoryStore());
    cache.put(fp, { steps: ["repro", "patch", "verify"] }, 1_000);
    const result = cache.get(fp, 999_999);
    expect(result.verdict.hit).toBe(true);
    expect(result.verdict.reason).toBe("hit");
    expect(result.payload).toEqual({ steps: ["repro", "patch", "verify"] });
  });

  it("misses with 'project-state-changed' when only gitHead moved", () => {
    const cache = createPlanCache(memoryStore());
    cache.put(fp, "plan", 1_000);
    const drifted = buildTaskFingerprint({
      task: "fix axis",
      project: { ...project, gitHead: "ffffffffffffffffffffffffffffffffffffffff" },
      context,
      environment,
    });
    const result = cache.get(drifted, 2_000);
    expect(result.verdict.hit).toBe(false);
    expect(result.verdict.reason).toBe("project-state-changed");
    expect(result.verdict.fingerprintMatch).toBe(false);
  });

  it("keeps 'fingerprint-mismatch' for non-project drift (context policy bump)", () => {
    const cache = createPlanCache(memoryStore());
    cache.put(fp, "plan", 1_000);
    const drifted = buildTaskFingerprint({
      task: "fix axis",
      project,
      context: { ...context, contextPolicyVersion: "cp-2" },
      environment,
    });
    const result = cache.get(drifted, 2_000);
    expect(result.verdict.hit).toBe(false);
    expect(result.verdict.reason).toBe("fingerprint-mismatch");
  });
});

// ───────────────────────── result cache ─────────────────────────

describe("result cache (result-safe categories only)", () => {
  const fp = buildTaskFingerprint({ task: "list axis configs", project, context, environment });

  it("refuses to store non-result-safe categories (bugfix) — write results can never replay", () => {
    const cache = createResultCache(memoryStore());
    const verdict = cache.put(fp, "bugfix", "patched!", 1_000);
    expect(verdict).toEqual({
      kind: "result",
      hit: false,
      reason: "category-not-result-safe",
      fingerprintMatch: false,
    });
    // And the defensive read side agrees: nothing was stored.
    expect(cache.get(fp, "bugfix", 2_000).verdict.reason).toBe("category-not-result-safe");
  });

  it("stores and replays a 'query' result on full reuseKey equality", () => {
    const cache = createResultCache(memoryStore());
    const putVerdict = cache.put(fp, "query", { answer: "AXIS-3" }, 1_000);
    expect(putVerdict).toEqual({
      kind: "result",
      hit: true,
      reason: "stored",
      fingerprintMatch: true,
    });
    const result = cache.get(fp, "query", 999_999);
    expect(result.verdict.hit).toBe(true);
    expect(result.verdict.reason).toBe("hit");
    expect(result.payload).toEqual({ answer: "AXIS-3" });
  });

  it("scopes entries per category and refuses replay on fingerprint drift", () => {
    const cache = createResultCache(memoryStore());
    cache.put(fp, "query", "q-answer", 1_000);
    expect(cache.get(fp, "docs", 2_000).verdict.reason).toBe("no-entry");

    const drifted = buildTaskFingerprint({
      task: "list axis configs",
      project: { ...project, workingTreeHash: "wt-2" },
      context,
      environment,
    });
    const result = cache.get(drifted, "query", 2_000);
    expect(result.verdict.hit).toBe(false);
    expect(result.verdict.reason).toBe("fingerprint-mismatch");
    expect("payload" in result).toBe(false);
  });
});

// ───────────────────────── reuse gate ─────────────────────────

describe("decideReuse conservative ladder", () => {
  it("REUSE (0.75) only for a result hit on a result-safe category", () => {
    for (const category of ["query", "docs", "config"]) {
      const decision = decideReuse({
        verdicts: [verdictOf("result", true), verdictOf("context", true), verdictOf("plan", true)],
        category,
      });
      expect(decision.reuseMode).toBe("REUSE");
      expect(decision.confidence).toBe(0.75);
      expect(decision.rationale).toHaveLength(1);
    }
  });

  it("defensively refuses REUSE for a non-safe category even when the result verdict says hit", () => {
    const decision = decideReuse({
      verdicts: [verdictOf("result", true), verdictOf("context", true), verdictOf("plan", true)],
      category: "bugfix",
    });
    expect(decision.reuseMode).not.toBe("REUSE");
    // Falls through to the strongest remaining rung: both supporting caches hit.
    expect(decision.reuseMode).toBe("ADAPT");
    expect(decision.confidence).toBe(0.65);
    expect(decision.rationale.join(" ")).toContain("not result-safe → REUSE refused");
  });

  it("ADAPT (0.65) when context AND plan both hit", () => {
    const decision = decideReuse({
      verdicts: [verdictOf("context", true), verdictOf("plan", true)],
      category: "bugfix",
    });
    expect(decision.reuseMode).toBe("ADAPT");
    expect(decision.confidence).toBe(0.65);
  });

  it("ADAPT (0.55) when exactly one of context/plan hits", () => {
    const contextOnly = decideReuse({
      verdicts: [verdictOf("context", true), verdictOf("plan", false)],
      category: "bugfix",
    });
    expect(contextOnly.reuseMode).toBe("ADAPT");
    expect(contextOnly.confidence).toBe(0.55);

    const planOnly = decideReuse({
      verdicts: [verdictOf("context", false), verdictOf("plan", true)],
      category: "query",
    });
    expect(planOnly.reuseMode).toBe("ADAPT");
    expect(planOnly.confidence).toBe(0.55);
    expect(planOnly.rationale.join(" ")).toContain("plan cache hit");
  });

  it("FRESH (0.5) when nothing hits (or no verdicts at all)", () => {
    const none = decideReuse({
      verdicts: [verdictOf("context", false), verdictOf("plan", false), verdictOf("result", false)],
      category: "query",
    });
    expect(none.reuseMode).toBe("FRESH");
    expect(none.confidence).toBe(0.5);

    const empty = decideReuse({ verdicts: [], category: "bugfix" });
    expect(empty.reuseMode).toBe("FRESH");
    expect(empty.confidence).toBe(0.5);
  });

  it("passes the verdicts through untouched", () => {
    const verdicts = [verdictOf("context", true), verdictOf("plan", false)];
    const decision = decideReuse({ verdicts, category: "bugfix" });
    expect(decision.verdicts).toBe(verdicts);
  });
});

// ───────────────────────── end-to-end smoke ─────────────────────────

describe("reuse engine end-to-end (fingerprint → caches → gate)", () => {
  it("a state drift downgrades REUSE to a state-validated miss chain", () => {
    const store = memoryStore();
    const contextCache = createContextCache(store, { ttlMs: 60_000 });
    const planCache = createPlanCache(store);
    const resultCache = createResultCache(store);
    const at = 1_000;

    const fp = buildTaskFingerprint({ task: "count  axis   tests", project, context, environment });
    contextCache.put(fp, "ctx", at);
    planCache.put(fp, "plan", at);
    resultCache.put(fp, "query", 42, at);

    const clean = decideReuse({
      verdicts: [
        contextCache.get(fp, at + 1).verdict,
        planCache.get(fp, at + 1).verdict,
        resultCache.get(fp, "query", at + 1).verdict,
      ],
      category: "query",
    });
    expect(clean.reuseMode).toBe("REUSE");

    // Same task semantics, changed working tree: every cache must refuse.
    const drifted = buildTaskFingerprint({
      task: "count axis tests",
      project: { ...project, workingTreeHash: "wt-dirty" },
      context,
      environment,
    });
    const dirty = decideReuse({
      verdicts: [
        contextCache.get(drifted, at + 1).verdict,
        planCache.get(drifted, at + 1).verdict,
        resultCache.get(drifted, "query", at + 1).verdict,
      ],
      category: "query",
    });
    expect(dirty.reuseMode).toBe("FRESH");
  });
});
