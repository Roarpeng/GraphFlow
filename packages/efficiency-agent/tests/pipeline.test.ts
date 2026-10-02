import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEfficiencyPipeline, type PipelineInput } from "../src/agent/pipeline.js";
import { createDefaultSecurity } from "../src/agent/security-default.js";
import { DEFAULT_FLAGS, type EffFlags } from "../src/flags.js";
import { replayProblems } from "../src/observability/replay.js";
import type { AgentExecutorSpec } from "../src/workers/agent-task-worker.js";
import { fixtureDeps, scratchWorkspace } from "./helpers/pipeline-fixtures.js";

const ACTING: EffFlags = { ...DEFAULT_FLAGS, EFF_AGENT_ENABLED: true, EFF_SHADOW_MODE: false };
const SPAWN_TIMEOUT = 30_000;

const quote = (p: string): string => `"${p}"`;
const nodeRun = (dir: string, script: string): string => `${quote(process.execPath)} ${quote(join(dir, script))}`;
const executor = (agentScript: string, timeoutMs = 30_000): AgentExecutorSpec => ({
  command: process.execPath,
  args: [agentScript],
  promptVia: "stdin",
  timeoutMs,
});

/** Agent script body: read the prompt from stdin, then run `code` (with `fs` and `input` in scope). */
const agentThen = (code: string): string =>
  [
    "const fs = require('fs');",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => (input += c));",
    "process.stdin.on('end', () => {",
    code,
    "});",
  ].join("\n");

function gitInit(dir: string): void {
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore", windowsHide: true });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "eff-agent-test"]);
  // A developer's global excludes file (often ignoring .env) must not hide writes from the audit.
  run(["config", "core.excludesFile", join(dir, ".no-global-excludes")]);
}

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

describe.concurrent("pipeline: flags cap and shadow mode", () => {
  it(
    "default flags cap a broker request to shadow and record the flags",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir);
      const r = await runEfficiencyPipeline(input(ws, { flags: { ...DEFAULT_FLAGS } }), deps);
      expect(r.mode).toBe("shadow");
      expect(r.requestedMode).toBe("conservative");
      expect(r.modeCapReason).toMatch(/EFF_AGENT_ENABLED=0/);
      expect(r.appliedDecision.reuseMode).toBe("FRESH");
      expect(r.record.flags).toEqual({ ...DEFAULT_FLAGS });
      expect(r.trace?.run.mode).toBe("shadow");
      expect(r.contract.mode).toBe("shadow");
      expect(r.status).toBe("completed");
      expect(replayProblems(r.trace!)).toEqual([]);
    },
    SPAWN_TIMEOUT
  );

  it("flags omitted entirely behave like DEFAULT_FLAGS (shadow)", async ({ onTestFinished }) => {
    const ws = workspace(onTestFinished);
    const deps = fixtureDeps(ws.dir);
    const { flags: _flags, executor: _executor, ...rest } = input(ws, { validation: [] });
    void _flags;
    void _executor;
    const r = await runEfficiencyPipeline(rest, deps);
    expect(r.mode).toBe("shadow");
    expect(r.modeCapReason).toBeDefined();
    expect(r.record.flags).toEqual({ ...DEFAULT_FLAGS });
  });
});

describe.concurrent("pipeline: acting broker execution", () => {
  it(
    "executor + passing validation completes with a replayable trace and a full contract",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir);
      const r = await runEfficiencyPipeline(input(ws), deps);
      expect(r.mode).toBe("broker");
      expect(r.modeCapReason).toBeUndefined();
      expect(r.status).toBe("completed");
      expect(r.execution?.agentInvocations).toBe(1);
      expect(r.execution?.output).toMatch(/ANSWER:/);
      const trace = r.trace!;
      expect(trace).toBeDefined();
      expect(trace.validationStatus).toBe("passed");
      expect(trace.record?.decisionId).toBe(r.contract.decisionId);
      expect(trace.run.mode).toBe("conservative");
      expect(r.contract.budget).toBeDefined();
      expect(r.contract.budget?.maxRounds).toBe(r.harness.maxRounds);
      expect(r.contract.permissions).toEqual({ read: [ws.dir], write: [ws.dir], network: false });
      expect(r.contract.validationPolicy).toEqual({ required: true, evidenceRequired: true });
      expect(r.contractViolations).toEqual([]);
      expect(replayProblems(trace)).toEqual([]);
      expect(deps.traces).toHaveLength(1);
      expect(deps.experience.records).toHaveLength(1);
      expect(deps.experience.records[0]!.status).toBe("completed");
    },
    SPAWN_TIMEOUT
  );

  it(
    "failing validation fails and uses exactly maxRounds rounds (conservative: 2)",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir);
      const r = await runEfficiencyPipeline(input(ws, { validation: [nodeRun(ws.dir, "fail.cjs")] }), deps);
      expect(r.status).toBe("failed");
      expect(r.harness.complexity).toBe("medium");
      expect(r.harness.maxRounds).toBe(2);
      expect(r.execution?.rounds).toBe(2);
      expect(r.execution?.agentInvocations).toBe(2);
      expect(r.trace?.validationStatus).toBe("failed");
      expect(r.trace?.failure?.stage).toBe("failed");
      expect(r.events.some((e) => e.stage === "replan")).toBe(true);
    },
    SPAWN_TIMEOUT
  );

  it(
    "adaptive medium harness without stop conditions runs all 3 rounds",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir);
      const r = await runEfficiencyPipeline(
        input(ws, { policy: "adaptive", validation: [nodeRun(ws.dir, "fail.cjs")] }),
        deps
      );
      expect(r.status).toBe("failed");
      expect(r.harness.maxRounds).toBe(3);
      expect(r.execution?.rounds).toBe(3);
    },
    SPAWN_TIMEOUT
  );

  it(
    "complex harness: the repeated-failure stop condition halts before maxRounds",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir);
      const r = await runEfficiencyPipeline(
        input(ws, {
          policy: "adaptive",
          category: "refactor",
          validation: [nodeRun(ws.dir, "fail.cjs")],
          flags: { ...ACTING, EFF_DYNAMIC_HARNESS: true },
        }),
        deps
      );
      expect(r.harness.complexity).toBe("complex");
      expect(r.harness.maxRounds).toBe(3);
      expect(r.status).toBe("failed");
      expect(r.execution?.rounds).toBe(2);
      expect(r.execution?.stopReason).toBe("stop-condition-triggered");
    },
    SPAWN_TIMEOUT
  );

  it(
    "complex harness: a changing validation failure is progress, so round 3 runs and passes",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      // Fails with different output on calls 1 and 2, passes on call 3.
      writeFileSync(
        join(ws.dir, "progress.cjs"),
        [
          "const fs = require('fs');",
          "const f = __dirname + '/progress-count.txt';",
          "const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1;",
          "fs.writeFileSync(f, String(n));",
          "if (n < 3) { console.error('still failing: step ' + n); process.exit(1); }",
        ].join("\n")
      );
      const r = await runEfficiencyPipeline(
        input(ws, {
          policy: "adaptive",
          category: "refactor",
          validation: [nodeRun(ws.dir, "progress.cjs")],
          flags: { ...ACTING, EFF_DYNAMIC_HARNESS: true },
        }),
        fixtureDeps(ws.dir)
      );
      expect(r.harness.complexity).toBe("complex");
      expect(r.execution?.rounds).toBe(3);
      expect(r.status).toBe("completed");
    },
    SPAWN_TIMEOUT
  );

  it("no executor and no validation: not-executed and nothing learned", async ({ onTestFinished }) => {
    const ws = workspace(onTestFinished);
    const deps = fixtureDeps(ws.dir);
    const { executor: _drop, ...rest } = input(ws, { validation: [] });
    void _drop;
    const r = await runEfficiencyPipeline(rest, deps);
    expect(r.status).toBe("not-executed");
    expect(r.execution).toBeUndefined();
    expect(deps.experience.records).toHaveLength(0);
  });

  it("advisory mode returns the contract only: no trace, no execution", async ({ onTestFinished }) => {
    const ws = workspace(onTestFinished, agentThen("fs.writeFileSync('ran.txt', 'x'); console.log('ANSWER: ran');"));
    const deps = fixtureDeps(ws.dir);
    const r = await runEfficiencyPipeline(input(ws, { mode: "advisory" }), deps);
    expect(r.status).toBe("advisory-only");
    expect(r.trace).toBeUndefined();
    expect(deps.traces).toHaveLength(0);
    expect(r.execution).toBeUndefined();
    expect(r.contract.decisionId).toEqual(expect.any(String));
    expect(r.contract.schemaVersion).toBe("1.0");
    expect(deps.experience.records).toHaveLength(0);
    expect(() => readFileSync(join(ws.dir, "ran.txt"))).toThrow();
  });
});

describe.concurrent("pipeline: result reuse", () => {
  const queryTask = "what does main return?";

  it(
    "EFF_RESULT_REUSE=0: an identical read-only rerun never REUSEs",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir);
      const run = () =>
        runEfficiencyPipeline(
          input(ws, { task: queryTask, category: "query", policy: "adaptive", flags: { ...ACTING, EFF_PLAN_REUSE: true } }),
          deps
        );
      const first = await run();
      expect(first.status).toBe("completed");
      const second = await run();
      expect(second.rawDecision.reuseMode).not.toBe("REUSE");
      expect(second.appliedDecision.reuseMode).toBe("ADAPT");
      expect(second.verdicts.some((v) => v.kind === "result")).toBe(false);
      expect(second.status).toBe("completed");
      expect(second.execution?.agentInvocations).toBe(1);
    },
    SPAWN_TIMEOUT
  );

  it(
    "EFF_RESULT_REUSE=1 + adaptive: the second identical query is replayed with 0 agent invocations",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir);
      const flags = { ...ACTING, EFF_PLAN_REUSE: true, EFF_RESULT_REUSE: true };
      const run = () => runEfficiencyPipeline(input(ws, { task: queryTask, category: "query", policy: "adaptive", flags }), deps);
      const first = await run();
      expect(first.status).toBe("completed");
      expect(first.events.some((e) => e.stage === "learn" && e.outcome === "result-cached")).toBe(true);
      const second = await run();
      expect(second.status).toBe("reused");
      expect(second.appliedDecision.reuseMode).toBe("REUSE");
      expect(second.execution?.agentInvocations).toBe(0);
      expect(second.execution?.output).toBe(first.execution?.output);
      expect(second.trace?.validationStatus).toBe("passed");
      expect(replayProblems(second.trace!)).toEqual([]);
    },
    SPAWN_TIMEOUT
  );

  it(
    "EFF_RESULT_REUSE=1 + conservative: a REUSE verdict is applied as ADAPT",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir);
      const flags = { ...ACTING, EFF_PLAN_REUSE: true, EFF_RESULT_REUSE: true };
      const run = () =>
        runEfficiencyPipeline(input(ws, { task: queryTask, category: "query", policy: "conservative", flags }), deps);
      await run();
      const second = await run();
      expect(second.rawDecision.reuseMode).toBe("REUSE");
      expect(second.appliedDecision.reuseMode).toBe("ADAPT");
      expect(second.status).toBe("completed");
      expect(second.execution?.agentInvocations).toBe(1);
    },
    SPAWN_TIMEOUT
  );

  it(
    "a result validated under other commands or agent args is not replayed (fingerprint changes)",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir);
      const flags = { ...ACTING, EFF_PLAN_REUSE: true, EFF_RESULT_REUSE: true };
      const base = input(ws, { task: queryTask, category: "query", policy: "adaptive", flags });
      const first = await runEfficiencyPipeline(base, deps);
      expect(first.status).toBe("completed");

      const otherValidation = await runEfficiencyPipeline(
        { ...base, validation: [nodeRun(ws.dir, "pass.cjs"), nodeRun(ws.dir, "pass.cjs")] },
        deps
      );
      expect(otherValidation.status).toBe("completed");
      expect(otherValidation.execution?.agentInvocations).toBe(1);
      expect(otherValidation.fingerprint.reuseKey).not.toBe(first.fingerprint.reuseKey);

      const otherArgs = await runEfficiencyPipeline(
        { ...base, executor: { ...base.executor!, args: [ws.agentScript, "--model", "other"] } },
        deps
      );
      expect(otherArgs.status).toBe("completed");
      expect(otherArgs.execution?.agentInvocations).toBe(1);
    },
    SPAWN_TIMEOUT
  );

  it(
    "a cached result never replays past a non-allow security verdict",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const flags = { ...ACTING, EFF_PLAN_REUSE: true, EFF_RESULT_REUSE: true };
      const deps = fixtureDeps(ws.dir);
      const run = () => runEfficiencyPipeline(input(ws, { task: queryTask, category: "query", policy: "adaptive", flags }), deps);
      expect((await run()).status).toBe("completed");
      const security = createDefaultSecurity();
      deps.security = {
        ...security,
        checkCommands: () => ({ verdict: "deny", risk: "R3", reasons: ["test: denied"] }),
      };
      const second = await run();
      expect(second.rawDecision.reuseMode).toBe("REUSE");
      expect(second.status).toBe("blocked");
      expect(second.execution?.output).toBeUndefined();
    },
    SPAWN_TIMEOUT
  );
});

describe.concurrent("pipeline: security gate", () => {
  it("a network validation command is denied (network off by default) before any agent runs", async ({ onTestFinished }) => {
    const ws = workspace(onTestFinished, agentThen("fs.writeFileSync('ran.txt', 'x'); console.log('ANSWER: ran');"));
    const deps = fixtureDeps(ws.dir);
    const r = await runEfficiencyPipeline(input(ws, { validation: ["curl http://example.com"] }), deps);
    expect(r.status).toBe("blocked");
    expect(r.security.verdict).toBe("deny");
    expect(r.security.risk).toBe("R2");
    expect(r.security.reasons.join(" ")).toMatch(/network access is disabled/);
    expect(r.execution).toBeUndefined();
    expect(() => readFileSync(join(ws.dir, "ran.txt"))).toThrow();
    expect(deps.experience.records).toHaveLength(0);
    expect(r.trace?.llm.calls.value).toBe(0);
  });

  it(
    "an R2 approval-required command blocks without --approve and proceeds with approved=true",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      // `git init` classifies as R2 (mutates local git state) with no network capability.
      const validation = ["git init -q"];
      const blocked = await runEfficiencyPipeline(input(ws, { validation }), fixtureDeps(ws.dir));
      expect(blocked.status).toBe("blocked");
      expect(blocked.security.verdict).toBe("approval-required");
      expect(blocked.security.risk).toBe("R2");
      expect(blocked.statusReason).toMatch(/--approve/);

      const approved = await runEfficiencyPipeline(input(ws, { validation, approved: true }), fixtureDeps(ws.dir));
      expect(approved.security.verdict).toBe("allow");
      expect(approved.security.reasons).toContain("approved by operator (--approve)");
      expect(approved.status).toBe("completed");
      expect(approved.execution?.agentInvocations).toBe(1);
    },
    SPAWN_TIMEOUT
  );

  it(
    "write audit: a read-only task whose agent writes a file is a violation",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished, agentThen("fs.writeFileSync('out.txt', 'x'); console.log('ANSWER: wrote');"));
      gitInit(ws.dir);
      const deps = fixtureDeps(ws.dir);
      const r = await runEfficiencyPipeline(
        input(ws, { task: "where is main defined?", category: "query" }),
        deps
      );
      expect(r.status).toBe("violation");
      expect(r.writeAudit?.verdict).toBe("deny");
      expect(r.writeAudit?.newlyChanged).toContain("out.txt");
      expect(r.security.verdict).toBe("deny");
      expect(r.statusReason).toMatch(/read-only/);
      expect(r.events.some((e) => e.stage === "security" && e.outcome === "write-audit:deny")).toBe(true);
    },
    SPAWN_TIMEOUT
  );

  it(
    "write audit: writing a protected path (.env) is a violation even in a write category",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished, agentThen("fs.writeFileSync('.env', 'X=1'); console.log('ANSWER: wrote env');"));
      gitInit(ws.dir);
      const deps = fixtureDeps(ws.dir);
      const r = await runEfficiencyPipeline(input(ws, { task: "fix the config loader", category: "bugfix" }), deps);
      expect(r.status).toBe("violation");
      expect(r.writeAudit?.newlyChanged).toContain(".env");
      expect(r.security.risk).toBe("R3");
      expect(r.statusReason).toMatch(/protected path/);
    },
    SPAWN_TIMEOUT
  );

  it(
    "write audit: an in-workspace source edit in a write category is allowed",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished, agentThen("fs.mkdirSync('src', { recursive: true }); fs.writeFileSync('src/x.ts', 'export {}'); console.log('ANSWER: edited');"));
      gitInit(ws.dir);
      const deps = fixtureDeps(ws.dir);
      const r = await runEfficiencyPipeline(input(ws, { task: "fix the parser", category: "bugfix" }), deps);
      expect(r.status).toBe("completed");
      expect(r.writeAudit?.verdict).toBe("allow");
      expect(r.writeAudit?.newlyChanged).toContain("src/x.ts");
    },
    SPAWN_TIMEOUT
  );

  it(
    "redaction: secrets printed by the agent never reach the output, the trace or the result cache",
    async ({ onTestFinished }) => {
      const ghp = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
      const sk = "sk-" + "Zq9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBaZyXw";
      expect(ghp).toHaveLength(40);
      expect(sk).toHaveLength(43);
      const ws = workspace(onTestFinished, agentThen(`console.log('ANSWER: token ${ghp} key ${sk}');`));
      const deps = fixtureDeps(ws.dir);
      const r = await runEfficiencyPipeline(
        input(ws, {
          task: "what does main return?",
          category: "query",
          policy: "adaptive",
          flags: { ...ACTING, EFF_PLAN_REUSE: true, EFF_RESULT_REUSE: true },
        }),
        deps
      );
      expect(r.status).toBe("completed");
      const output = r.execution?.output ?? "";
      expect(output).toContain("[REDACTED:");
      expect(output).not.toContain(ghp);
      expect(output).not.toContain(sk);
      const traceJson = JSON.stringify(deps.traces[0]);
      expect(traceJson).not.toContain(ghp);
      expect(traceJson).not.toContain(sk);
      expect(JSON.stringify(r.trace)).not.toContain(ghp);
      expect(JSON.stringify(deps.experience.records)).not.toContain(ghp);
      expect(r.events.some((e) => e.stage === "learn" && e.outcome === "result-not-cached")).toBe(true);
      expect(JSON.stringify(deps.cacheStore.data)).not.toContain(ghp);
    },
    SPAWN_TIMEOUT
  );

  it(
    "untrusted wrapping: GraphFlow context in the acting prompt is fenced with UNTRUSTED markers",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished, agentThen("fs.writeFileSync('prompt.txt', input); console.log('ANSWER: ok');"));
      const deps = fixtureDeps(ws.dir);
      const r = await runEfficiencyPipeline(input(ws), deps);
      expect(r.status).toBe("completed");
      expect(r.context.source).toBe("graphflow");
      const prompt = readFileSync(join(ws.dir, "prompt.txt"), "utf8");
      expect(prompt).toContain("UNTRUSTED DATA (graphflow-context)");
      const fenced = /<<<UNTRUSTED-([0-9a-f]+) BEGIN>>>\n([\s\S]*?)\n<<<UNTRUSTED-\1 END>>>/.exec(prompt);
      expect(fenced).not.toBeNull();
      expect(fenced![2]).toContain("src/index.ts exports main");
      expect(prompt).toContain("EXECUTION CONTRACT:");
    },
    SPAWN_TIMEOUT
  );

  it(
    "shadow mode keeps the baseline prompt (no GraphFlow context, no fences)",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished, agentThen("fs.writeFileSync('prompt.txt', input); console.log('ANSWER: ok');"));
      const deps = fixtureDeps(ws.dir);
      await runEfficiencyPipeline(input(ws, { flags: { ...DEFAULT_FLAGS } }), deps);
      const prompt = readFileSync(join(ws.dir, "prompt.txt"), "utf8");
      expect(prompt.startsWith("TASK: add a helper to src/util.ts")).toBe(true);
      expect(prompt).not.toContain("UNTRUSTED");
      expect(prompt).not.toContain("EXECUTION CONTRACT");
    },
    SPAWN_TIMEOUT
  );
});

describe.concurrent("pipeline: events", () => {
  it(
    "records the stage sequence in order, every event carrying the record's policyVersion",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir);
      const r = await runEfficiencyPipeline(input(ws), deps);
      const trace = r.trace!;
      const events = trace.events ?? [];
      const stages = events.map((e) => e.stage);
      const required = ["flags", "fingerprint", "reuse-gate", "security", "execute", "validate"] as const;
      let cursor = -1;
      for (const stage of required) {
        const at = stages.indexOf(stage, cursor + 1);
        expect(at, `stage ${stage} after index ${cursor} in [${stages.join(",")}]`).toBeGreaterThan(cursor);
        cursor = at;
      }
      const policyVersion = trace.record!.policyVersion;
      expect(policyVersion).toBe(r.record.policyVersion);
      for (const event of events) expect(event.policyVersion).toBe(policyVersion);
      expect(r.events).toEqual(events);
    },
    SPAWN_TIMEOUT
  );

  it(
    "a learned policy version flows into every event and the decision record",
    async ({ onTestFinished }) => {
      const ws = workspace(onTestFinished);
      const deps = fixtureDeps(ws.dir);
      deps.policyKv.set(
        "policy-current",
        JSON.stringify({ version: 4, minSamples: 5, modelTierByCategory: {}, executionModeByCategory: {}, avoidPatterns: [], rationale: [] })
      );
      const r = await runEfficiencyPipeline(input(ws), deps);
      expect(r.record.policyVersion).toBe(4);
      expect(r.events.every((e) => e.policyVersion === 4)).toBe(true);
      expect(replayProblems(r.trace!)).toEqual([]);
    },
    SPAWN_TIMEOUT
  );
});