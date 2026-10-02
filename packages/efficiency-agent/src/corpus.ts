/**
 * Benchmark task corpus (2.x plan §24): 50 real tasks in four cohorts —
 * 20 high-repetition (same shape, different parameters; ADAPT/cache
 * candidates), 15 regular modifications, 10 complex cross-module tasks, and
 * 5 deliberate failures (FRESH / invalidation / safety probes).
 *
 * The corpus ships as JSONL data (benchmarks/golden-v1.jsonl); this module
 * owns the parser and the composition gate. Regular-cohort texts are derived
 * from this repository's real git history (source field carries the commit).
 *
 * §18 adds two more datasets with their own gates: Golden-Extended
 * (benchmarks/golden-extended-v1.jsonl, 200 tasks, nightly) and Long-Horizon
 * (benchmarks/long-horizon-v1.jsonl, 20 ordered multi-step sessions). Both are
 * produced by scripts/gen-extended.mjs; repo-reference checks (paths/symbols
 * that must or must not exist at baseCommit) need git and live in
 * scripts/check-golden.mjs.
 */

import { isTraceTaskCategory, TRACE_TASK_CATEGORIES } from "./trace.js";

export type EffTaskCohort = "repetition" | "regular" | "complex" | "failure";

export const COHORT_COMPOSITION: Record<EffTaskCohort, number> = {
  repetition: 20,
  regular: 15,
  complex: 10,
  failure: 5,
};

/** Golden-Extended: 30% repetition families, 40% regular, 22.5% complex, 7.5% deliberate failure. */
export const EXTENDED_COMPOSITION: Record<EffTaskCohort, number> = {
  repetition: 60,
  regular: 80,
  complex: 45,
  failure: 15,
};
export const EXTENDED_DATASET_ID = "golden-extended-v1";
/** Every trace category must be exercised by at least this many extended tasks. */
export const EXTENDED_MIN_PER_CATEGORY = 3;
/** Unjudged (guards-only design) tasks may not exceed this share of the extended corpus. */
export const EXTENDED_MAX_UNJUDGED = 10;

export const LONG_HORIZON_DATASET_ID = "long-horizon-v1";
export const LONG_HORIZON_SESSIONS = 20;
export const LONG_HORIZON_STEP_BOUNDS = { min: 3, max: 8 } as const;

/** A repo-relative path (and optionally a symbol it must contain) that must exist at baseCommit. */
export interface EffTaskRef {
  path: string;
  symbol?: string;
}

/**
 * Something that must NOT exist at baseCommit: `path` alone = the path is
 * absent; `path` + `text` = the file exists but does not contain `text`;
 * `text` alone = no tracked file contains `text`.
 */
export interface EffTaskAbsentRef {
  path?: string;
  text?: string;
}

/**
 * How a run of the task is judged. Every present check must pass; a task with
 * no oracle is executed but reported as unjudged (it never counts toward a
 * success rate).
 */
export interface EffTaskOracle {
  /** Case-insensitive: the agent's output must contain at least one. */
  outputAnyOf?: string[];
  /** Case-insensitive: the agent's output must contain every one. */
  outputAllOf?: string[];
  /** Repo-relative file must match the regex after the run. */
  files?: Array<{ path: string; pattern: string }>;
  /** Shell-free commands that must exit 0 in the task workspace. */
  commands?: string[];
  /**
   * Hidden tests: these paths are checked out from `commit` after the agent
   * finishes and before `commands` run (the agent never sees them).
   */
  overlayFrom?: { commit: string; paths: string[] };
  /** The task is impossible/false-premise: the agent must say so. */
  refusal?: { signals: string[]; noChanges?: boolean };
}

export interface EffTask {
  id: string;
  cohort: EffTaskCohort;
  category: string;
  source: string;
  text: string;
  notes?: string;
  /** Git revision the task workspace starts from (default HEAD). */
  baseCommit?: string;
  oracle?: EffTaskOracle;
  /**
   * Regression guards: commands that passed at the base commit and must keep
   * passing. They never judge success — they feed the regression rate.
   */
  guards?: string[];
  /** Dataset id for the §18 extended datasets (golden-v1 lines omit it). */
  dataset?: string;
  /** Paraphrase family: every member asks the same thing, so reuse across members is measurable. */
  family?: string;
  variant?: number;
  refs?: EffTaskRef[];
  absentRefs?: EffTaskAbsentRef[];
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);

function oracleViolations(id: string, oracle: unknown): string[] {
  if (typeof oracle !== "object" || oracle === null || Array.isArray(oracle)) return [`${id}: oracle must be an object`];
  const o = oracle as Record<string, unknown>;
  const out: string[] = [];
  const known = new Set(["outputAnyOf", "outputAllOf", "files", "commands", "overlayFrom", "refusal"]);
  for (const key of Object.keys(o)) if (!known.has(key)) out.push(`${id}: unknown oracle field ${key}`);
  for (const key of ["outputAnyOf", "outputAllOf", "commands"] as const) {
    if (o[key] !== undefined && (!isStringArray(o[key]) || (o[key] as string[]).length === 0)) {
      out.push(`${id}: oracle.${key} must be a non-empty string array`);
    }
  }
  if (o.files !== undefined) {
    const files = o.files as unknown;
    if (!Array.isArray(files) || files.length === 0) out.push(`${id}: oracle.files must be a non-empty array`);
    else
      for (const f of files as Array<Record<string, unknown>>) {
        if (typeof f?.path !== "string" || typeof f?.pattern !== "string") {
          out.push(`${id}: oracle.files entries need path and pattern`);
          continue;
        }
        try {
          new RegExp(f.pattern);
        } catch {
          out.push(`${id}: oracle.files pattern is not a valid regex: ${f.pattern}`);
        }
      }
  }
  if (o.overlayFrom !== undefined) {
    const ov = o.overlayFrom as Record<string, unknown>;
    if (typeof ov?.commit !== "string" || !isStringArray(ov?.paths)) out.push(`${id}: oracle.overlayFrom needs commit and paths`);
    if (o.commands === undefined) out.push(`${id}: oracle.overlayFrom without commands judges nothing`);
  }
  if (o.refusal !== undefined) {
    const r = o.refusal as Record<string, unknown>;
    if (!isStringArray(r?.signals) || r.signals.length === 0) out.push(`${id}: oracle.refusal.signals must be a non-empty string array`);
  }
  if (Object.keys(o).length === 0) out.push(`${id}: empty oracle judges nothing`);
  return out;
}

const COHORTS: readonly EffTaskCohort[] = ["repetition", "regular", "complex", "failure"];

/**
 * Parse corpus JSONL content and enforce the §24 composition. Any structural
 * problem (bad cohort, duplicate id, empty text, wrong cohort count) is a
 * violation — a benchmark over a malformed corpus measures nothing.
 */
export function parseEffTaskCorpus(content: string): { tasks: EffTask[]; violations: string[] } {
  const { tasks, violations, counts } = parseTaskLines(content);
  violations.push(...compositionViolations(counts, COHORT_COMPOSITION));
  return { tasks, violations };
}

function compositionViolations(counts: Record<EffTaskCohort, number>, expected: Record<EffTaskCohort, number>): string[] {
  return COHORTS.filter((cohort) => counts[cohort] !== expected[cohort]).map(
    (cohort) => `composition: ${cohort} has ${counts[cohort]} tasks, expected ${expected[cohort]}`
  );
}

const SAFE_REL_PATH = /^(?![/\\])(?![A-Za-z]:)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[^\0]+$/;

function refViolations(id: string, refs: unknown, absentRefs: unknown): string[] {
  const out: string[] = [];
  if (refs !== undefined) {
    if (!Array.isArray(refs)) out.push(`${id}: refs must be an array`);
    else
      for (const ref of refs as Array<Record<string, unknown>>) {
        if (typeof ref?.path !== "string" || !SAFE_REL_PATH.test(ref.path)) out.push(`${id}: refs entries need a repo-relative path`);
        if (ref?.symbol !== undefined && (typeof ref.symbol !== "string" || ref.symbol.length === 0)) out.push(`${id}: refs symbol must be a non-empty string`);
      }
  }
  if (absentRefs !== undefined) {
    if (!Array.isArray(absentRefs) || absentRefs.length === 0) out.push(`${id}: absentRefs must be a non-empty array`);
    else
      for (const ref of absentRefs as Array<Record<string, unknown>>) {
        const hasPath = typeof ref?.path === "string" && SAFE_REL_PATH.test(ref.path);
        const hasText = typeof ref?.text === "string" && ref.text.length > 0;
        if (!hasPath && !hasText) out.push(`${id}: absentRefs entries need a repo-relative path and/or text`);
      }
  }
  return out;
}

function parseTaskLines(content: string): { tasks: EffTask[]; violations: string[]; counts: Record<EffTaskCohort, number> } {
  const violations: string[] = [];
  const tasks: EffTask[] = [];
  const seenIds = new Set<string>();
  const counts: Record<EffTaskCohort, number> = { repetition: 0, regular: 0, complex: 0, failure: 0 };

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: Partial<EffTask>;
    try {
      parsed = JSON.parse(line) as Partial<EffTask>;
    } catch {
      violations.push(`line ${i + 1}: not valid JSON`);
      continue;
    }
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      violations.push(`line ${i + 1}: id required`);
      continue;
    }
    if (seenIds.has(parsed.id)) {
      violations.push(`line ${i + 1}: duplicate id ${parsed.id}`);
      continue;
    }
    seenIds.add(parsed.id);
    if (!COHORTS.includes(parsed.cohort as EffTaskCohort)) {
      violations.push(`${parsed.id}: unknown cohort ${String(parsed.cohort)}`);
      continue;
    }
    if (typeof parsed.text !== "string" || parsed.text.trim().length < 8) {
      violations.push(`${parsed.id}: text too short to be a real task`);
      continue;
    }
    if (parsed.oracle !== undefined) {
      const bad = oracleViolations(parsed.id, parsed.oracle);
      if (bad.length > 0) {
        violations.push(...bad);
        continue;
      }
    }
    if (parsed.guards !== undefined && (!isStringArray(parsed.guards) || parsed.guards.length === 0)) {
      violations.push(`${parsed.id}: guards must be a non-empty string array`);
      continue;
    }
    if (parsed.category !== undefined && !isTraceTaskCategory(parsed.category)) {
      violations.push(`${parsed.id}: category "${String(parsed.category)}" is not a trace-v1 category`);
      continue;
    }
    if (parsed.baseCommit !== undefined && (typeof parsed.baseCommit !== "string" || parsed.baseCommit.length === 0)) {
      violations.push(`${parsed.id}: baseCommit must be a non-empty git revision`);
      continue;
    }
    const badRefs = refViolations(parsed.id, parsed.refs, parsed.absentRefs);
    if (badRefs.length > 0) {
      violations.push(...badRefs);
      continue;
    }
    const task: EffTask = {
      id: parsed.id,
      cohort: parsed.cohort as EffTaskCohort,
      category: parsed.category ?? "query",
      source: parsed.source ?? "authored",
      text: parsed.text,
      ...(parsed.notes ? { notes: parsed.notes } : {}),
      ...(parsed.baseCommit ? { baseCommit: parsed.baseCommit } : {}),
      ...(parsed.oracle ? { oracle: parsed.oracle } : {}),
      ...(parsed.guards ? { guards: parsed.guards } : {}),
      ...(parsed.dataset !== undefined ? { dataset: parsed.dataset } : {}),
      ...(parsed.family !== undefined ? { family: parsed.family } : {}),
      ...(parsed.variant !== undefined ? { variant: parsed.variant } : {}),
      ...(parsed.refs !== undefined ? { refs: parsed.refs } : {}),
      ...(parsed.absentRefs !== undefined ? { absentRefs: parsed.absentRefs } : {}),
    };
    counts[task.cohort] += 1;
    tasks.push(task);
  }
  return { tasks, violations, counts };
}

const HEX_REV = /^[0-9a-f]{7,40}$/;

/** Output needles the task text already contains would pass for an agent that merely echoes the prompt. */
function echoViolations(where: string, text: string, oracle: EffTaskOracle | undefined): string[] {
  const lower = text.toLowerCase();
  const needles = [...(oracle?.outputAnyOf ?? []), ...(oracle?.outputAllOf ?? []), ...(oracle?.refusal?.signals ?? [])];
  return needles.filter((n) => lower.includes(n.toLowerCase())).map((n) => `${where}: output needle "${n}" appears in the task text (echoing the prompt would pass)`);
}

/**
 * Golden-Extended gate (§18, nightly): exact 60/80/45/15 composition, every
 * trace category exercised, paraphrase families that really are paraphrases
 * (same category, same oracle), refusal oracles on every deliberate failure,
 * pinned base commits and declared repo references. Path/symbol existence is
 * checked against git by scripts/check-golden.mjs.
 */
export function parseGoldenExtendedCorpus(content: string): { tasks: EffTask[]; violations: string[] } {
  const { tasks, violations, counts } = parseTaskLines(content);
  violations.push(...compositionViolations(counts, EXTENDED_COMPOSITION));

  const categoryCounts = new Map<string, number>();
  const families = new Map<string, EffTask[]>();
  let unjudged = 0;
  for (const task of tasks) {
    categoryCounts.set(task.category, (categoryCounts.get(task.category) ?? 0) + 1);
    if (task.dataset !== EXTENDED_DATASET_ID) violations.push(`${task.id}: dataset must be "${EXTENDED_DATASET_ID}"`);
    violations.push(...echoViolations(task.id, task.text, task.oracle));
    if (!task.baseCommit || !HEX_REV.test(task.baseCommit)) violations.push(`${task.id}: baseCommit must be a pinned hex revision`);
    if (task.cohort === "repetition") {
      if (typeof task.family !== "string" || task.family.length === 0) violations.push(`${task.id}: repetition tasks need a family id`);
      else families.set(task.family, [...(families.get(task.family) ?? []), task]);
      if (!Number.isInteger(task.variant) || (task.variant ?? 0) < 1) violations.push(`${task.id}: repetition tasks need a positive integer variant`);
    } else if (task.family !== undefined || task.variant !== undefined) {
      violations.push(`${task.id}: only repetition tasks belong to a paraphrase family`);
    }
    if (task.cohort === "failure") {
      if (task.category !== "deliberate-failure") violations.push(`${task.id}: failure tasks use category deliberate-failure`);
      if (!task.oracle?.refusal || task.oracle.refusal.noChanges !== true) violations.push(`${task.id}: failure tasks need a refusal oracle with noChanges`);
      if (!task.absentRefs || task.absentRefs.length === 0) violations.push(`${task.id}: failure tasks must declare what is absent (absentRefs)`);
    } else {
      if (task.category === "deliberate-failure") violations.push(`${task.id}: deliberate-failure category outside the failure cohort`);
      if (!task.refs || task.refs.length === 0) violations.push(`${task.id}: non-failure tasks must declare the repo files they touch (refs)`);
    }
    if (!task.oracle) {
      unjudged += 1;
      const explained = task.cohort === "complex" && (task.guards?.length ?? 0) > 0 && /unjudged/i.test(task.notes ?? "");
      if (!explained) violations.push(`${task.id}: no oracle; only guarded complex tasks marked unjudged may skip judging`);
    }
  }
  for (const category of TRACE_TASK_CATEGORIES) {
    const n = categoryCounts.get(category) ?? 0;
    if (n < EXTENDED_MIN_PER_CATEGORY) violations.push(`composition: category ${category} has ${n} tasks, expected >= ${EXTENDED_MIN_PER_CATEGORY}`);
  }
  if (unjudged > EXTENDED_MAX_UNJUDGED) violations.push(`composition: ${unjudged} unjudged tasks, at most ${EXTENDED_MAX_UNJUDGED} allowed`);
  for (const [family, members] of families) {
    if (members.length < 2) violations.push(`family ${family}: a paraphrase family needs at least 2 members`);
    const first = members[0]!;
    const variants = new Set<number>();
    const texts = new Set<string>();
    for (const member of members) {
      if (member.category !== first.category) violations.push(`family ${family}: ${member.id} category differs from ${first.id}`);
      if (JSON.stringify(member.oracle) !== JSON.stringify(first.oracle)) violations.push(`family ${family}: ${member.id} oracle differs from ${first.id}`);
      if ((member.baseCommit ?? "") !== (first.baseCommit ?? "")) violations.push(`family ${family}: ${member.id} baseCommit differs from ${first.id}`);
      if (member.variant !== undefined && variants.has(member.variant)) violations.push(`family ${family}: duplicate variant ${member.variant}`);
      if (member.variant !== undefined) variants.add(member.variant);
      if (texts.has(member.text)) violations.push(`family ${family}: ${member.id} repeats a text verbatim (paraphrases must differ)`);
      texts.add(member.text);
    }
  }
  return { tasks, violations };
}

// ---------------------------------------------------------------- long-horizon

export type LongHorizonReuse = "fresh" | "reuse-allowed" | "must-refresh";

/**
 * What the efficiency layer should do at this step. `reuse`: fresh = nothing
 * equivalent ran before; reuse-allowed = `equivalentTo` produced an equivalent
 * result and nothing changed since; must-refresh = an equivalent result exists
 * but a later step changed the workspace, so replaying it would be stale.
 * `memory: required` = the step only makes sense with an earlier step's
 * decision or artifact (listed in `dependsOn`).
 */
export interface LongHorizonStepExpect {
  reuse: LongHorizonReuse;
  memory: "none" | "required";
  /** The step is expected to modify the workspace. */
  stateChange: boolean;
}

export interface LongHorizonStep {
  id: string;
  step: number;
  /** Agent session the step belongs to; a new number = a fresh executor with no conversation memory. */
  session: number;
  category: string;
  text: string;
  dependsOn: string[];
  equivalentTo?: string;
  expect: LongHorizonStepExpect;
  oracle: EffTaskOracle;
  guards?: string[];
  notes?: string;
}

export interface LongHorizonSession {
  id: string;
  dataset: string;
  template: string;
  title: string;
  baseCommit: string;
  refs: EffTaskRef[];
  steps: LongHorizonStep[];
}

const REUSE_VALUES: readonly LongHorizonReuse[] = ["fresh", "reuse-allowed", "must-refresh"];

function stepViolations(session: LongHorizonSession, raw: unknown, index: number, seen: Map<string, LongHorizonStep>): string[] {
  const where = `${session.id} step[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [`${where}: step must be an object`];
  const s = raw as Partial<LongHorizonStep>;
  const out: string[] = [];
  if (s.step !== index + 1) out.push(`${where}: step number must be ${index + 1} (steps are ordered and contiguous)`);
  if (s.id !== `${session.id}-s${index + 1}`) out.push(`${where}: id must be ${session.id}-s${index + 1}`);
  if (!Number.isInteger(s.session) || (s.session ?? 0) < 1) out.push(`${where}: session must be a positive integer`);
  if (!isTraceTaskCategory(s.category)) out.push(`${where}: category "${String(s.category)}" is not a trace-v1 category`);
  if (s.category === "deliberate-failure") out.push(`${where}: long-horizon steps are not deliberate failures`);
  if (typeof s.text !== "string" || s.text.trim().length < 8) out.push(`${where}: text too short to be a real task`);
  if (s.oracle === undefined) out.push(`${where}: every long-horizon step is judged (oracle required)`);
  else out.push(...oracleViolations(where, s.oracle), ...echoViolations(where, typeof s.text === "string" ? s.text : "", s.oracle));
  if (s.guards !== undefined && (!isStringArray(s.guards) || s.guards.length === 0)) out.push(`${where}: guards must be a non-empty string array`);
  const expect = s.expect as Partial<LongHorizonStepExpect> | undefined;
  if (!expect || !REUSE_VALUES.includes(expect.reuse as LongHorizonReuse) || (expect.memory !== "none" && expect.memory !== "required") || typeof expect.stateChange !== "boolean") {
    out.push(`${where}: expect needs reuse (fresh|reuse-allowed|must-refresh), memory (none|required) and stateChange (boolean)`);
    return out;
  }
  const deps = s.dependsOn;
  if (!isStringArray(deps)) out.push(`${where}: dependsOn must be a string array`);
  else {
    for (const dep of deps) if (!seen.has(dep)) out.push(`${where}: dependsOn ${dep} is not an earlier step of ${session.id}`);
    if ((expect.memory === "required") !== deps.length > 0) out.push(`${where}: memory "required" iff dependsOn is non-empty`);
  }
  if (expect.reuse === "fresh") {
    if (s.equivalentTo !== undefined) out.push(`${where}: a fresh step has no equivalentTo`);
  } else {
    const eq = typeof s.equivalentTo === "string" ? seen.get(s.equivalentTo) : undefined;
    if (!eq) out.push(`${where}: ${expect.reuse} needs equivalentTo = an earlier step of ${session.id}`);
    else {
      const between = [...seen.values()].filter((p) => p.step > eq.step);
      const changed = between.some((p) => p.expect.stateChange);
      if (expect.reuse === "reuse-allowed" && changed) out.push(`${where}: reuse-allowed but a step after ${eq.id} changed the workspace`);
      if (expect.reuse === "must-refresh" && !changed) out.push(`${where}: must-refresh but no step after ${eq.id} changed the workspace`);
    }
  }
  return out;
}

/**
 * Long-Horizon gate (§18): exactly 20 sessions of 3-8 ordered steps that span
 * at least two agent sessions, with consistent memory/reuse expectations
 * (dependsOn and equivalentTo only point backwards; reuse-allowed and
 * must-refresh agree with the stateChange steps in between).
 */
export function parseLongHorizonCorpus(content: string): { sessions: LongHorizonSession[]; violations: string[] } {
  const violations: string[] = [];
  const sessions: LongHorizonSession[] = [];
  const seenIds = new Set<string>();
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: Partial<LongHorizonSession>;
    try {
      parsed = JSON.parse(line) as Partial<LongHorizonSession>;
    } catch {
      violations.push(`line ${i + 1}: not valid JSON`);
      continue;
    }
    if (typeof parsed.id !== "string" || !/^lh-\d{3}$/.test(parsed.id)) {
      violations.push(`line ${i + 1}: session id must look like lh-001`);
      continue;
    }
    if (seenIds.has(parsed.id)) {
      violations.push(`line ${i + 1}: duplicate session id ${parsed.id}`);
      continue;
    }
    seenIds.add(parsed.id);
    const before = violations.length;
    if (parsed.dataset !== LONG_HORIZON_DATASET_ID) violations.push(`${parsed.id}: dataset must be "${LONG_HORIZON_DATASET_ID}"`);
    if (typeof parsed.baseCommit !== "string" || !HEX_REV.test(parsed.baseCommit)) violations.push(`${parsed.id}: baseCommit must be a pinned hex revision`);
    if (typeof parsed.template !== "string" || parsed.template.length === 0) violations.push(`${parsed.id}: template required`);
    if (typeof parsed.title !== "string" || parsed.title.trim().length < 8) violations.push(`${parsed.id}: title required`);
    if (!Array.isArray(parsed.refs) || parsed.refs.length === 0) violations.push(`${parsed.id}: refs must list the repo files the session works on`);
    else violations.push(...refViolations(parsed.id, parsed.refs, undefined));
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    if (steps.length < LONG_HORIZON_STEP_BOUNDS.min || steps.length > LONG_HORIZON_STEP_BOUNDS.max) {
      violations.push(`${parsed.id}: ${steps.length} steps, expected ${LONG_HORIZON_STEP_BOUNDS.min}-${LONG_HORIZON_STEP_BOUNDS.max}`);
    }
    const session = parsed as LongHorizonSession;
    const seen = new Map<string, LongHorizonStep>();
    let previousSession = 0;
    steps.forEach((raw, index) => {
      const bad = stepViolations(session, raw, index, seen);
      violations.push(...bad);
      const step = raw as LongHorizonStep;
      if (Number.isInteger(step?.session)) {
        if (index === 0 && step.session !== 1) violations.push(`${parsed.id} step[0]: the first step opens session 1`);
        if (step.session < previousSession || step.session > previousSession + 1) {
          violations.push(`${parsed.id} step[${index}]: session numbers must be non-decreasing without gaps`);
        }
        previousSession = Math.max(previousSession, step.session);
      }
      if (bad.length === 0) seen.set(step.id, step);
    });
    const stepList = steps as LongHorizonStep[];
    if (new Set(stepList.map((s) => s?.session)).size < 2) violations.push(`${parsed.id}: a long-horizon session must span at least two agent sessions`);
    if (!stepList.some((s) => s?.expect?.memory === "required")) violations.push(`${parsed.id}: needs at least one memory-dependent step`);
    if (!stepList.some((s) => s?.expect?.reuse === "reuse-allowed" || s?.expect?.reuse === "must-refresh")) {
      violations.push(`${parsed.id}: needs at least one step that revisits earlier work (reuse-allowed or must-refresh)`);
    }
    if (violations.length === before) sessions.push(session);
  }
  if (seenIds.size !== LONG_HORIZON_SESSIONS) violations.push(`composition: ${seenIds.size} sessions, expected ${LONG_HORIZON_SESSIONS}`);
  const allSteps = sessions.flatMap((s) => s.steps);
  for (const reuse of REUSE_VALUES) {
    if (!allSteps.some((s) => s.expect.reuse === reuse)) violations.push(`composition: no step expects reuse "${reuse}"`);
  }
  return { sessions, violations };
}

// ---------------------------------------------------------------- dataset dispatch

export type ParsedBenchDataset =
  | { kind: "golden-core"; tasks: EffTask[]; violations: string[] }
  | { kind: "golden-extended"; tasks: EffTask[]; violations: string[] }
  | { kind: "long-horizon"; sessions: LongHorizonSession[]; violations: string[] };

/**
 * Pick the gate from the content: a line with `steps` is a long-horizon
 * session file, `dataset: golden-extended-v1` is the extended corpus, anything
 * else is held to the golden-v1 (Golden-Core 50) composition.
 */
export function parseBenchDataset(content: string): ParsedBenchDataset {
  const first = content.split("\n").find((line) => line.trim().length > 0);
  let head: Record<string, unknown> = {};
  try {
    head = first ? (JSON.parse(first) as Record<string, unknown>) : {};
  } catch {
    // Fall through: the golden-core parser reports the bad line.
  }
  if (Array.isArray(head.steps) || head.dataset === LONG_HORIZON_DATASET_ID) {
    return { kind: "long-horizon", ...parseLongHorizonCorpus(content) };
  }
  if (head.dataset === EXTENDED_DATASET_ID) return { kind: "golden-extended", ...parseGoldenExtendedCorpus(content) };
  return { kind: "golden-core", ...parseEffTaskCorpus(content) };
}
