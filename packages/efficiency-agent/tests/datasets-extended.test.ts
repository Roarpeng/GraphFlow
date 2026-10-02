import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { ValidateFunction } from "ajv";

import { runCli, type CliIo } from "../bin/eff-agent.js";
import { planBenchUnits } from "../src/bench-runner.js";
import {
  EXTENDED_COMPOSITION,
  EXTENDED_MAX_UNJUDGED,
  EXTENDED_MIN_PER_CATEGORY,
  LONG_HORIZON_SESSIONS,
  LONG_HORIZON_STEP_BOUNDS,
  parseBenchDataset,
  parseEffTaskCorpus,
  parseGoldenExtendedCorpus,
  parseLongHorizonCorpus,
  type EffTask,
  type LongHorizonSession,
} from "../src/corpus.js";
import { TRACE_TASK_CATEGORIES, type TaskTrace } from "../src/trace.js";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const BENCH = join(PKG, "benchmarks");
const EXTENDED_FILE = join(BENCH, "golden-extended-v1.jsonl");
const LH_FILE = join(BENCH, "long-horizon-v1.jsonl");
const CORE_FILE = join(BENCH, "golden-v1.jsonl");
const extendedContent = readFileSync(EXTENDED_FILE, "utf8");
const lhContent = readFileSync(LH_FILE, "utf8");
const extendedLines = extendedContent.split("\n").filter((l) => l.trim().length > 0);
const lhLines = lhContent.split("\n").filter((l) => l.trim().length > 0);
const extended = parseGoldenExtendedCorpus(extendedContent);
const longHorizon = parseLongHorizonCorpus(lhContent);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const rows = <T>(lines: string[]): T[] => lines.map((l) => JSON.parse(l) as T);
const toJsonl = (items: unknown[]): string => items.map((i) => JSON.stringify(i)).join("\n") + "\n";

// ajv / ajv-formats are CJS: NodeNext types the default import as the module object,
// while the vitest runtime may hand over the class itself.
type AjvClass = typeof Ajv2020Import.default;
type AddFormats = typeof addFormatsImport.default;
const AjvCtor = ((Ajv2020Import as unknown as { default?: AjvClass }).default ?? Ajv2020Import) as unknown as AjvClass;
const applyFormats = ((addFormatsImport as unknown as { default?: AddFormats }).default ?? addFormatsImport) as unknown as AddFormats;

function compileSchema(file: string): ValidateFunction {
  const ajv = new AjvCtor({ strict: true, allErrors: true });
  applyFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(join(PKG, "schemas", file), "utf8")) as object);
}
const errorsOf = (fn: ValidateFunction): string => JSON.stringify(fn.errors ?? [], null, 2);

function gitHistoryAvailable(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: PKG, stdio: "ignore", windowsHide: true });
    const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: PKG, encoding: "utf8", windowsHide: true }).trim();
    return shallow !== "true";
  } catch {
    return false;
  }
}
const FULL_GIT = gitHistoryAvailable();

/** Async child process: a long spawnSync would block the vitest worker's RPC loop. */
function runNode(args: string[], timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd: PKG, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}

describe("golden-extended-v1.jsonl (Golden-Extended 200, §18 nightly)", () => {
  const tasks = extended.tasks;

  it("parses with 0 violations and exactly 200 tasks", () => {
    expect(extended.violations).toEqual([]);
    expect(extendedLines).toHaveLength(200);
    expect(tasks).toHaveLength(200);
  });

  it("composition 60/80/45/15: ~30% repetition, 5-10% deliberate failure", () => {
    const counts: Record<string, number> = {};
    for (const task of tasks) counts[task.cohort] = (counts[task.cohort] ?? 0) + 1;
    expect(counts).toEqual(EXTENDED_COMPOSITION);
    expect(counts.repetition! / tasks.length).toBeCloseTo(0.3, 5);
    const failureShare = counts.failure! / tasks.length;
    expect(failureShare).toBeGreaterThanOrEqual(0.05);
    expect(failureShare).toBeLessThanOrEqual(0.1);
  });

  it("every trace-v1 category is exercised at least 3 times; deliberate-failure only in the failure cohort", () => {
    const byCategory: Record<string, number> = {};
    for (const task of tasks) byCategory[task.category] = (byCategory[task.category] ?? 0) + 1;
    for (const category of TRACE_TASK_CATEGORIES) {
      expect(byCategory[category] ?? 0, category).toBeGreaterThanOrEqual(EXTENDED_MIN_PER_CATEGORY);
    }
    for (const task of tasks) expect(task.category === "deliberate-failure", task.id).toBe(task.cohort === "failure");
  });

  it("ids are unique, carry their cohort prefix, and never collide with Golden-Core", () => {
    const prefix: Record<EffTask["cohort"], string> = { repetition: "ext-rep-", regular: "ext-reg-", complex: "ext-cx-", failure: "ext-fail-" };
    expect(new Set(tasks.map((t) => t.id)).size).toBe(200);
    for (const task of tasks) expect(task.id.startsWith(prefix[task.cohort]), task.id).toBe(true);
    const core = parseEffTaskCorpus(readFileSync(CORE_FILE, "utf8")).tasks;
    const coreIds = new Set(core.map((t) => t.id));
    const coreTexts = new Set(core.map((t) => t.text));
    for (const task of tasks) {
      expect(coreIds.has(task.id), task.id).toBe(false);
      expect(coreTexts.has(task.text), `${task.id} duplicates a Golden-Core text`).toBe(false);
    }
  });

  it("15 paraphrase families of 4: same category, oracle and baseCommit; distinct texts and variants", () => {
    const families = new Map<string, EffTask[]>();
    for (const task of tasks.filter((t) => t.cohort === "repetition")) {
      expect(task.family, task.id).toMatch(/^fam-/);
      families.set(task.family!, [...(families.get(task.family!) ?? []), task]);
    }
    expect(families.size).toBe(15);
    for (const [family, members] of families) {
      expect(members, family).toHaveLength(4);
      expect(new Set(members.map((m) => JSON.stringify(m.oracle))).size, family).toBe(1);
      expect(new Set(members.map((m) => m.category)).size, family).toBe(1);
      expect(new Set(members.map((m) => m.baseCommit)).size, family).toBe(1);
      expect(new Set(members.map((m) => m.text)).size, family).toBe(4);
      expect(members.map((m) => m.variant).sort(), family).toEqual([1, 2, 3, 4]);
    }
    for (const task of tasks.filter((t) => t.cohort !== "repetition")) expect(task.family, task.id).toBeUndefined();
  });

  it("every task pins a 40-hex baseCommit and declares refs (or absentRefs for failures)", () => {
    for (const task of tasks) {
      expect(task.baseCommit, task.id).toMatch(/^[0-9a-f]{40}$/);
      if (task.cohort === "failure") expect(task.absentRefs?.length ?? 0, task.id).toBeGreaterThan(0);
      else expect(task.refs?.length ?? 0, task.id).toBeGreaterThan(0);
    }
  });

  it("failures carry refusal oracles with noChanges; unjudged tasks are rare, guarded complex tasks", () => {
    for (const task of tasks.filter((t) => t.cohort === "failure")) {
      expect(task.oracle?.refusal?.signals.length ?? 0, task.id).toBeGreaterThan(0);
      expect(task.oracle?.refusal?.noChanges, task.id).toBe(true);
    }
    const unjudged = tasks.filter((t) => !t.oracle);
    expect(unjudged.length).toBeLessThanOrEqual(EXTENDED_MAX_UNJUDGED);
    for (const task of unjudged) {
      expect(task.cohort, task.id).toBe("complex");
      expect(task.guards?.length ?? 0, task.id).toBeGreaterThan(0);
      expect(task.notes ?? "", task.id).toMatch(/unjudged/i);
    }
  });

  it("no output needle is already in its task text (echoing the prompt never passes)", () => {
    for (const task of tasks) {
      const text = task.text.toLowerCase();
      const needles = [...(task.oracle?.outputAnyOf ?? []), ...(task.oracle?.outputAllOf ?? []), ...(task.oracle?.refusal?.signals ?? [])];
      for (const needle of needles) expect(text.includes(needle.toLowerCase()), `${task.id}: ${needle}`).toBe(false);
    }
  });

  describe("validator rejects broken corpora", () => {
    const base = rows<Record<string, unknown>>(extendedLines);
    const find = (pred: (t: Record<string, unknown>) => boolean): number => {
      const i = base.findIndex(pred);
      if (i < 0) throw new Error("fixture task not found");
      return i;
    };
    const mutate = (fn: (items: Array<Record<string, unknown>>) => void): string[] => {
      const items = clone(base);
      fn(items);
      return parseGoldenExtendedCorpus(toJsonl(items)).violations;
    };
    const rep = find((t) => t.cohort === "repetition");
    const reg = find((t) => t.cohort === "regular" && t.oracle !== undefined);
    const fail = find((t) => t.cohort === "failure");
    const anyOf = find((t) => Array.isArray((t.oracle as { outputAnyOf?: string[] } | undefined)?.outputAnyOf));

    const cases: Array<[string, (items: Array<Record<string, unknown>>) => void, string]> = [
      ["one task dropped", (items) => void items.splice(reg, 1), "composition: regular has 79 tasks, expected 80"],
      ["duplicate id", (items) => void (items[reg]!.id = items[rep]!.id), "duplicate id"],
      ["family oracle drift", (items) => void ((items[rep]!.oracle as Record<string, unknown>).outputAnyOf = ["drifted"]), "oracle differs"],
      ["repetition without family", (items) => void delete items[rep]!.family, "repetition tasks need a family id"],
      ["family on a regular task", (items) => void (items[reg]!.family = "fam-x"), "only repetition tasks belong to a paraphrase family"],
      ["failure without absentRefs", (items) => void delete items[fail]!.absentRefs, "failure tasks must declare what is absent"],
      ["failure without noChanges", (items) => void ((items[fail]!.oracle as { refusal: Record<string, unknown> }).refusal.noChanges = false), "refusal oracle with noChanges"],
      ["regular task without refs", (items) => void delete items[reg]!.refs, "must declare the repo files they touch"],
      ["regular task without oracle", (items) => void delete items[reg]!.oracle, "only guarded complex tasks marked unjudged"],
      ["unpinned baseCommit", (items) => void (items[reg]!.baseCommit = "HEAD"), "baseCommit must be a pinned hex revision"],
      ["absolute ref path", (items) => void (items[reg]!.refs = [{ path: "C:/Windows/system.ini" }]), "repo-relative path"],
      ["parent-escaping ref path", (items) => void (items[reg]!.refs = [{ path: "../outside.ts" }]), "repo-relative path"],
      [
        "needle echoed in the text",
        (items) => {
          const needle = (items[anyOf]!.oracle as { outputAnyOf: string[] }).outputAnyOf[0]!;
          items[anyOf]!.text = `${String(items[anyOf]!.text)} (hint: ${needle})`;
        },
        "appears in the task text",
      ],
    ];
    for (const [name, fn, expected] of cases) {
      it(name, () => expect(mutate(fn).join("\n")).toContain(expected));
    }
  });
});

describe("long-horizon-v1.jsonl (Long-Horizon 20, §18)", () => {
  const sessions = longHorizon.sessions;

  it("parses with 0 violations: 20 sessions of 3-8 ordered steps", () => {
    expect(longHorizon.violations).toEqual([]);
    expect(lhLines).toHaveLength(LONG_HORIZON_SESSIONS);
    expect(sessions).toHaveLength(LONG_HORIZON_SESSIONS);
    for (const s of sessions) {
      expect(s.steps.length, s.id).toBeGreaterThanOrEqual(LONG_HORIZON_STEP_BOUNDS.min);
      expect(s.steps.length, s.id).toBeLessThanOrEqual(LONG_HORIZON_STEP_BOUNDS.max);
      s.steps.forEach((step, i) => {
        expect(step.step, step.id).toBe(i + 1);
        expect(step.id).toBe(`${s.id}-s${i + 1}`);
      });
    }
  });

  it("four templates x 5 sessions; ids lh-001..lh-020; pinned baseCommits", () => {
    const templates: Record<string, number> = {};
    for (const s of sessions) templates[s.template] = (templates[s.template] ?? 0) + 1;
    expect(templates).toEqual({ "doc-pattern": 5, "test-evolution": 5, "rename-and-revert": 5, "config-lifecycle": 5 });
    expect(sessions.map((s) => s.id)).toEqual(Array.from({ length: 20 }, (_, i) => `lh-${String(i + 1).padStart(3, "0")}`));
    for (const s of sessions) expect(s.baseCommit, s.id).toMatch(/^[0-9a-f]{40}$/);
  });

  it("later steps depend on earlier ones: backward-only dependsOn/equivalentTo, >= 2 agent sessions each", () => {
    for (const s of sessions) {
      const earlier = new Set<string>();
      let lastSession = 0;
      for (const step of s.steps) {
        for (const dep of step.dependsOn) expect(earlier.has(dep), `${step.id} -> ${dep}`).toBe(true);
        if (step.equivalentTo) expect(earlier.has(step.equivalentTo), `${step.id} ~ ${step.equivalentTo}`).toBe(true);
        expect(step.expect.memory === "required", step.id).toBe(step.dependsOn.length > 0);
        expect(step.session === lastSession || step.session === lastSession + 1, step.id).toBe(true);
        lastSession = step.session;
        earlier.add(step.id);
      }
      expect(new Set(s.steps.map((st) => st.session)).size, s.id).toBeGreaterThanOrEqual(2);
      expect(s.steps.some((st) => st.expect.memory === "required"), s.id).toBe(true);
    }
  });

  it("reuse expectations agree with workspace changes (must-refresh only after a change, reuse-allowed only without)", () => {
    const counts: Record<string, number> = {};
    for (const s of sessions) {
      for (const [i, step] of s.steps.entries()) {
        counts[step.expect.reuse] = (counts[step.expect.reuse] ?? 0) + 1;
        if (step.expect.reuse === "fresh") {
          expect(step.equivalentTo, step.id).toBeUndefined();
          continue;
        }
        const eq = s.steps.find((st) => st.id === step.equivalentTo)!;
        const changed = s.steps.slice(eq.step, i).some((st) => st.expect.stateChange);
        expect(changed, step.id).toBe(step.expect.reuse === "must-refresh");
      }
    }
    for (const reuse of ["fresh", "reuse-allowed", "must-refresh"]) expect(counts[reuse] ?? 0, reuse).toBeGreaterThan(0);
  });

  it("every step is judged, uses a non-failure trace category, and never echoes its needles", () => {
    for (const s of sessions) {
      for (const step of s.steps) {
        expect(step.oracle, step.id).toBeDefined();
        expect((TRACE_TASK_CATEGORIES as readonly string[]).includes(step.category), step.id).toBe(true);
        expect(step.category, step.id).not.toBe("deliberate-failure");
        const text = step.text.toLowerCase();
        for (const n of [...(step.oracle.outputAnyOf ?? []), ...(step.oracle.outputAllOf ?? [])]) {
          expect(text.includes(n.toLowerCase()), `${step.id}: ${n}`).toBe(false);
        }
      }
    }
  });

  describe("validator rejects broken sessions", () => {
    const base = rows<LongHorizonSession>(lhLines);
    const mutate = (fn: (items: LongHorizonSession[]) => void): string[] => {
      const items = clone(base);
      fn(items);
      return parseLongHorizonCorpus(toJsonl(items)).violations;
    };
    const s0 = base[0]!;
    const refreshIdx = s0.steps.findIndex((st) => st.expect.reuse === "must-refresh");
    const reuseIdx = s0.steps.findIndex((st) => st.expect.reuse === "reuse-allowed");
    const depIdx = s0.steps.findIndex((st) => st.dependsOn.length > 0);
    const freshIdx = s0.steps.findIndex((st, i) => i > 0 && st.expect.reuse === "fresh" && st.dependsOn.length === 0);

    const cases: Array<[string, (items: LongHorizonSession[]) => void, string]> = [
      ["19 sessions", (items) => void items.pop(), "composition: 19 sessions, expected 20"],
      [
        "steps swapped",
        (items) => {
          const st = items[0]!.steps;
          [st[0], st[1]] = [st[1]!, st[0]!];
        },
        "steps are ordered and contiguous",
      ],
      ["too few steps", (items) => void items[0]!.steps.splice(2), "steps, expected 3-8"],
      ["forward dependsOn", (items) => void (items[0]!.steps[0]!.dependsOn = [items[0]!.steps[2]!.id]), "is not an earlier step"],
      ["memory flag without dependencies", (items) => void (items[0]!.steps[freshIdx]!.expect.memory = "required"), 'memory "required" iff dependsOn'],
      ["dependency without memory flag", (items) => void (items[0]!.steps[depIdx]!.expect.memory = "none"), 'memory "required" iff dependsOn'],
      [
        "must-refresh with nothing changed",
        (items) => {
          for (const st of items[0]!.steps) st.expect.stateChange = false;
        },
        "must-refresh but no step after",
      ],
      ["reuse-allowed after a change", (items) => void (items[0]!.steps[refreshIdx]!.expect.reuse = "reuse-allowed"), "reuse-allowed but a step after"],
      ["fresh step with equivalentTo", (items) => void (items[0]!.steps[0]!.equivalentTo = "lh-001-s1"), "a fresh step has no equivalentTo"],
      ["first step opens session 2", (items) => void (items[0]!.steps[0]!.session = 2), "the first step opens session 1"],
      [
        "session gap",
        (items) => {
          const st = items[0]!.steps;
          st[st.length - 1]!.session = st[st.length - 2]!.session + 2;
        },
        "non-decreasing without gaps",
      ],
      [
        "single agent session",
        (items) => {
          for (const st of items[0]!.steps) st.session = 1;
        },
        "span at least two agent sessions",
      ],
      [
        "step without oracle",
        (items) => void delete (items[0]!.steps[0] as unknown as Record<string, unknown>).oracle,
        "oracle required",
      ],
    ];
    it("fixture session has every reuse kind", () => {
      expect([refreshIdx, reuseIdx, depIdx, freshIdx].every((i) => i >= 0)).toBe(true);
    });
    for (const [name, fn, expected] of cases) {
      it(name, () => expect(mutate(fn).join("\n")).toContain(expected));
    }
  });
});

describe("JSON schemas for the §18 datasets (AJV 2020-12, strict)", () => {
  const taskSchema = compileSchema("golden-extended-task-v1.schema.json");
  const lhSchema = compileSchema("long-horizon-v1.schema.json");

  it("every golden-extended line validates against golden-extended-task-v1.schema.json", () => {
    for (const line of extendedLines) {
      const task = JSON.parse(line) as { id: string };
      expect(taskSchema(task), `${task.id}: ${errorsOf(taskSchema)}`).toBe(true);
    }
  });

  it("every long-horizon session validates against long-horizon-v1.schema.json", () => {
    for (const line of lhLines) {
      const session = JSON.parse(line) as { id: string };
      expect(lhSchema(session), `${session.id}: ${errorsOf(lhSchema)}`).toBe(true);
    }
  });

  it("negative: extended task mutations are AJV invalid AND TS violations", () => {
    const items = rows<Record<string, unknown>>(extendedLines);
    const rep = items.find((t) => t.cohort === "repetition")!;
    const reg = items.find((t) => t.cohort === "regular" && t.oracle !== undefined)!;
    const fail = items.find((t) => t.cohort === "failure")!;
    const cases: Array<[string, Record<string, unknown>]> = [
      ["repetition without family", (({ family: _f, ...rest }) => rest)(rep)],
      ["family on a regular task", { ...reg, family: "fam-x", variant: 1 }],
      ["failure without absentRefs", (({ absentRefs: _a, ...rest }) => rest)(fail)],
      ["regular without oracle", (({ oracle: _o, ...rest }) => rest)(reg)],
      ["unknown category", { ...reg, category: "astrology" }],
      ["overlayFrom without commands", { ...reg, oracle: { overlayFrom: { commit: "a".repeat(40), paths: ["tests/x.test.ts"] } } }],
    ];
    for (const [label, bad] of cases) {
      expect(taskSchema(bad), label).toBe(false);
      const others = items.filter((t) => t.id !== bad.id);
      expect(parseGoldenExtendedCorpus(toJsonl([...others, bad])).violations.length, label).toBeGreaterThan(0);
    }
    // The TS parser, like the golden-v1 one, ignores unknown fields; the schema is the strict layer.
    expect(taskSchema({ ...reg, priority: "high" })).toBe(false);
  });

  it("negative: long-horizon mutations are AJV invalid AND TS violations", () => {
    const items = rows<LongHorizonSession>(lhLines);
    const s = items[0]!;
    const withStep = (i: number, patch: Record<string, unknown>): LongHorizonSession => {
      const next = clone(s);
      Object.assign(next.steps[i]!, patch);
      return next;
    };
    const depIdx = s.steps.findIndex((st) => st.dependsOn.length > 0);
    const cases: Array<[string, LongHorizonSession]> = [
      ["memory required with no dependsOn", withStep(depIdx, { dependsOn: [] })],
      ["fresh step with equivalentTo", withStep(0, { equivalentTo: "lh-001-s1" })],
      ["two steps only", { ...clone(s), steps: clone(s).steps.slice(0, 2) }],
      ["unknown reuse", withStep(0, { expect: { reuse: "maybe", memory: "none", stateChange: false } })],
      ["bad step id", withStep(0, { id: "step-one" })],
    ];
    for (const [label, bad] of cases) {
      expect(lhSchema(bad), label).toBe(false);
      expect(parseLongHorizonCorpus(toJsonl([bad, ...items.slice(1)])).violations.length, label).toBeGreaterThan(0);
    }
  });
});

describe("parseBenchDataset + planBenchUnits on the committed datasets", () => {
  it("dispatches each file to its gate", () => {
    expect(parseBenchDataset(readFileSync(CORE_FILE, "utf8")).kind).toBe("golden-core");
    const ext = parseBenchDataset(extendedContent);
    expect(ext.kind).toBe("golden-extended");
    expect(ext.violations).toEqual([]);
    const lh = parseBenchDataset(lhContent);
    expect(lh.kind).toBe("long-horizon");
    expect(lh.violations).toEqual([]);
  });

  it("extended: a family id selects its 4 paraphrases as single-step units at the pinned commit", () => {
    const family = extended.tasks.find((t) => t.family)!.family!;
    const units = planBenchUnits(parseBenchDataset(extendedContent), undefined, [family]);
    expect(units).toHaveLength(4);
    for (const unit of units) {
      expect(unit.steps).toHaveLength(1);
      expect(unit.sessionId).toBeUndefined();
      expect(unit.revision).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("long-horizon: a session is one unit whose steps keep their order; a template selects 5 sessions", () => {
    const dataset = parseBenchDataset(lhContent);
    const [unit] = planBenchUnits(dataset, undefined, ["lh-003"]);
    const session = longHorizon.sessions.find((s) => s.id === "lh-003")!;
    expect(unit!.sessionId).toBe("lh-003");
    expect(unit!.revision).toBe(session.baseCommit);
    expect(unit!.steps.map((s) => s.task.id)).toEqual(session.steps.map((s) => s.id));
    expect(unit!.steps.map((s) => s.expect?.reuse)).toEqual(session.steps.map((s) => s.expect.reuse));
    expect(planBenchUnits(dataset, undefined, ["rename-and-revert"])).toHaveLength(5);
    expect(planBenchUnits(dataset, 2)).toHaveLength(2);
  });
});

describe.skipIf(!FULL_GIT)("repository checks (scripts/check-golden.mjs, gen-extended.mjs --check)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "eff-datasets-"));
  });
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const checkGolden = (...args: string[]) => runNode([join(PKG, "scripts", "check-golden.mjs"), ...args], 120_000);
  type Report = { ok: boolean; datasets: Array<{ dataset: string; ok: boolean; errors: string[] }> };

  it("--dataset all --json: every committed dataset passes the git-backed checks", async () => {
    const res = await checkGolden("--dataset", "all", "--json");
    const report = JSON.parse(res.stdout) as Report;
    expect(report.datasets.map((d) => [d.dataset, d.errors])).toEqual([
      ["core", []],
      ["extended", []],
      ["long-horizon", []],
    ]);
    expect(report.ok).toBe(true);
    expect(res.status).toBe(0);
  }, 120_000);

  it("no arguments keeps the PR gate on Golden-Core only", async () => {
    const res = await checkGolden("--json");
    const report = JSON.parse(res.stdout) as Report;
    expect(report.datasets.map((d) => d.dataset)).toEqual(["core"]);
    expect(res.status).toBe(0);
  }, 120_000);

  it("extended: fabricated paths/symbols, present 'absent' refs and no-op file oracles are caught", async () => {
    const items = rows<Record<string, unknown>>(extendedLines);
    const withSymbol = items.find((t) => (t.refs as Array<{ symbol?: string }> | undefined)?.some((r) => r.symbol))!;
    const withPath = items.find((t) => t !== withSymbol && t.cohort !== "failure")!;
    const absentFile = items.find((t) => (t.absentRefs as Array<{ path?: string; text?: string }> | undefined)?.some((r) => r.path && !r.text))!;
    const fileOracle = items.find((t) => (t.oracle as { files?: unknown[]; overlayFrom?: unknown } | undefined)?.files && !(t.oracle as { overlayFrom?: unknown }).overlayFrom)!;
    withSymbol.refs = [{ ...(withSymbol.refs as Array<{ path: string }>)[0]!, symbol: "definitelyNotARealSymbolXyz" }];
    withPath.refs = [{ path: "src/does/not/exist-anywhere.ts" }];
    absentFile.absentRefs = [{ path: "package.json" }];
    fileOracle.oracle = { files: [{ path: "package.json", pattern: "\\{" }] };
    const file = join(tmp, "extended-mutated.jsonl");
    writeFileSync(file, toJsonl(items));
    const res = await checkGolden(file, "--dataset", "extended", "--json");
    const errors = (JSON.parse(res.stdout) as Report).datasets[0]!.errors.join("\n");
    expect(res.status).toBe(1);
    expect(errors).toContain("symbol definitelyNotARealSymbolXyz not found");
    expect(errors).toContain("src/does/not/exist-anywhere.ts");
    expect(errors).toContain("absentRef package.json exists");
    expect(errors).toContain("a no-op would pass");
  }, 120_000);

  it("long-horizon: commands pointing at tests nobody creates and fabricated refs are caught", async () => {
    const items = rows<LongHorizonSession>(lhLines);
    items[0]!.refs = [{ path: "src/never/was-here.ts" }];
    items[1]!.steps[0]!.guards = ["npx vitest run tests/never-created-by-anyone.test.ts"];
    const file = join(tmp, "lh-mutated.jsonl");
    writeFileSync(file, toJsonl(items));
    const res = await checkGolden(file, "--json");
    const errors = (JSON.parse(res.stdout) as Report).datasets[0]!.errors.join("\n");
    expect(res.status).toBe(1);
    expect(errors).toContain("src/never/was-here.ts");
    expect(errors).toContain("tests/never-created-by-anyone.test.ts");
  }, 120_000);

  it("scripts/gen-extended.mjs --check: the committed JSONL is exactly what the generator produces", async () => {
    const res = await runNode([join(PKG, "scripts", "gen-extended.mjs"), "--check"], 180_000);
    expect(res.stdout).toContain("reproducible");
    expect(res.status).toBe(0);
  }, 180_000);
});

describe("bench run: a long-horizon session runs its steps in order in ONE worktree", () => {
  let root: string;
  let work: string;
  let agent: string;
  const STEP = { refs: [{ path: "README.md" }] };

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "eff-lh-"));
    work = join(root, "work");
    mkdirSync(work, { recursive: true });
    git(work, ["init", "-q"]);
    git(work, ["config", "user.name", "Eff Test"]);
    git(work, ["config", "user.email", "eff-test@example.invalid"]);
    git(work, ["config", "commit.gpgsign", "false"]);
    git(work, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(work, "README.md"), "# long-horizon fixture\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "init"]);
    agent = join(root, "stateful-agent.cjs");
    writeFileSync(
      agent,
      [
        "const fs = require('fs');",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (c) => (input += c));",
        "process.stdin.on('end', () => {",
        "  if (input.includes('KW_CREATE')) { fs.writeFileSync('notes.txt', 'alpha\\n'); console.log('created'); }",
        "  else if (input.includes('KW_APPEND')) { fs.appendFileSync('notes.txt', 'beta\\n'); console.log('appended'); }",
        "  else console.log(fs.existsSync('notes.txt') ? fs.readFileSync('notes.txt', 'utf8') : 'nothing here');",
        "});",
      ].join("\n")
    );
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** 20 schema-shaped sessions; step 2 can only pass if step 1's file is still in the worktree. */
  function corpus(baseCommit: string): string {
    const sessions = Array.from({ length: 20 }, (_, i) => {
      const id = `lh-${String(i + 1).padStart(3, "0")}`;
      return {
        id,
        dataset: "long-horizon-v1",
        template: "fixture",
        title: "Create, extend and re-read a notes file",
        baseCommit,
        ...STEP,
        steps: [
          { id: `${id}-s1`, step: 1, session: 1, category: "single-file", text: "KW_CREATE the notes file", dependsOn: [], expect: { reuse: "fresh", memory: "none", stateChange: true }, oracle: { files: [{ path: "notes.txt", pattern: "^alpha\\n$" }] } },
          { id: `${id}-s2`, step: 2, session: 2, category: "single-file", text: "KW_APPEND a second line to the notes file from earlier", dependsOn: [`${id}-s1`], expect: { reuse: "fresh", memory: "required", stateChange: true }, oracle: { files: [{ path: "notes.txt", pattern: "^alpha\\nbeta\\n$" }] } },
          { id: `${id}-s3`, step: 3, session: 2, category: "query", text: "Print what the notes file contains now", equivalentTo: `${id}-s1`, dependsOn: [`${id}-s2`], expect: { reuse: "must-refresh", memory: "required", stateChange: false }, oracle: { outputAllOf: ["alpha", "beta"] } },
          { id: `${id}-s4`, step: 4, session: 3, category: "query", text: "Print the notes file contents once more", equivalentTo: `${id}-s3`, dependsOn: [], expect: { reuse: "reuse-allowed", memory: "none", stateChange: false }, oracle: { outputAllOf: ["alpha", "beta"] } },
        ],
      };
    });
    return toJsonl(sessions);
  }

  it(
    "steps see earlier steps' files; reuse expectations are reported; the worktree is removed afterwards",
    async () => {
      const head = git(work, ["rev-parse", "HEAD"]).trim();
      const file = join(root, "lh-fixture.jsonl");
      writeFileSync(file, corpus(head));
      expect(parseLongHorizonCorpus(readFileSync(file, "utf8")).violations).toEqual([]);
      const out = join(root, "runs", "baseline.jsonl");
      let stdout = "";
      let stderr = "";
      const env: Record<string, string> = {};
      for (const key of ["PATH", "Path", "SystemRoot", "ComSpec", "TEMP", "TMP", "PATHEXT"]) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      const io: Required<CliIo> = { stdout: (m) => void (stdout += m + "\n"), stderr: (m) => void (stderr += m + "\n"), cwd: work, env };
      const code = await runCli(
        ["bench", "run", file, "--arm", "baseline", "--no-graphflow", "--only", "lh-002", "--cli-command", process.execPath, "--cli-args", `"${agent}"`, "--output", out, "--state-dir", join(root, "state")],
        io
      );
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toContain("Dataset: long-horizon");
      expect(stdout).toContain("Tasks Run: 4/4");
      expect(stdout).toContain("Judged: 4 | Passed: 4");
      expect(stdout).toMatch(/\[lh-002-s2\] .*oracle PASS/);
      expect(stdout).toMatch(/\[lh-002-s3\] .*reuse expected must-refresh/);
      const traces = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as TaskTrace);
      expect(traces.map((t) => t.task.taskId)).toEqual(["lh-002-s1", "lh-002-s2", "lh-002-s3", "lh-002-s4"]);
      expect(traces.every((t) => t.result.success)).toBe(true);
      expect(git(work, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1);
    },
    60_000
  );
});
