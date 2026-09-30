/**
 * Tool Router (2.x plan §9) — the decision half of tool intelligence.
 * Given the needs of a task and the capability registry, pick one tool per
 * need: precision-adequate candidates (precision undefined or >= 0.8) win in
 * registry rank order; when nothing is adequate, fall back to the
 * highest-precision candidate rather than refusing the need. A need no
 * registered tool can serve is rejected with "no-capability". One tool may
 * satisfy several needs and is then selected exactly once.
 *
 * 工具路由（§9）：工具智能的决策侧。按需求从注册表选工具：精度达标
 * （未测或 >= 0.8）者按注册表排序优先；全部不达标时退回精度最高者，
 * 而不是拒绝需求。无人能服务的需求记 "no-capability"；同一工具满足
 * 多个需求时只选中一次。
 */

import type { ToolCapability, ToolRegistry } from "./capability-registry.js";

/** A need no registered tool could serve. */
export interface RejectedNeed {
  name: string;
  reason: string;
}

export interface ToolSelection {
  selected: ToolCapability[];
  rejected: RejectedNeed[];
}

/** Precision floor for "this tool's answers are trustworthy enough". */
const PRECISION_FLOOR = 0.8;

function isPrecisionAdequate(capability: ToolCapability): boolean {
  return capability.precision === undefined || capability.precision >= PRECISION_FLOOR;
}

/**
 * Highest measured precision, undefined counted as -Infinity. Only reached
 * when every candidate has precision < PRECISION_FLOOR (a defined value),
 * so the -Infinity case cannot win in practice — it just keeps the
 * comparator total.
 */
function pickHighestPrecision(candidates: readonly ToolCapability[]): ToolCapability {
  let best: ToolCapability | undefined;
  for (const candidate of candidates) {
    if (
      best === undefined ||
      (candidate.precision ?? Number.NEGATIVE_INFINITY) >
        (best.precision ?? Number.NEGATIVE_INFINITY)
    ) {
      best = candidate;
    }
  }
  if (best === undefined) {
    throw new Error("pickHighestPrecision requires at least one candidate");
  }
  return best;
}

export function routeTools(needs: string[], registry: ToolRegistry): ToolSelection {
  const selectedByName = new Map<string, ToolCapability>();
  const rejected: RejectedNeed[] = [];
  for (const need of needs) {
    const candidates = registry.byCapability(need);
    if (candidates.length === 0) {
      rejected.push({ name: need, reason: "no-capability" });
      continue;
    }
    const firstAdequate = candidates.filter(isPrecisionAdequate)[0];
    const chosen =
      firstAdequate !== undefined ? firstAdequate : pickHighestPrecision(candidates);
    if (!selectedByName.has(chosen.name)) {
      selectedByName.set(chosen.name, chosen);
    }
  }
  return { selected: [...selectedByName.values()], rejected };
}
