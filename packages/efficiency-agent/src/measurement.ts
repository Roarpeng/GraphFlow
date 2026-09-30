/**
 * Measurement contract (2.x groundwork, item 2): every cost-bearing number in
 * a benchmark trace carries its provenance. A/B comparisons are only as
 * trustworthy as their weakest input, so the contract makes "where did this
 * number come from" a structural property, not a footnote.
 *
 * Rules (enforced by validateMeasurement / validateTraceProvenance):
 *  R1  Cost-bearing fields are `Measurement`, never bare numbers.
 *  R2  "measured" — read directly from an instrument (provider usage API,
 *      wall clock). No method string required, no confidence allowed (an
 *      instrument reading is not a belief).
 *  R3  "estimated" — derived by a stated formula; `method` is REQUIRED
 *      (e.g. "chars/4"), optional confidence 0..1.
 *  R4  "proxy" — stands in for an unavailable direct signal (e.g. token
 *      counts from host telemetry instead of provider usage); `method` is
 *      REQUIRED, confidence RECOMMENDED.
 *  R5  Aggregates inherit the WEAKEST provenance of their inputs
 *      (measured > estimated > proxy).
 *  R6  A trace with provenance violations is not comparable — the comparator
 *      refuses it rather than averaging apples with radiocarbon dates.
 */

export type Provenance = "measured" | "estimated" | "proxy";

export interface Measurement {
  value: number;
  provenance: Provenance;
  /** Required for estimated/proxy: how the value was obtained. */
  method?: string;
  /** 0..1 belief in the value. Only meaningful for estimated/proxy. */
  confidence?: number;
}

const PROVENANCE_STRENGTH: Record<Provenance, number> = {
  measured: 2,
  estimated: 1,
  proxy: 0,
};

export function isStrongerOrEqual(a: Provenance, b: Provenance): boolean {
  return PROVENANCE_STRENGTH[a] >= PROVENANCE_STRENGTH[b];
}

/** R5: the weakest provenance among the inputs is what the aggregate may claim. */
export function weakestProvenance(values: readonly Provenance[]): Provenance {
  let weakest: Provenance = "measured";
  for (const value of values) {
    if (PROVENANCE_STRENGTH[value] < PROVENANCE_STRENGTH[weakest]) {
      weakest = value;
    }
  }
  return weakest;
}

/** Combine measurements into one whose value is the sum and provenance the weakest. */
export function sumMeasurements(values: readonly Measurement[], method: string): Measurement {
  const value = values.reduce((acc, m) => acc + m.value, 0);
  return { value, provenance: weakestProvenance(values.map((m) => m.provenance)), method };
}

export function measured(value: number): Measurement {
  return { value, provenance: "measured" };
}

export function estimated(value: number, method: string, confidence?: number): Measurement {
  return { value, provenance: "estimated", method, ...(confidence !== undefined ? { confidence } : {}) };
}

export function proxy(value: number, method: string, confidence?: number): Measurement {
  return { value, provenance: "proxy", method, ...(confidence !== undefined ? { confidence } : {}) };
}

/** R2–R4 for one measurement. Returns violation strings (empty = clean). */
export function validateMeasurement(
  field: string,
  m: Measurement
): string[] {
  const violations: string[] = [];
  if (!Number.isFinite(m.value)) {
    violations.push(`${field}: value is not a finite number`);
  }
  if (m.provenance === "measured") {
    if (m.method !== undefined) {
      violations.push(`${field}: measured values do not carry a method`);
    }
    if (m.confidence !== undefined) {
      violations.push(`${field}: measured values do not carry confidence`);
    }
  } else {
    if (typeof m.method !== "string" || m.method.trim().length === 0) {
      violations.push(`${field}: ${m.provenance} values require a method string`);
    }
    if (m.confidence !== undefined && (m.confidence < 0 || m.confidence > 1)) {
      violations.push(`${field}: confidence must be within 0..1`);
    }
  }
  return violations;
}
