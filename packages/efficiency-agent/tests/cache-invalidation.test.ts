import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_TTL_MS,
  RESULT_TTL_MS,
  runEfficiencyPipeline,
  type PipelineInput,
  type PipelineResult,
} from "../src/agent/pipeline.js";
import { createDefaultSecurity } from "../src/agent/security-default.js";
import { invalidateCaches } from "../src/caches/namespace.js";
import { createResultCache, DEFAULT_RESULT_TTL_MS } from "../src/caches/result-cache.js";
import type { CacheVerdict, PolicyUpdate } from "../src/domain.js";
import { buildTaskFingerprint } from "../src/fingerprint.js";
import { DEFAULT_FLAGS, type EffFlags } from "../src/flags.js";
import { createPolicyStore } from "../src/learning/policy-store.js";
import { CACHE_SCHEMA_VERSION } from "../src/version.js";
import type { AgentExecutorSpec } from "../src/workers/agent-task-worker.js";
import { fakeFacts, fixtureDeps, memoryKv, scratchWorkspace, type FixtureDeps } from "./helpers/pipeline-fixtures.js";

const ADAPTIVE_REUSE: EffFlags = {
  ...DEFAULT_FLAGS,
  EFF_AGENT_ENABLED: true,
  EFF_SHADOW_MODE: false,
  EFF_PLAN_REUSE: true,
  EFF_RESULT_REUSE: true,
};
// Each case spawns several node processes; generous under a loaded machine.
const SPAWN_TIMEOUT = 90_000;
const TASK = "where is main defined?";

const quote = (p: string): string => `"${p}"`;
const executor = (agentScript: string, command = process.execPath): AgentExecutorSpec => ({
  command,
  args: [agentScript],
  promptVia: "stdin",
  timeoutMs: 30_000,
});

type OnFinished = (fn: () => void) => void;

interface Harness {
  deps: FixtureDeps;
  run(overrides?: Partial<PipelineInput>): Promise<PipelineResult>;
}

/** A scratch workspace + shared stores; the first (warming) run must complete and cache a result. */
async function warmed(onFinished: OnFinished): Promise<Harness & { first: PipelineResult; agentScript: string }> {
  const ws = scratchWorkspace();
  onFinished(ws.dispose);
  const deps = fixtureDeps(ws.dir);
  const run = (overrides: Partial<PipelineInput> = {}) =>
    runEfficiencyPipeline(
      {
        task: TASK,
        root: ws.dir,
        mode: "broker",
        policy: "adaptive",
        category: "query",
        validation: [`${quote(process.execPath)} ${quote(join(ws.dir, "pass.cjs"))}`],
        executor: executor(ws.agentScript),
        flags: ADAPTIVE_REUSE,
        ...overrides,
      },
      deps
    );
  const first = await run();
  expect(first.status).toBe("completed");
  expect(first.events.some((e) => e.stage === "learn" && e.outcome === "result-cached")).toBe(true);
  return { deps, run, first, agentScript: ws.agentScript };
}

const verdict = (r: PipelineResult, kind: CacheVerdict["kind"]): CacheVerdict | undefined =>
  r.verdicts.find((v) => v.kind === kind);

function expectAllMiss(r: PipelineResult, reasons: { context: string; plan: string; result: string }): void {
  expect(r.verdicts).toHaveLength(3);
  expect(verdict(r, "context")).toMatchObject({ hit: false, reason: reasons.context });
  expect(verdict(r, "plan")).toMatchObject({ hit: false, reason: reasons.plan });
  expect(verdict(r, "result")).toMatchObject({ hit: false, reason: reasons.result });
  expect(r.rawDecision.reuseMode).toBe("FRESH");
  expect(r.appliedDecision.reuseMode).toBe("FRESH");
  expect(r.status).not.toBe("reused");
}

const STATE_CHANGED = { context: "fingerprint-mismatch", plan: "project-state-changed", result: "fingerprint-mismatch" };
const NON_PROJECT_CHANGED = { context: "fingerprint-mismatch", plan: "fingerprint-mismatch", result: "fingerprint-mismatch" };

describe.concurrent("cache invalidation (spec section 4)", () => {
  it(
    "control: an unchanged rerun hits every cache and replays the result",
    async ({ onTestFinished }) => {
      const h = await warmed(onTestFinished);
      const r = await h.run();
      expect(r.verdicts.every((v) => v.hit)).toBe(true);
      expect(r.appliedDecision.reuseMode).toBe("REUSE");
      expect(r.status).toBe("reused");
      expect(r.execution?.agentInvocations).toBe(0);
    },
    SPAWN_TIMEOUT
  );

  it(
    "control: whitespace/case-only differences normalise to the same semantic task",
    async ({ onTestFinished }) => {
      const h = await warmed(onTestFinished);
      const r = await h.run({ task: "  Where is   MAIN defined?  " });
      expect(r.fingerprint.semanticTaskHash).toBe(h.first.fingerprint.semanticTaskHash);
      expect(r.appliedDecision.reuseMode).toBe("REUSE");
    },
    SPAWN_TIMEOUT
  );

  it(
    "gitHead change invalidates context, plan and result",
    async ({ onTestFinished }) => {
      const h = await warmed(onTestFinished);
      h.deps.collectFacts = (root) => fakeFacts(root, { gitHead: "b".repeat(40) });
      const r = await h.run();
      expect(r.fingerprint.projectStateHash).not.toBe(h.first.fingerprint.projectStateHash);
      expectAllMiss(r, STATE_CHANGED);
    },
    SPAWN_TIMEOUT
  );

  it(
    "a relevant file hash change invalidates context, plan and result",
    async ({ onTestFinished }) => {
      const h = await warmed(onTestFinished);
      h.deps.collectFacts = (root) => fakeFacts(root, { fileHash: "h2-edited" });
      const r = await h.run();
      expectAllMiss(r, STATE_CHANGED);
    },
    SPAWN_TIMEOUT
  );

  it(
    "graphVersion change invalidates context, plan and result",
    async ({ onTestFinished }) => {
      const h = await warmed(onTestFinished);
      h.deps.graphVersion = () => "graph:2";
      const r = await h.run();
      expect(r.fingerprint.projectStateHash).toBe(h.first.fingerprint.projectStateHash);
      expect(r.fingerprint.contextStateHash).not.toBe(h.first.fingerprint.contextStateHash);
      expectAllMiss(r, NON_PROJECT_CHANGED);
    },
    SPAWN_TIMEOUT
  );

  it(
    "a new learned policy version invalidates context, plan and result",
    async ({ onTestFinished }) => {
      const h = await warmed(onTestFinished);
      const update: PolicyUpdate = {
        version: 1,
        minSamples: 5,
        modelTierByCategory: {},
        executionModeByCategory: {},
        avoidPatterns: [],
        rationale: ["test: bump policy version"],
      };
      createPolicyStore(h.deps.policyKv).apply(update);
      const r = await h.run();
      expect(r.record.policyVersion).toBe(1);
      expect(r.fingerprint.contextStateHash).not.toBe(h.first.fingerprint.contextStateHash);
      expectAllMiss(r, NON_PROJECT_CHANGED);
    },
    SPAWN_TIMEOUT
  );

  it(
    "a security policy version change invalidates context, plan and result",
    async ({ onTestFinished }) => {
      const h = await warmed(onTestFinished);
      expect(h.first.record.securityPolicyVersion).toBe("security-v1");
      h.deps.security = { ...createDefaultSecurity(), policyVersion: "security-v1-rotated" };
      const r = await h.run();
      expect(r.record.securityPolicyVersion).toBe("security-v1-rotated");
      expectAllMiss(r, NON_PROJECT_CHANGED);
    },
    SPAWN_TIMEOUT
  );

  it(
    "an executor command change invalidates context, plan and result",
    async ({ onTestFinished }) => {
      const h = await warmed(onTestFinished);
      expect(h.first.contract.worker.provider).toBe(process.execPath);
      // Same agent script, launched through `node` on PATH instead of the absolute execPath.
      const r = await h.run({ executor: executor(h.agentScript, "node") });
      expect(r.fingerprint.environmentStateHash).not.toBe(h.first.fingerprint.environmentStateHash);
      expectAllMiss(r, NON_PROJECT_CHANGED);
    },
    SPAWN_TIMEOUT
  );

  it(
    "invalidateCaches bumps the namespace so the next run misses everything",
    async ({ onTestFinished }) => {
      const h = await warmed(onTestFinished);
      expect(h.first.record.cacheNamespace).toBe(`${CACHE_SCHEMA_VERSION}.g0`);
      const bumped = invalidateCaches(h.deps.cacheStore);
      expect(bumped).toEqual({ previous: `${CACHE_SCHEMA_VERSION}.g0`, current: `${CACHE_SCHEMA_VERSION}.g1` });
      const r = await h.run();
      expect(r.record.cacheNamespace).toBe(`${CACHE_SCHEMA_VERSION}.g1`);
      expect(r.fingerprint.reuseKey).toBe(h.first.fingerprint.reuseKey);
      expectAllMiss(r, { context: "no-entry", plan: "no-entry", result: "no-entry" });
    },
    SPAWN_TIMEOUT
  );

  it(
    "a similar but different task text never REUSEs (semantic hash differs)",
    async ({ onTestFinished }) => {
      const h = await warmed(onTestFinished);
      const r = await h.run({ task: "where is main declared?" });
      expect(r.fingerprint.semanticTaskHash).not.toBe(h.first.fingerprint.semanticTaskHash);
      // Experience search still finds the near-duplicate, but that is never cache evidence.
      expect(r.experience.similar.length).toBeGreaterThan(0);
      expectAllMiss(r, { context: "no-entry", plan: "no-entry", result: "no-entry" });
    },
    SPAWN_TIMEOUT
  );

  it(
    "context entries older than the 24h TTL miss with ttl-expired",
    async ({ onTestFinished }) => {
      const h = await warmed(onTestFinished);
      const dayAndAnHour = 25 * 60 * 60_000;
      h.deps.now = () => Date.now() + dayAndAnHour;
      const r = await h.run();
      expect(verdict(r, "context")).toMatchObject({ hit: false, reason: "ttl-expired", fingerprintMatch: true });
    },
    SPAWN_TIMEOUT
  );

  it(
    "result entries older than the 6h result TTL miss with ttl-expired; context/plan still adapt",
    async ({ onTestFinished }) => {
      const h = await warmed(onTestFinished);
      const sevenHours = 7 * 60 * 60_000;
      expect(sevenHours).toBeGreaterThan(RESULT_TTL_MS);
      expect(sevenHours).toBeLessThan(CONTEXT_TTL_MS);
      h.deps.now = () => Date.now() + sevenHours;
      const r = await h.run();
      expect(verdict(r, "result")).toMatchObject({ hit: false, reason: "ttl-expired", fingerprintMatch: true });
      expect(verdict(r, "result")?.entryAgeMs).toBeGreaterThan(RESULT_TTL_MS);
      expect(verdict(r, "context")).toMatchObject({ hit: true, reason: "hit" });
      expect(verdict(r, "plan")).toMatchObject({ hit: true, reason: "hit" });
      expect(r.appliedDecision.reuseMode).toBe("ADAPT");
      expect(r.status).toBe("completed");
      expect(r.execution?.agentInvocations).toBe(1);
    },
    SPAWN_TIMEOUT
  );

  it(
    "deps.cacheTtlMs overrides each TTL independently",
    async ({ onTestFinished }) => {
      const h = await warmed(onTestFinished);
      // A longer result TTL keeps replaying after the context entry expired.
      h.deps.cacheTtlMs = { result: 48 * 60 * 60_000 };
      h.deps.now = () => Date.now() + 25 * 60 * 60_000;
      const replay = await h.run();
      expect(verdict(replay, "context")).toMatchObject({ hit: false, reason: "ttl-expired" });
      expect(verdict(replay, "result")).toMatchObject({ hit: true, reason: "hit" });
      expect(replay.status).toBe("reused");

      // Tiny TTLs: the context entry refreshed at +25h and the result stored
      // by the first run are both older than 1s an hour later.
      h.deps.cacheTtlMs = { context: 1_000, result: 1_000 };
      h.deps.now = () => Date.now() + 26 * 60 * 60_000;
      const expired = await h.run();
      expect(verdict(expired, "context")).toMatchObject({ hit: false, reason: "ttl-expired" });
      expect(verdict(expired, "result")).toMatchObject({ hit: false, reason: "ttl-expired" });
      expect(expired.status).not.toBe("reused");
    },
    SPAWN_TIMEOUT
  );
});

describe("result cache TTL (unit, injected clock)", () => {
  const fp = buildTaskFingerprint({
    task: TASK,
    project: { gitHead: "a".repeat(40), relevantFileHashes: { "src/index.ts": "h1" } },
    context: { contextPolicyVersion: "cp-1" },
    environment: { toolVersions: {}, runtimeVersion: "v0", selectedProvider: "none" },
  });

  it("hits at exactly ttlMs and misses one millisecond later without a payload", () => {
    const cache = createResultCache(memoryKv(), { ttlMs: 60_000 });
    cache.put(fp, "query", { output: "main is in src/index.ts" }, 1_000);
    const atBoundary = cache.get(fp, "query", 61_000);
    expect(atBoundary.verdict).toMatchObject({ hit: true, reason: "hit", entryAgeMs: 60_000 });
    expect(atBoundary.payload).toEqual({ output: "main is in src/index.ts" });
    const expired = cache.get(fp, "query", 61_001);
    expect(expired.verdict).toEqual({
      kind: "result",
      hit: false,
      reason: "ttl-expired",
      fingerprintMatch: true,
      entryAgeMs: 60_001,
    });
    expect("payload" in expired).toBe(false);
  });

  it("defaults to DEFAULT_RESULT_TTL_MS (6h), shorter than the 24h context TTL", () => {
    expect(DEFAULT_RESULT_TTL_MS).toBe(6 * 60 * 60_000);
    expect(RESULT_TTL_MS).toBe(DEFAULT_RESULT_TTL_MS);
    expect(DEFAULT_RESULT_TTL_MS).toBeLessThan(CONTEXT_TTL_MS);
    const cache = createResultCache(memoryKv());
    cache.put(fp, "docs", "answer", 0);
    expect(cache.get(fp, "docs", DEFAULT_RESULT_TTL_MS).verdict.hit).toBe(true);
    expect(cache.get(fp, "docs", DEFAULT_RESULT_TTL_MS + 1).verdict.reason).toBe("ttl-expired");
  });

  it("a fingerprint mismatch is reported before the TTL (same order as the context cache)", () => {
    const cache = createResultCache(memoryKv(), { ttlMs: 10 });
    cache.put(fp, "query", "answer", 0);
    const drifted = buildTaskFingerprint({
      task: TASK,
      project: { gitHead: "b".repeat(40), relevantFileHashes: { "src/index.ts": "h1" } },
      context: { contextPolicyVersion: "cp-1" },
      environment: { toolVersions: {}, runtimeVersion: "v0", selectedProvider: "none" },
    });
    expect(cache.get(drifted, "query", 1_000).verdict.reason).toBe("fingerprint-mismatch");
  });
});
