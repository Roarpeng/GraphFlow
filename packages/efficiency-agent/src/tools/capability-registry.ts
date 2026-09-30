/**
 * Tool Capability Registry (2.x plan §9) — the memory half of tool
 * intelligence. Every tool the efficiency layer may route to is described
 * by its capability tags, unit economics, precision, required context, and
 * an append-only success history. Selection order is a pure function of
 * that data: success rate first (attempts 0 = neutral 0.5), then latency,
 * then cost, then name.
 *
 * 工具能力注册表（§9）：工具智能的记忆侧。注册项描述能力标签、单位
 * 成本、精度、所需上下文与成功历史；排序是纯函数——成功率优先
 * （零样本记中性 0.5），其次延迟、成本、名称。
 *
 * Purity boundary: the registry stores private copies and hands out fresh
 * copies on every read — neither the caller nor the registry can mutate the
 * other's objects.
 */

/** Append-only outcome tally per tool. */
export interface ToolSuccessHistory {
  attempts: number;
  successes: number;
}

/** One tool's capability card. Mirrors schemas/tool-capability-v1.schema.json. */
export interface ToolCapability {
  name: string;
  /** Capability tags the router selects on ("search", "read-file", ...). */
  capabilities: string[];
  costPerCallUsd?: number;
  latencyMsP50?: number;
  /** 0..1 historical answer-acceptance rate; undefined = never measured. */
  precision?: number;
  /** Context keys that must be present before this tool is usable. */
  requiredContext: string[];
  successHistory: ToolSuccessHistory;
}

export interface ToolRegistry {
  /** Upsert by `capability.name`. The registry keeps its own copy. */
  register(capability: ToolCapability): void;
  /**
   * Tools declaring `needed`, ranked: success rate desc (attempts 0 → 0.5
   * neutral), latencyMsP50 asc (undefined last), costPerCallUsd asc
   * (undefined last), name asc.
   */
  byCapability(needed: string): ToolCapability[];
  /**
   * Record one routed outcome against the stored history. Unknown name is a
   * no-op returning false.
   */
  recordOutcome(name: string, success: boolean): boolean;
  /** All registered tools in registration order. */
  list(): ToolCapability[];
}

const NEUTRAL_SUCCESS_RATE = 0.5;

function cloneCapability(capability: ToolCapability): ToolCapability {
  return {
    name: capability.name,
    capabilities: [...capability.capabilities],
    ...(capability.costPerCallUsd !== undefined
      ? { costPerCallUsd: capability.costPerCallUsd }
      : {}),
    ...(capability.latencyMsP50 !== undefined
      ? { latencyMsP50: capability.latencyMsP50 }
      : {}),
    ...(capability.precision !== undefined ? { precision: capability.precision } : {}),
    requiredContext: [...capability.requiredContext],
    successHistory: { ...capability.successHistory },
  };
}

function successRate(capability: ToolCapability): number {
  const { attempts, successes } = capability.successHistory;
  return attempts === 0 ? NEUTRAL_SUCCESS_RATE : successes / attempts;
}

function compareNumbersAsc(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) {
    return 0;
  }
  if (a === undefined) {
    return 1;
  }
  if (b === undefined) {
    return -1;
  }
  return a - b;
}

/** UTF-16 code-unit order — environment-independent, unlike localeCompare. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rankCapabilities(a: ToolCapability, b: ToolCapability): number {
  return (
    successRate(b) - successRate(a) ||
    compareNumbersAsc(a.latencyMsP50, b.latencyMsP50) ||
    compareNumbersAsc(a.costPerCallUsd, b.costPerCallUsd) ||
    compareText(a.name, b.name)
  );
}

export function createToolRegistry(initial?: ToolCapability[]): ToolRegistry {
  const entries = new Map<string, ToolCapability>();
  if (initial !== undefined) {
    for (const capability of initial) {
      entries.set(capability.name, cloneCapability(capability));
    }
  }
  return {
    register(capability: ToolCapability): void {
      entries.set(capability.name, cloneCapability(capability));
    },
    byCapability(needed: string): ToolCapability[] {
      return [...entries.values()]
        .filter((capability) => capability.capabilities.includes(needed))
        .sort(rankCapabilities)
        .map(cloneCapability);
    },
    recordOutcome(name: string, success: boolean): boolean {
      const entry = entries.get(name);
      if (entry === undefined) {
        return false;
      }
      entry.successHistory = {
        attempts: entry.successHistory.attempts + 1,
        successes: entry.successHistory.successes + (success ? 1 : 0),
      };
      return true;
    },
    list(): ToolCapability[] {
      return [...entries.values()].map(cloneCapability);
    },
  };
}
