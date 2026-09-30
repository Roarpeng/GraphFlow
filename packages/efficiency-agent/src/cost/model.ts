import type { CostBreakdown } from "../domain.js";
import {
  type Measurement,
  type Provenance,
  measured,
  weakestProvenance,
} from "../measurement.js";

/** Method stamp for aggregate totals whose provenance is weaker than "measured". */
const AGGREGATE_METHOD = "sum-of-components";

/**
 * Aggregate named cost components into a CostBreakdown (2.x plan §20).
 *
 * Rules:
 *  - `total.value` is the plain sum of the component values.
 *  - `total.provenance` is the WEAKEST component provenance (R5): a cost that
 *    mixes one proxy number with nine measured ones is still a proxy cost.
 *  - `total` carries a method ("sum-of-components") ONLY when that provenance
 *    is not "measured" — measured aggregates keep the R2 rule that an
 *    instrument reading needs no derivation note.
 *  - Empty input aggregates to measured(0): nothing was spent, and "nothing"
 *    is an instrument fact, not an estimate.
 *
 * 输出与输入不共享对象引用（组件测量值浅拷贝），调用方可放心复用。
 * The `name` field is accepted for caller ergonomics (audit lines, fixtures)
 * even though CostBreakdown itself stores plain measurements.
 */
export function buildCost(
  components: ReadonlyArray<{ name: string; measurement: Measurement }>
): CostBreakdown {
  const parts: Measurement[] = components.map((component) => ({
    ...component.measurement,
  }));
  if (parts.length === 0) {
    return { components: [], total: measured(0) };
  }
  const provenance = weakestProvenance(parts.map((part) => part.provenance));
  const total: Measurement = {
    value: parts.reduce((sum, part) => sum + part.value, 0),
    provenance,
    ...(provenance !== "measured" ? { method: AGGREGATE_METHOD } : {}),
  };
  return { components: parts, total };
}

/**
 * Fixture helper: build a CostBreakdown from bare numbers.
 * 快捷夹具函数：由裸数字对直接构造成本汇总。
 *
 * Every component gets the given provenance; `method` is attached only when
 * the provenance requires one (R2 forbids methods on measured values), so
 * `costFromNumbers(pairs, "measured", "ignored")` still produces a clean
 * breakdown. The total follows buildCost's rules ("sum-of-components" when
 * the aggregated provenance is not "measured").
 */
export function costFromNumbers(
  pairs: ReadonlyArray<[string, number]>,
  provenance: Provenance,
  method: string
): CostBreakdown {
  return buildCost(
    pairs.map(([name, value]) => ({
      name,
      measurement: {
        value,
        provenance,
        ...(provenance !== "measured" ? { method } : {}),
      } satisfies Measurement,
    }))
  );
}
