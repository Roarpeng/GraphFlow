/**
 * Efficiency-for-efficiency reinvestment (SoL-Pi closeout, R6 final item).
 *
 * SoL-Pi's closing loop: mechanisms admitted under a capability floor produce
 * real token savings, and a share of those savings is reinvested as search
 * budget so the auto-research loop can afford MORE mechanism trials. GraphFlow
 * reproduces this within its boundary: it never executes trials itself — it
 * keeps an append-only ledger that converts qualifying paired savings into a
 * verifiable trial budget plus the next-trial suggestions (advisory only).
 *
 * Honesty rules carried over from the capability floor:
 *  - only QUALIFYING comparisons count (no-efficiency-gain and capability
 *    regressions never fund the search that would validate them);
 *  - every efficiency.json record can fund the budget exactly once (receipt
 *    fingerprints are consumed on --apply);
 *  - disabled by config ⇒ budget 0, suggestions empty, no ledger writes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GraphFlowConfig } from "../config/schema";
import type {
  EfficiencyComparisonRecord,
  EfficiencyReport,
} from "./efficiency-report";
import type { MechanismReport } from "./mechanism-research";

export interface ReinvestEfficiencyConfig {
  enabled?: boolean;
  /** Share of new qualifying savings convertible to search budget. 0..1. */
  ratio?: number;
  /** Upper bound on the per-round budget derived from savings. */
  maxBudgetTokens?: number;
  /** Assumed cost of one mechanism trial (in-trajectory or held-out). */
  estimatedTrialTokens?: number;
}

export const DEFAULT_REINVEST_RATIO = 0.5;
export const DEFAULT_REINVEST_MAX_BUDGET_TOKENS = 200_000;
export const DEFAULT_REINVEST_ESTIMATED_TRIAL_TOKENS = 4_000;

export interface ReinvestLedger {
  schemaVersion: 1;
  /** Receipt fingerprints of efficiency records already converted to budget. */
  consumedFingerprints: string[];
  /** Cumulative budget unlocked by past applications. */
  appliedBudgetTokens: number;
  lastAppliedAt?: string;
}

export interface ReinvestSuggestion {
  mechanismId: string;
  status: string;
  /** The trial phase the mechanism can legally record next. */
  phase: "in-trajectory" | "held-out";
}

export interface ReinvestPlan {
  enabled: boolean;
  /** Absolute token savings across all qualifying records (lifetime). */
  qualifyingSavingsTokens: number;
  /** Savings from qualifying records not yet converted to budget. */
  newSavingsTokens: number;
  ratio: number;
  /** Budget after applying the ratio, before the cap. */
  grossBudgetTokens: number;
  budgetTokens: number;
  cappedBy: "ratio" | "max-budget" | null;
  estimatedTrialTokens: number;
  estimatedTrials: number;
  suggestions: ReinvestSuggestion[];
}

function emptyLedger(): ReinvestLedger {
  return { schemaVersion: 1, consumedFingerprints: [], appliedBudgetTokens: 0 };
}

/** Stable receipt fingerprint for one efficiency record. */
export function recordFingerprint(record: EfficiencyComparisonRecord): string {
  return [record.query, record.timestamp, record.episodeId ?? "", record.mechanismId ?? ""]
    .map((part) => String(part))
    .join("|");
}

function absoluteSavingTokens(record: EfficiencyComparisonRecord): number {
  if (!record.qualifies) return 0;
  const baseline = Math.max(0, Number.isFinite(record.baseline?.tokens) ? record.baseline.tokens : 0);
  const packaged = Math.max(0, Number.isFinite(record.packaged?.tokens) ? record.packaged.tokens : 0);
  return Math.max(0, baseline - packaged);
}

function toFiniteNonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Pure planning step: derive the next search budget from the paired report and
 * the ledger, and suggest which mechanisms the budget should fund. Advisory
 * only — trial execution always stays with the host/operator.
 */
export function planReinvestment(
  report: EfficiencyReport,
  ledger: ReinvestLedger,
  options: {
    config?: ReinvestEfficiencyConfig;
    mechanismReport?: Pick<MechanismReport, "mechanisms">;
  } = {}
): ReinvestPlan {
  const cfg = options.config ?? {};
  const enabled = cfg.enabled !== false;
  const ratio = Math.min(Math.max(toFiniteNonNegative(cfg.ratio, DEFAULT_REINVEST_RATIO), 0), 1);
  const maxBudgetTokens = toFiniteNonNegative(cfg.maxBudgetTokens, DEFAULT_REINVEST_MAX_BUDGET_TOKENS);
  const estimatedTrialTokens = Math.max(
    1,
    Math.round(toFiniteNonNegative(cfg.estimatedTrialTokens, DEFAULT_REINVEST_ESTIMATED_TRIAL_TOKENS))
  );

  const consumed = new Set(ledger.consumedFingerprints);
  let qualifyingSavingsTokens = 0;
  let newSavingsTokens = 0;
  const newFingerprints: string[] = [];
  for (const record of report.recentRecords ?? []) {
    const saving = absoluteSavingTokens(record);
    if (saving <= 0) continue;
    qualifyingSavingsTokens += saving;
    const fingerprint = recordFingerprint(record);
    if (consumed.has(fingerprint)) continue;
    newSavingsTokens += saving;
    newFingerprints.push(fingerprint);
  }

  const grossBudgetTokens = Math.round(newSavingsTokens * ratio);
  const cappedBy: ReinvestPlan["cappedBy"] = !enabled
    ? null
    : grossBudgetTokens > maxBudgetTokens
      ? "max-budget"
      : "ratio";
  const budgetTokens = enabled ? Math.min(grossBudgetTokens, maxBudgetTokens) : 0;
  const estimatedTrials = Math.floor(budgetTokens / estimatedTrialTokens);

  // Suggested next trials, cheapest first in evidence value: frozen mechanisms
  // are one held-out away from admission, in-trajectory mechanisms still gather
  // evidence, fresh proposals start their first in-trajectory arm. Admitted /
  // rejected mechanisms are terminal and never suggested.
  const candidates: ReinvestSuggestion[] = [];
  for (const mechanism of options.mechanismReport?.mechanisms ?? []) {
    if (mechanism.status === "frozen" || mechanism.status === "held-out") {
      candidates.push({ mechanismId: mechanism.id, status: mechanism.status, phase: "held-out" });
    } else if (mechanism.status === "in-trajectory" || mechanism.status === "proposed") {
      candidates.push({ mechanismId: mechanism.id, status: mechanism.status, phase: "in-trajectory" });
    }
  }
  const order: Record<string, number> = { frozen: 0, "held-out": 0, "in-trajectory": 1, proposed: 2 };
  candidates.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  const suggestions = enabled ? candidates.slice(0, estimatedTrials) : [];

  return {
    enabled,
    qualifyingSavingsTokens,
    newSavingsTokens,
    ratio,
    grossBudgetTokens,
    budgetTokens,
    cappedBy,
    estimatedTrialTokens,
    estimatedTrials,
    suggestions,
  };
}

/** Fingerprints a dry-run plan would consume (kept internal to this module's callers). */
export function pendingFingerprints(
  report: EfficiencyReport,
  ledger: ReinvestLedger
): string[] {
  const consumed = new Set(ledger.consumedFingerprints);
  const pending: string[] = [];
  for (const record of report.recentRecords ?? []) {
    if (absoluteSavingTokens(record) <= 0) continue;
    const fingerprint = recordFingerprint(record);
    if (!consumed.has(fingerprint)) pending.push(fingerprint);
  }
  return pending;
}

export function resolveReinvestLedgerPath(config: GraphFlowConfig): string {
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  return join(root, "graphflow-out", "efficiency-reinvest.json");
}

export function loadReinvestLedger(path: string): ReinvestLedger {
  if (!existsSync(path)) return emptyLedger();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ReinvestLedger>;
    if (!Array.isArray(parsed.consumedFingerprints)) return emptyLedger();
    return {
      schemaVersion: 1,
      consumedFingerprints: parsed.consumedFingerprints,
      appliedBudgetTokens: toFiniteNonNegative(parsed.appliedBudgetTokens, 0),
      ...(typeof parsed.lastAppliedAt === "string" ? { lastAppliedAt: parsed.lastAppliedAt } : {}),
    };
  } catch {
    return emptyLedger();
  }
}

function saveLedger(path: string, ledger: ReinvestLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2), "utf8");
}

export interface ReinvestApplyResult {
  plan: ReinvestPlan;
  ledger: ReinvestLedger;
  path: string;
  /** Budget tokens actually unlocked by this application (0 on dry-run/no-op). */
  appliedBudgetTokens: number;
  dryRun: boolean;
}

/**
 * Convert the plan into ledger state. Dry-run never writes; an apply with no
 * pending savings is a no-op (idempotent by fingerprint).
 */
export function applyReinvestment(
  config: GraphFlowConfig,
  report: EfficiencyReport,
  options: {
    reinvestConfig?: ReinvestEfficiencyConfig;
    apply?: boolean;
    now?: string;
  } = {}
): ReinvestApplyResult {
  const path = resolveReinvestLedgerPath(config);
  const ledger = loadReinvestLedger(path);
  const plan = planReinvestment(report, ledger, {
    ...(options.reinvestConfig !== undefined ? { config: options.reinvestConfig } : {}),
  });
  if (!options.apply || !plan.enabled || plan.newSavingsTokens <= 0) {
    return { plan, ledger, path, appliedBudgetTokens: 0, dryRun: !options.apply };
  }
  const pending = pendingFingerprints(report, ledger);
  const next: ReinvestLedger = {
    schemaVersion: 1,
    consumedFingerprints: [...ledger.consumedFingerprints, ...pending],
    appliedBudgetTokens: ledger.appliedBudgetTokens + plan.budgetTokens,
    lastAppliedAt: options.now ?? new Date().toISOString(),
  };
  saveLedger(path, next);
  return { plan, ledger: next, path, appliedBudgetTokens: plan.budgetTokens, dryRun: false };
}
