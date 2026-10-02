import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEfficiencyPipeline, runPipelineFailOpen, type PipelineInput } from "../src/agent/pipeline.js";
import type { PipelineSecurity } from "../src/agent/security-adapter.js";
import { createDefaultSecurity } from "../src/agent/security-default.js";
import type { KVStore } from "../src/caches/context-cache.js";
import { buildTaskFingerprint } from "../src/fingerprint.js";
import { DEFAULT_FLAGS, type EffFlags } from "../src/flags.js";
import { CACHE_SCHEMA_VERSION } from "../src/version.js";
import type { AgentExecutorSpec } from "../src/workers/agent-task-worker.js";
import { fakeFacts, fixtureDeps, memoryKv, scratchWorkspace } from "./helpers/pipeline-fixtures.js";

const ACTING: EffFlags = { ...DEFAULT_FLAGS, EFF_AGENT_ENABLED: true, EFF_SHADOW_MODE: false };
const ALL_REUSE: EffFlags = { ...ACTING, EFF_PLAN_REUSE: true, EFF_RESULT_REUSE: true };
const SPAWN_TIMEOUT = 30_000;

const quote = (p: string): string => `"${p}"`;
const nodeRun = (dir: string, script: string): string => `${quote(process.execPath)} ${quote(join(dir, script))}`;
const executor = (agentScript: string, timeoutMs = 30_000): AgentExecutorSpec => ({
  command: process.execPath,
  args: [agentScript],
  promptVia: "stdin",
  timeoutMs,
});

type OnFinished = (fn: () => void) => void;

/** Tests run concurrently, so each scratch dir is removed when its own test finishes. */
function workspace(onFinished: OnFinished, agentBody?: string) {
  const ws = scratchWorkspace(agentBody);
  onFinished(ws.dispose);
  return ws;
}

function input(ws: { dir: string; agentScript: string }, overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    task: "add a helper to src/util.ts",
    root: ws.dir,
    mode: "broker",
    policy: "conservative",
    validation: [nodeRun(ws.dir, "pass.cjs")],
    executor: executor(ws.agentScript),
    flags: ACTING,
    ...overrides,
  };
}

describe.concurrent("chaos: GraphFlow context failures fail open", () => {
  it(
    "fetchContext throws -> twin-only context, the run still completes",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir, {
        fetchContext: async () => {
          throw new Error("mcp transport closed");
        },
      });
      const r = await runEfficiencyPipeline(input(ws), deps);
      expect(r.context.source).toBe("twin-only");
      expect(r.context.error).toBe("mcp transport closed");
      expect(r.status).toBe("completed");
      expect(r.events.some((e) => e.stage === "fail-open" && e.outcome === "twin-only")).toBe(true);
    },
    SPAWN_TIMEOUT
  );

  it(
    "fetchContext returns ok:false -> twin-only plus a fail-open event",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir, {
        fetchContext: async () => ({ ok: false, error: "graphflow unavailable", durationMs: 3 }),
      });
      const r = await runEfficiencyPipeline(input(ws), deps);
      expect(r.context.source).toBe("twin-only");
      const failOpen = r.events.filter((e) => e.stage === "fail-open");
      expect(failOpen.map((e) => e.outcome)).toContain("twin-only");
      expect(failOpen.find((e) => e.outcome === "twin-only")?.reason).toMatch(/graphflow unavailable/);
      expect(r.status).toBe("completed");
    },
    SPAWN_TIMEOUT
  );
});

describe.concurrent("chaos: cache and policy store failures", () => {
  it(
    "cacheStore.get throws -> 'cache store failed' warning, FRESH, still executes",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const broken: KVStore = {
        get: () => {
          throw new Error("cache disk gone");
        },
        set: () => undefined,
      };
      const deps = fixtureDeps(ws.dir, { cacheStore: broken });
      const r = await runEfficiencyPipeline(input(ws, { flags: ALL_REUSE, policy: "adaptive" }), deps);
      expect(r.warnings.some((w) => w.includes("cache store failed"))).toBe(true);
      expect(r.verdicts).toEqual([]);
      expect(r.rawDecision.reuseMode).toBe("FRESH");
      expect(r.appliedDecision.reuseMode).toBe("FRESH");
      expect(r.record.cacheNamespace).toBe("unavailable");
      expect(r.status).toBe("completed");
      expect(r.execution?.agentInvocations).toBe(1);
      expect(r.events.some((e) => e.stage === "fail-open" && e.outcome === "fresh")).toBe(true);
    },
    SPAWN_TIMEOUT
  );

  it(
    "cacheStore.set throws -> cache writes are skipped with warnings, the run completes",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const readOnlyStore: KVStore = {
        get: () => undefined,
        set: () => {
          throw new Error("read-only cache volume");
        },
      };
      const deps = fixtureDeps(ws.dir, { cacheStore: readOnlyStore });
      const r = await runEfficiencyPipeline(input(ws, { flags: ALL_REUSE, policy: "adaptive" }), deps);
      expect(r.status).toBe("completed");
      expect(r.warnings.some((w) => w.includes("context cache write failed"))).toBe(true);
      expect(r.warnings.some((w) => w.includes("cache write failed"))).toBe(true);
    },
    SPAWN_TIMEOUT
  );

  const task = "what does main return?";
  const semantic = buildTaskFingerprint({ task, project: { relevantFileHashes: {} } }).semanticTaskHash;
  const ns = `${CACHE_SCHEMA_VERSION}.g0::`;
  const garbage: Array<[string, string]> = [
    ["not JSON", "{{{ definitely not json"],
    ["JSON null", "null"],
    ["wrong shape", JSON.stringify({ version: "1.0", createdAt: "yesterday", fingerprint: 42 })],
    ["wrong version", JSON.stringify({ version: "9.9", createdAt: 1, fingerprint: { reuseKey: "x" }, payload: { output: "poison" } })],
  ];
  for (const [label, value] of garbage) {
    it(
      `corrupt cache entries (${label}) -> FRESH, no crash, no poisoned replay`,
      async ({ onTestFinished }) => {
        const ws = workspace(onTestFinished);
        const cacheStore = memoryKv({
          __eff_cache_generation: "not-a-number",
          [`${ns}context:${semantic}`]: value,
          [`${ns}plan:${semantic}`]: value,
          [`${ns}result:query:${semantic}`]: value,
        });
        const deps = fixtureDeps(ws.dir, { cacheStore });
        const r = await runEfficiencyPipeline(
          input(ws, { task, category: "query", policy: "adaptive", flags: ALL_REUSE }),
          deps
        );
        expect(r.record.cacheNamespace).toBe(`${CACHE_SCHEMA_VERSION}.g0`);
        expect(r.verdicts).toHaveLength(3);
        for (const verdict of r.verdicts) {
          expect(verdict.hit).toBe(false);
          expect(verdict.reason).toBe("no-entry");
        }
        expect(r.appliedDecision.reuseMode).toBe("FRESH");
        expect(r.status).toBe("completed");
        expect(r.execution?.output ?? "").not.toContain("poison");
      },
      SPAWN_TIMEOUT
    );
  }

  it(
    "policyKv with corrupt JSON -> deterministic defaults, no throw",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const policyKv = memoryKv({
        "policy-current": "{not json",
        "policy-history": "[oops",
        "policy-lifecycle": "%%%",
      });
      const deps = fixtureDeps(ws.dir, { policyKv });
      const r = await runEfficiencyPipeline(
        input(ws, { flags: { ...ACTING, EFF_SELF_LEARNING: true } }),
        deps
      );
      expect(r.status).toBe("completed");
      expect(r.record.policyVersion).toBe(0);
      expect(r.warnings.some((w) => w.includes("policy store unreadable"))).toBe(true);
      expect(r.events.some((e) => e.stage === "fail-open" && e.outcome === "policy-defaults")).toBe(true);
      expect(r.contract.policyApplied).toBeUndefined();
    },
    SPAWN_TIMEOUT
  );

  it(
    "experience.read throws -> searches without history and still completes",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const appended: unknown[] = [];
      const deps = fixtureDeps(ws.dir, {
        experience: {
          read: () => {
            throw new Error("experience file locked");
          },
          append: (r) => void appended.push(r),
        },
      });
      const r = await runEfficiencyPipeline(input(ws), deps);
      expect(r.status).toBe("completed");
      expect(r.warnings.some((w) => w.includes("experience store unreadable"))).toBe(true);
      expect(r.events.some((e) => e.stage === "fail-open" && e.outcome === "no-history")).toBe(true);
      expect(appended).toHaveLength(1);
    },
    SPAWN_TIMEOUT
  );

  it(
    "experience.append throws -> learning skipped with a 'no-learning' fail-open event",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir, {
        experience: {
          read: () => [],
          append: () => {
            throw new Error("disk full");
          },
        },
      });
      const r = await runEfficiencyPipeline(input(ws), deps);
      expect(r.status).toBe("completed");
      expect(r.warnings.some((w) => /learning skipped/.test(w))).toBe(true);
      expect(r.events.some((e) => e.stage === "fail-open" && e.outcome === "no-learning")).toBe(true);
      expect(r.reflections).toEqual([]);
    },
    SPAWN_TIMEOUT
  );

  it(
    "traceSink throws -> the result is still returned with a warning",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir, {
        traceSink: () => {
          throw new Error("trace dir not writable");
        },
      });
      const r = await runEfficiencyPipeline(input(ws), deps);
      expect(r.status).toBe("completed");
      expect(r.trace).toBeDefined();
      expect(r.warnings.some((w) => w.includes("trace sink failed"))).toBe(true);
    },
    SPAWN_TIMEOUT
  );
});

describe.concurrent("chaos: security fails closed", () => {
  it("a corrupt security policy file loads fail-closed (STRICT) with a -strict policy version", ({ onTestFinished }) => {
    const ws = workspace(onTestFinished);
    const corrupt = join(ws.dir, "policy-corrupt.json");
    writeFileSync(corrupt, "{ this is : not json");
    const invalid = join(ws.dir, "policy-invalid.json");
    writeFileSync(invalid, JSON.stringify({ version: 2 }));
    for (const policyFile of [corrupt, invalid]) {
      const sec = createDefaultSecurity({ policyFile });
      expect(sec.source).toBe("fail-closed");
      expect(sec.policyVersion.endsWith("-strict")).toBe(true);
      expect(sec.loadError).toBeDefined();
    }
    expect(createDefaultSecurity().source).toBe("default");
  });

  it(
    "pipeline with a fail-closed policy: R1 work runs, R2 is denied even when approved",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const policyFile = join(ws.dir, "policy.json");
      writeFileSync(policyFile, "<<corrupt>>");
      const security = createDefaultSecurity({ policyFile });

      const ok = await runEfficiencyPipeline(input(ws), fixtureDeps(ws.dir, { security }));
      expect(ok.status).toBe("completed");
      expect(ok.record.securityPolicyVersion).toBe(security.policyVersion);
      expect(ok.security.reasons.some((r) => r.startsWith("policy fail-closed"))).toBe(true);

      const r2 = await runEfficiencyPipeline(
        input(ws, { validation: ["git init -q"], approved: true }),
        fixtureDeps(ws.dir, { security })
      );
      expect(r2.status).toBe("blocked");
      expect(r2.security.verdict).toBe("deny");
      expect(r2.security.risk).toBe("R2");
      expect(r2.execution).toBeUndefined();
    },
    SPAWN_TIMEOUT
  );

  it("security.checkCommands throws -> blocked, fail-closed at R3", async ({ onTestFinished }) => {
    const ws = workspace(onTestFinished);
    const security: PipelineSecurity = {
      ...createDefaultSecurity(),
      checkCommands: () => {
        throw new Error("policy engine crashed");
      },
    };
    const deps = fixtureDeps(ws.dir, { security });
    const r = await runEfficiencyPipeline(input(ws), deps);
    expect(r.status).toBe("blocked");
    expect(r.security.verdict).toBe("deny");
    expect(r.security.risk).toBe("R3");
    expect(r.security.reasons.join(" ")).toMatch(/security evaluation failed: policy engine crashed/);
    expect(r.execution).toBeUndefined();
  });

  it("security.checkWorkerLaunch throws -> blocked, fail-closed at R3", async ({ onTestFinished }) => {
    const ws = workspace(onTestFinished);
    const security: PipelineSecurity = {
      ...createDefaultSecurity(),
      checkWorkerLaunch: () => {
        throw new Error("launch check crashed");
      },
    };
    const r = await runEfficiencyPipeline(input(ws), fixtureDeps(ws.dir, { security }));
    expect(r.status).toBe("blocked");
    expect(r.security.risk).toBe("R3");
  });
});

describe.concurrent("chaos: executor failures", () => {
  it(
    "a missing executor binary fails the run without throwing",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir);
      const r = await runEfficiencyPipeline(
        input(ws, { executor: { ...executor(ws.agentScript), command: "definitely-not-a-cmd-xyz" } }),
        deps
      );
      expect(r.status).toBe("failed");
      expect(r.execution?.validation.find((c) => c.name === "agent-exit-code")?.passed).toBe(false);
      expect(r.trace?.result.success).toBe(false);
    },
    SPAWN_TIMEOUT
  );

  it(
    "an executor that exceeds its timeout is killed and the run returns promptly",
    async ({ onTestFinished }) => {
      // An unkilled agent would need 20s per round (2 rounds); a working timeout needs ~0.5s per round.
      const ws = workspace(onTestFinished, "setTimeout(() => console.log('too late'), 20000);\n");
      const deps = fixtureDeps(ws.dir);
      const startedAt = Date.now();
      const r = await runEfficiencyPipeline(input(ws, { executor: executor(ws.agentScript, 500) }), deps);
      const elapsed = Date.now() - startedAt;
      console.log(`[chaos] timeout run: status=${r.status} rounds=${r.execution?.rounds} elapsedMs=${elapsed}`);
      expect(r.status).not.toBe("completed");
      expect(r.status).toBe("failed");
      expect(r.execution?.rounds).toBe(2);
      expect(r.execution?.output ?? "").not.toContain("too late");
      expect(elapsed).toBeLessThan(15_000);
    },
    SPAWN_TIMEOUT
  );
});

describe.concurrent("chaos: runPipelineFailOpen", () => {
  it(
    "the efficiency layer throwing once falls back to the baseline worker path",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      let calls = 0;
      const deps = fixtureDeps(ws.dir, {
        collectFacts: (root) => {
          calls += 1;
          if (calls === 1) throw new Error("facts collector exploded");
          return fakeFacts(root);
        },
      });
      const r = await runPipelineFailOpen(input(ws), deps);
      expect(calls).toBe(2);
      expect(r.failOpen?.reason).toMatch(/efficiency layer failed: facts collector exploded/);
      expect(r.mode).toBe("baseline");
      expect(r.warnings[0]).toBe(r.failOpen?.reason);
      expect(r.context.source).toBe("none");
      expect(r.status).toBe("completed");
      expect(r.trace?.run.mode).toBe("baseline");
      // The fallback runs with null stores: nothing is cached or learned.
      expect(deps.cacheStore.data).toEqual({});
      expect(deps.experience.records).toHaveLength(0);
    },
    SPAWN_TIMEOUT
  );

  it("advisory runs have nothing to fall back to and rethrow", async ({ onTestFinished }) => {
    const ws = workspace(onTestFinished);
    const deps = fixtureDeps(ws.dir, {
      collectFacts: () => {
        throw new Error("facts collector exploded");
      },
    });
    await expect(runPipelineFailOpen(input(ws, { mode: "advisory" }), deps)).rejects.toThrow(/facts collector exploded/);
  });
});
