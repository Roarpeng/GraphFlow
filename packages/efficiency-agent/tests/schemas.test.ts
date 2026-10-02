import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { ValidateFunction } from "ajv";

import { withVerdict } from "../src/bench-runner.js";
import { assertAdvisoryCompatible, type ExecutionContractV1 } from "../src/contract.js";
import { parseEffTaskCorpus } from "../src/corpus.js";
import { buildTaskFingerprint } from "../src/fingerprint.js";
import { runEfficiencyPipeline, type PipelineResult } from "../src/agent/pipeline.js";
import { DEFAULT_FLAGS, type EffFlags } from "../src/flags.js";
import { createToolRegistry } from "../src/tools/capability-registry.js";
import { TRACE_TASK_CATEGORIES, validateTraceProvenance, type TaskTrace } from "../src/trace.js";
import { fixtureDeps, scratchWorkspace } from "./helpers/pipeline-fixtures.js";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA_DIR = join(PKG, "schemas");
const ACTING_FLAGS: EffFlags = { ...DEFAULT_FLAGS, EFF_AGENT_ENABLED: true, EFF_SHADOW_MODE: false };

// ajv / ajv-formats are CJS: NodeNext types the default import as the module object,
// while the vitest runtime may hand over the class itself.
type AjvClass = typeof Ajv2020Import.default;
type AddFormats = typeof addFormatsImport.default;
type AjvInstance = InstanceType<AjvClass>;
const AjvCtor = ((Ajv2020Import as unknown as { default?: AjvClass }).default ?? Ajv2020Import) as unknown as AjvClass;
const applyFormats = ((addFormatsImport as unknown as { default?: AddFormats }).default ?? addFormatsImport) as unknown as AddFormats;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function newAjv(): AjvInstance {
  const ajv = new AjvCtor({ strict: true, allErrors: true });
  applyFormats(ajv);
  return ajv;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("JSON schemas (AJV 2020-12, strict) agree with the TS validators", () => {
  const schemaFiles = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json")).sort();
  const ajv = newAjv();
  const validators = new Map<string, ValidateFunction>();
  for (const file of schemaFiles) validators.set(file, ajv.compile(readJson(join(SCHEMA_DIR, file)) as object));
  const v = (file: string): ValidateFunction => {
    const fn = validators.get(file);
    if (!fn) throw new Error(`schema ${file} not compiled`);
    return fn;
  };
  const errorsOf = (fn: ValidateFunction): string => JSON.stringify(fn.errors ?? [], null, 2);

  let ws: ReturnType<typeof scratchWorkspace>;
  let advisory: PipelineResult;
  let acting: PipelineResult;
  let actingTrace: TaskTrace;

  beforeAll(async () => {
    ws = scratchWorkspace();
    advisory = await runEfficiencyPipeline(
      { task: "Where is the model router configured?", root: ws.dir, mode: "advisory", policy: "conservative", validation: [] },
      fixtureDeps(ws.dir)
    );
    const deps = fixtureDeps(ws.dir);
    acting = await runEfficiencyPipeline(
      {
        task: "Fix the helper in src/util.ts",
        root: ws.dir,
        mode: "broker",
        policy: "conservative",
        validation: [`"${process.execPath}" "${join(ws.dir, "pass.cjs")}"`],
        executor: { command: process.execPath, args: [ws.agentScript], promptVia: "stdin", timeoutMs: 20_000 },
        flags: ACTING_FLAGS,
      },
      deps
    );
    const trace = acting.trace ?? deps.traces[0];
    if (!trace) throw new Error(`acting run produced no trace (status ${acting.status}: ${acting.statusReason})`);
    actingTrace = trace;
  }, 60_000);

  afterAll(() => ws?.dispose());

  it("compiles every schemas/*.schema.json in strict mode", () => {
    expect(schemaFiles).toEqual(
      expect.arrayContaining([
        "execution-contract-v1.schema.json",
        "trace-v1.schema.json",
        "task-fingerprint-v1.schema.json",
        "tool-capability-v1.schema.json",
      ])
    );
    expect(validators.size).toBe(schemaFiles.length);
  });

  it("policies/default-policy-v1.json validates against policy-v1.schema.json (when present)", () => {
    if (!schemaFiles.includes("policy-v1.schema.json")) return;
    const fn = v("policy-v1.schema.json");
    const policy = readJson(join(PKG, "policies", "default-policy-v1.json"));
    expect(fn(policy), errorsOf(fn)).toBe(true);
    const bad = clone(policy) as Record<string, unknown>;
    (bad.riskActions as Record<string, unknown>).R3 = "maybe";
    expect(fn(bad)).toBe(false);
  });

  describe("execution contract", () => {
    it("advisory-mode contract: AJV valid and assertAdvisoryCompatible() == []", () => {
      expect(advisory.status).toBe("advisory-only");
      const fn = v("execution-contract-v1.schema.json");
      expect(fn(advisory.contract), errorsOf(fn)).toBe(true);
      expect(assertAdvisoryCompatible(advisory.contract)).toEqual([]);
      expect(advisory.contractViolations).toEqual([]);
    });

    it("acting broker-mode contract: AJV valid and assertAdvisoryCompatible() == []", () => {
      expect(acting.mode).toBe("broker");
      expect(acting.status).toBe("completed");
      const fn = v("execution-contract-v1.schema.json");
      expect(fn(acting.contract), errorsOf(fn)).toBe(true);
      expect(assertAdvisoryCompatible(acting.contract)).toEqual([]);
    });

    const mutations: Array<[string, (c: Record<string, unknown>) => void]> = [
      ["reuseMode MAYBE", (c) => void (c.reuseMode = "MAYBE")],
      ["confidence 2", (c) => void (c.confidence = 2)],
      [
        "budget.maxRounds -1",
        (c) =>
          void (c.budget = {
            ...((c.budget as object | undefined) ?? { maxInputTokens: 1, maxOutputTokens: 1, maxToolCalls: 1, maxWallMs: 1 }),
            maxRounds: -1,
          }),
      ],
      [
        "permissions.network 'yes'",
        (c) => void (c.permissions = { ...((c.permissions as object | undefined) ?? { read: [], write: [] }), network: "yes" }),
      ],
      [
        "deterministic decision with llmCalls 1",
        (c) => void (c.decision = { ...(c.decision as object), provenance: "deterministic", llmCalls: 1 }),
      ],
      ["schemaVersion 2.0", (c) => void (c.schemaVersion = "2.0")],
      ["worker.maxRounds 0", (c) => void ((c.worker as Record<string, unknown>).maxRounds = 0)],
    ];
    for (const [name, mutate] of mutations) {
      it(`negative: ${name} -> AJV invalid AND TS violations`, () => {
        const fn = v("execution-contract-v1.schema.json");
        const bad = clone(acting.contract) as unknown as Record<string, unknown>;
        mutate(bad);
        expect(fn(bad)).toBe(false);
        expect(assertAdvisoryCompatible(bad).length).toBeGreaterThan(0);
      });
    }
  });

  describe("trace", () => {
    it("acting-run trace: AJV valid and validateTraceProvenance == []", () => {
      const fn = v("trace-v1.schema.json");
      expect(fn(actingTrace), errorsOf(fn)).toBe(true);
      expect(validateTraceProvenance(actingTrace)).toEqual([]);
      expect(actingTrace.result.success).toBe(true);
      expect(actingTrace.run.mode).toBe("conservative");
    });

    it("shadow-capped (default flags) trace and a bench-verdict trace are AJV valid too", async () => {
      const fn = v("trace-v1.schema.json");
      const deps = fixtureDeps(ws.dir);
      const shadow = await runEfficiencyPipeline(
        {
          task: "Fix the helper in src/util.ts",
          root: ws.dir,
          mode: "broker",
          policy: "adaptive",
          validation: [`"${process.execPath}" "${join(ws.dir, "pass.cjs")}"`],
        },
        deps
      );
      expect(shadow.mode).toBe("shadow");
      expect(shadow.trace).toBeDefined();
      expect(fn(shadow.trace), errorsOf(fn)).toBe(true);
      expect(validateTraceProvenance(shadow.trace!)).toEqual([]);
      expect(fn(shadow.contract), errorsOf(fn)).toBe(false);
      const contractFn = v("execution-contract-v1.schema.json");
      expect(contractFn(shadow.contract), errorsOf(contractFn)).toBe(true);
      expect(assertAdvisoryCompatible(shadow.contract)).toEqual([]);

      const judged = withVerdict(actingTrace, { judged: true, passed: false, checks: [{ name: "oracle: x", passed: false }] }, "rep-001", {
        arm: "graphflow",
        regression: { passed: true, checks: [{ name: "guard: y", passed: true }] },
      });
      expect(fn(judged), errorsOf(fn)).toBe(true);
      expect(validateTraceProvenance(judged)).toEqual([]);
    }, 30_000);

    it("negative: unknown provenance -> AJV invalid", () => {
      const fn = v("trace-v1.schema.json");
      const bad = clone(actingTrace) as unknown as { rounds: Record<string, unknown> };
      bad.rounds = { value: 1, provenance: "guessed" };
      expect(fn(bad)).toBe(false);
    });

    it("R2-R4: AJV and the TS provenance gate agree on method/confidence rules", () => {
      const fn = v("trace-v1.schema.json");
      const cases: Array<[string, TaskTrace["llm"]["calls"]]> = [
        ["estimated without method", { value: 5, provenance: "estimated" }],
        ["proxy without method", { value: 5, provenance: "proxy" }],
        ["measured with method", { value: 5, provenance: "measured", method: "x" }],
        ["measured with confidence", { value: 5, provenance: "measured", confidence: 0.5 }],
      ];
      for (const [label, calls] of cases) {
        const bad = clone(actingTrace);
        bad.llm.calls = calls;
        expect(fn(bad), label).toBe(false);
        expect(validateTraceProvenance(bad).length, label).toBeGreaterThan(0);
      }
      const ok = clone(actingTrace);
      ok.llm.calls = { value: 5, provenance: "proxy", method: "chars/4", confidence: 0.6 };
      expect(fn(ok), errorsOf(fn)).toBe(true);
      expect(validateTraceProvenance(ok)).toEqual([]);
    });

    it("negative: unknown task category / missing traceId -> AJV invalid AND provenance violation", () => {
      const fn = v("trace-v1.schema.json");
      const bad = clone(actingTrace) as unknown as Record<string, unknown>;
      delete bad.traceId;
      expect(fn(bad)).toBe(false);
      const bad2 = clone(actingTrace);
      bad2.task.category = "astrology";
      expect(fn(bad2)).toBe(false);
      expect(validateTraceProvenance(bad2)).toContain('task.category: "astrology" is not a trace-v1 category');
    });

    it("TRACE_TASK_CATEGORIES mirrors the schema enum", () => {
      const schema = readJson(join(SCHEMA_DIR, "trace-v1.schema.json")) as {
        properties: { task: { properties: { category: { enum: string[] } } } };
      };
      expect([...TRACE_TASK_CATEGORIES]).toEqual(schema.properties.task.properties.category.enum);
    });

    it("pipeline: an unknown input category falls back to classification with a warning", async () => {
      const fn = v("trace-v1.schema.json");
      const r = await runEfficiencyPipeline(
        {
          task: "Fix it",
          root: ws.dir,
          mode: "shadow",
          policy: "conservative",
          category: "astrology",
          validation: [`"${process.execPath}" "${join(ws.dir, "pass.cjs")}"`],
        },
        fixtureDeps(ws.dir)
      );
      expect(r.category).toBe("bugfix");
      expect(r.warnings.join(" ")).toContain('unknown category "astrology"');
      expect(fn(r.trace), errorsOf(fn)).toBe(true);
    }, 30_000);

    it("negative: measured value with confidence > 1 -> AJV invalid AND provenance violation", () => {
      const fn = v("trace-v1.schema.json");
      const bad = clone(actingTrace);
      bad.context.tokens = { value: 10, provenance: "estimated", method: "chars/4", confidence: 2 };
      expect(fn(bad)).toBe(false);
      expect(validateTraceProvenance(bad).length).toBeGreaterThan(0);
    });
  });

  it("buildTaskFingerprint output validates against task-fingerprint schema", () => {
    const fn = v("task-fingerprint-v1.schema.json");
    const fp = buildTaskFingerprint({
      task: "Fix the router",
      project: { gitHead: "b".repeat(40), relevantFileHashes: { "src/a.ts": "abc" } },
      context: { graphVersion: "graph:1" },
      environment: { toolVersions: { node: process.version } },
    });
    expect(fn(fp), errorsOf(fn)).toBe(true);
    expect(fn({ ...fp, facts: { task: "Fix the router", project: { relevantFileHashes: {}, gitHead: "c".repeat(40) } } })).toBe(true);
    expect(fn(acting.fingerprint), errorsOf(fn)).toBe(true);
    expect(fn({ ...fp, reuseKey: "nope" })).toBe(false);
    expect(fn({ ...fp, semanticTaskHash: "XYZ" })).toBe(false);
  });

  it("tool registry list() validates against tool-capability schema", () => {
    const fn = v("tool-capability-v1.schema.json");
    const registry = createToolRegistry([
      {
        name: "agent:node",
        capabilities: ["execute-task"],
        requiredContext: [],
        successHistory: { attempts: 0, successes: 0 },
        permission: ["process.exec", "filesystem.read", "filesystem.write"],
        risk: "R2",
        version: "1.0.0",
      },
    ]);
    registry.register({
      name: "graphflow-context",
      capabilities: ["context"],
      latencyMsP50: 40,
      costPerCallUsd: 0,
      precision: 0.8,
      requiredContext: ["rootDir"],
      successHistory: { attempts: 3, successes: 2 },
      permission: ["filesystem.read"],
      risk: "R0",
      version: "2.0.0",
    });
    registry.recordOutcome("agent:node", true);
    const tools = registry.list();
    expect(tools).toHaveLength(2);
    for (const tool of tools) expect(fn(tool), errorsOf(fn)).toBe(true);
    expect(fn({ ...tools[0], risk: "R9" })).toBe(false);
    expect(fn({ ...tools[0], permission: ["root.everything"] })).toBe(false);
  });

  it("benchmarks/golden-v1.jsonl parses with 0 violations; every category is a trace-schema category", () => {
    const { tasks, violations } = parseEffTaskCorpus(readFileSync(join(PKG, "benchmarks", "golden-v1.jsonl"), "utf8"));
    expect(violations).toEqual([]);
    expect(tasks).toHaveLength(50);
    const traceSchema = readJson(join(SCHEMA_DIR, "trace-v1.schema.json")) as {
      properties: { task: { properties: { category: { enum: string[] } } } };
    };
    const allowed = new Set(traceSchema.properties.task.properties.category.enum);
    for (const task of tasks) expect(allowed.has(task.category), `${task.id}: ${task.category}`).toBe(true);

    const firstLine = readFileSync(join(PKG, "benchmarks", "golden-v1.jsonl"), "utf8").split("\n")[0]!;
    const mutated = JSON.stringify({ ...(JSON.parse(firstLine) as object), category: "astrology" });
    const parsed = parseEffTaskCorpus(mutated);
    expect(parsed.violations.join("\n")).toContain('category "astrology" is not a trace-v1 category');
  });

  it("contract type stays assignable (compile-time guard)", () => {
    const c: ExecutionContractV1 = acting.contract;
    expect(c.schemaVersion).toBe("1.0");
  });
});
