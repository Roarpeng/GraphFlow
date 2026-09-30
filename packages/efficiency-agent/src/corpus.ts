/**
 * Benchmark task corpus (2.x plan §24): 50 real tasks in four cohorts —
 * 20 high-repetition (same shape, different parameters; ADAPT/cache
 * candidates), 15 regular modifications, 10 complex cross-module tasks, and
 * 5 deliberate failures (FRESH / invalidation / safety probes).
 *
 * The corpus ships as JSONL data (benchmarks/eff-tasks-v1.jsonl); this module
 * owns the parser and the composition gate. Regular-cohort texts are derived
 * from this repository's real git history (source field carries the commit).
 */

export type EffTaskCohort = "repetition" | "regular" | "complex" | "failure";

export const COHORT_COMPOSITION: Record<EffTaskCohort, number> = {
  repetition: 20,
  regular: 15,
  complex: 10,
  failure: 5,
};

export interface EffTask {
  id: string;
  cohort: EffTaskCohort;
  category: string;
  source: string;
  text: string;
  notes?: string;
}

const COHORTS: readonly EffTaskCohort[] = ["repetition", "regular", "complex", "failure"];

/**
 * Parse corpus JSONL content and enforce the §24 composition. Any structural
 * problem (bad cohort, duplicate id, empty text, wrong cohort count) is a
 * violation — a benchmark over a malformed corpus measures nothing.
 */
export function parseEffTaskCorpus(content: string): { tasks: EffTask[]; violations: string[] } {
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
    const task: EffTask = {
      id: parsed.id,
      cohort: parsed.cohort as EffTaskCohort,
      category: parsed.category ?? "query",
      source: parsed.source ?? "authored",
      text: parsed.text,
      ...(parsed.notes ? { notes: parsed.notes } : {}),
    };
    counts[task.cohort] += 1;
    tasks.push(task);
  }

  for (const cohort of COHORTS) {
    if (counts[cohort] !== COHORT_COMPOSITION[cohort]) {
      violations.push(
        `composition: ${cohort} has ${counts[cohort]} tasks, expected ${COHORT_COMPOSITION[cohort]}`
      );
    }
  }
  return { tasks, violations };
}
