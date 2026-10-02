import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { runEfficiencyPipeline, type PipelineInput } from "../src/agent/pipeline.js";
import { createContextCache } from "../src/caches/context-cache.js";
import { cacheNamespace, namespacedStore } from "../src/caches/namespace.js";
import { createPlanCache } from "../src/caches/plan-cache.js";
import { createResultCache } from "../src/caches/result-cache.js";
import type { ProjectStateFacts } from "../src/domain.js";
import { buildTaskFingerprint } from "../src/fingerprint.js";
import { DEFAULT_FLAGS } from "../src/flags.js";
import { collectProjectFacts } from "../src/host/project-facts.js";
import { fixtureDeps, memoryKv, scratchWorkspace } from "./helpers/pipeline-fixtures.js";

/** Nearest-rank percentile. */
function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1]!;
}

const fmt = (ms: number): string => ms.toFixed(3);

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

describe("perf budget (spec section 10)", () => {
  it("fingerprint + context/plan/result cache lookup on a warm 500-entry store: P95 < 100ms", () => {
    const kv = memoryKv();
    const store = namespacedStore(kv, cacheNamespace(kv));
    const contextCache = createContextCache(store, { ttlMs: 24 * 60 * 60_000 });
    const planCache = createPlanCache(store);
    const resultCache = createResultCache(store);
    const project = (i: number): ProjectStateFacts => ({
      gitHead: "a".repeat(40),
      workingTreeHash: "wt",
      relevantFileHashes: { "src/index.ts": "h1", [`src/mod${i % 50}.ts`]: `h${i}` },
      dependencyLockHash: "package-lock.json:abc",
    });
    const fingerprintFor = (i: number) =>
      buildTaskFingerprint({
        task: `where is handler number ${i} registered?`,
        project: project(i),
        context: { graphVersion: "graph:1", contextPolicyVersion: "ctx-1+policy:0+sec:security-v1", workingSetHash: "ws" },
        environment: {
          toolVersions: { node: process.version, "eff-agent": "0.1.0", "security-policy": "security-v1" },
          runtimeVersion: process.version,
          selectedProvider: "claude",
        },
      });
    const now = Date.now();
    for (let i = 0; i < 500; i += 1) {
      const fp = fingerprintFor(i);
      const payload = { summary: [`entry ${i}`], anchors: [{ id: `file:src/mod${i}.ts`, relevance: 0.5 }] };
      contextCache.put(fp, payload, now);
      planCache.put(fp, { relevantFiles: [`src/mod${i}.ts`], validation: ["npm test"] }, now);
      resultCache.put(fp, "query", { output: `answer ${i}`.repeat(20) }, now);
    }
    // 500 entries x 3 caches.
    expect(Object.keys(kv.data).length).toBeGreaterThanOrEqual(1500);

    const samples: number[] = [];
    let hits = 0;
    for (let iter = 0; iter < 200; iter += 1) {
      const i = (iter * 7) % 500;
      const t0 = performance.now();
      const fp = fingerprintFor(i);
      const c = contextCache.get(fp, now + 1);
      const p = planCache.get(fp, now + 1);
      const r = resultCache.get(fp, "query", now + 1);
      samples.push(performance.now() - t0);
      if (c.verdict.hit && p.verdict.hit && r.verdict.hit) hits += 1;
    }
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    console.log(`[perf] fingerprint+3 cache lookups (200 iters, 500 warm entries): P50=${fmt(p50)}ms P95=${fmt(p95)}ms max=${fmt(Math.max(...samples))}ms`);
    expect(hits).toBe(200);
    expect(p95).toBeLessThan(100);
  });

  it("full advisory decision path without GraphFlow: P50 < 1500ms over 20 runs", async () => {
    const ws = scratchWorkspace();
    disposers.push(ws.dispose);
    const deps = fixtureDeps(ws.dir);
    delete deps.fetchContext;
    const input: PipelineInput = {
      task: "fix the crash in src/index.ts when main gets no args",
      root: ws.dir,
      mode: "advisory",
      policy: "adaptive",
      validation: [`"${process.execPath}" "${join(ws.dir, "pass.cjs")}"`],
      executor: { command: process.execPath, args: [ws.agentScript], promptVia: "stdin", timeoutMs: 30_000 },
      flags: { ...DEFAULT_FLAGS, EFF_AGENT_ENABLED: true, EFF_SHADOW_MODE: false, EFF_PLAN_REUSE: true, EFF_RESULT_REUSE: true },
    };
    const samples: number[] = [];
    const decisionMs: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      const r = await runEfficiencyPipeline(input, deps);
      samples.push(performance.now() - t0);
      decisionMs.push(r.contract.decision?.durationMs ?? Number.NaN);
      expect(r.status).toBe("advisory-only");
      expect(r.context.source).toBe("twin-only");
      expect(r.contract.decision?.llmCalls).toBe(0);
    }
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    console.log(
      `[perf] advisory decision path, fixture facts, no GraphFlow (20 runs): P50=${fmt(p50)}ms P95=${fmt(p95)}ms ` +
        `contract.decision.durationMs P50=${percentile(decisionMs, 0.5)}ms`
    );
    expect(p50).toBeLessThan(1500);
  });

  // Informational: real git subprocesses dominate here and vary with machine load, so the bound is a sanity cap.
  it("advisory decision path with real project facts (git) on this package: reported, P50 < 5000ms", async () => {
    const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const deps = fixtureDeps(pkgRoot, {
      collectFacts: (root, task) => collectProjectFacts(root, task),
    });
    delete deps.fetchContext;
    const input: PipelineInput = {
      task: "where is the reuse gate decision made?",
      root: pkgRoot,
      mode: "advisory",
      policy: "conservative",
      validation: [],
    };
    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      const r = await runEfficiencyPipeline(input, deps);
      samples.push(performance.now() - t0);
      expect(r.status).toBe("advisory-only");
      expect(r.twin.fileCount).toBeGreaterThan(0);
    }
    const p50 = percentile(samples, 0.5);
    console.log(`[perf] advisory decision path, real git facts (5 runs): P50=${fmt(p50)}ms max=${fmt(Math.max(...samples))}ms`);
    expect(p50).toBeLessThan(5000);
  }, 60_000);
});
