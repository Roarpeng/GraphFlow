/**
 * Paired efficiency report + capability floor (SoL-Pi capability-floor analog).
 *
 * SoL-Pi's central honesty rule: a token saving counts as efficiency only when
 * every capability metric stays within a predeclared tolerance AND at least one
 * efficiency metric improves. This module records PAIRED arms (baseline vs
 * packaged) for one task, persists them to graphflow-out/efficiency.json, and
 * exposes both the aggregate and the gate that governance release-gate uses.
 *
 * The response-count arm is the anti-"doing less" control: a token drop with a
 * response-count drop is a capability regression, not an efficiency gain.
 * Unmeasured arms are reported as unmeasured, never as zero.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GraphFlowConfig } from "../config/schema";
import type { ContextFidelityStats } from "../graph/token-savings";

export const DEFAULT_CAPABILITY_TOLERANCE = 0.05;
const MAX_RECENT_RECORDS = 50;

/** One measured arm of a paired comparison. Every metric except tokens may be absent. */
export interface EfficiencyArm {
  tokens: number;
  /** Model turns / steps. */
  turns?: number;
  /** Tool calls. */
  toolCalls?: number;
  /**
   * Model responses (or messages) produced by the arm. This is the control that
   * proves a token drop did not come from doing less work.
   */
  responseCount?: number;
  /** Normalized capability score; scale is task-defined but must be comparable across arms. */
  score?: number;
}

export interface EfficiencyComparisonInput {
  query: string;
  baseline: EfficiencyArm;
  packaged: EfficiencyArm;
  source?: "preview_context" | "run" | "benchmark";
  /** Linkage to the episode / mechanism under trial. */
  episodeId?: string;
  mechanismId?: string;
}

export interface EfficiencyComparisonRecord extends EfficiencyComparisonInput {
  timestamp: string;
  tokenSavingRatio: number;
  scoreDeltaRatio?: number;
  responseCountDeltaRatio?: number;
  turnDeltaRatio?: number;
  toolCallDeltaRatio?: number;
  /** True when capability stayed within tolerance and at least one efficiency metric improved. */
  qualifies: boolean;
  /** Machine-readable disqualification reasons; empty when qualifies. */
  reasons: string[];
}

export interface EfficiencyReport {
  totalComparisons: number;
  qualifying: number;
  disqualified: number;
  averageTokenSavingRatio: number;
  responseCountMeasured: number;
  averageResponseCountDeltaRatio: number | null;
  /** Comparisons whose capability (score or response count) regressed beyond tolerance. */
  capabilityRegressions: number;
  recentRecords: EfficiencyComparisonRecord[];
}

export interface EfficiencyFloorThresholds {
  /** Minimum qualifying paired comparisons. 0 = no requirement. */
  minQualifying?: number;
  /** Maximum allowed capability regressions. Default 0. */
  maxCapabilityRegressions?: number;
}

export interface FidelityFloorThresholds {
  /** Minimum average anchor recall percent when fidelity samples exist. Default 0. */
  minAnchorRecallPercent?: number;
  /** Minimum average body coverage percent when it was measured. Default 0. */
  minBodyCoveragePercent?: number;
}

export interface FloorCheck {
  name: string;
  actual: number;
  required?: number;
  maximum?: number;
}

export interface FloorResult {
  ok: boolean;
  checks: FloorCheck[];
  failures: string[];
}

function toFiniteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function deltaRatio(baseline: unknown, packaged: unknown): number | undefined {
  const base = toFiniteNonNegative(baseline);
  const next = toFiniteNonNegative(packaged);
  if (base === undefined || next === undefined) return undefined;
  if (base === 0) return next === 0 ? 0 : undefined;
  return (next - base) / base;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Evaluate one paired comparison. Pure and deterministic given the inputs and
 * an explicit timestamp. Disqualification reasons are exhaustive:
 *  - "no-efficiency-gain": tokens did not improve
 *  - "capability-regression:score": packaged score fell beyond tolerance
 *  - "capability-regression:response-count": packaged response count fell beyond tolerance
 */
export function evaluateEfficiencyComparison(
  input: EfficiencyComparisonInput,
  options: { now?: string; tolerance?: number } = {}
): EfficiencyComparisonRecord {
  const tolerance = clamp01(options.tolerance ?? DEFAULT_CAPABILITY_TOLERANCE);
  const reasons: string[] = [];

  const baselineTokens = toFiniteNonNegative(input.baseline.tokens) ?? 0;
  const packagedTokens = toFiniteNonNegative(input.packaged.tokens) ?? 0;
  const tokenSavingRatio = baselineTokens > 0 ? (baselineTokens - packagedTokens) / baselineTokens : 0;
  if (tokenSavingRatio <= 0) reasons.push("no-efficiency-gain");

  const scoreDeltaRatio = deltaRatio(input.baseline.score, input.packaged.score);
  if (scoreDeltaRatio !== undefined && scoreDeltaRatio < -tolerance) {
    reasons.push("capability-regression:score");
  }

  const responseCountDeltaRatio = deltaRatio(input.baseline.responseCount, input.packaged.responseCount);
  if (responseCountDeltaRatio !== undefined && responseCountDeltaRatio < -tolerance) {
    reasons.push("capability-regression:response-count");
  }

  const record: EfficiencyComparisonRecord = {
    ...input,
    timestamp: options.now ?? new Date().toISOString(),
    tokenSavingRatio: round(tokenSavingRatio),
    qualifies: reasons.length === 0,
    reasons,
  };
  if (scoreDeltaRatio !== undefined) record.scoreDeltaRatio = round(scoreDeltaRatio);
  if (responseCountDeltaRatio !== undefined) record.responseCountDeltaRatio = round(responseCountDeltaRatio);
  const turnDeltaRatio = deltaRatio(input.baseline.turns, input.packaged.turns);
  if (turnDeltaRatio !== undefined) record.turnDeltaRatio = round(turnDeltaRatio);
  const toolCallDeltaRatio = deltaRatio(input.baseline.toolCalls, input.packaged.toolCalls);
  if (toolCallDeltaRatio !== undefined) record.toolCallDeltaRatio = round(toolCallDeltaRatio);
  return record;
}

function emptyReport(): EfficiencyReport {
  return {
    totalComparisons: 0,
    qualifying: 0,
    disqualified: 0,
    averageTokenSavingRatio: 0,
    responseCountMeasured: 0,
    averageResponseCountDeltaRatio: null,
    capabilityRegressions: 0,
    recentRecords: [],
  };
}

export function resolveEfficiencyReportPath(config: GraphFlowConfig): string {
  const root = config.graphPolicy.workspaceRoot ?? process.cwd();
  return join(root, "graphflow-out", "efficiency.json");
}

function loadReport(reportPath: string): EfficiencyReport {
  if (!existsSync(reportPath)) return emptyReport();
  try {
    const parsed = JSON.parse(readFileSync(reportPath, "utf8")) as Partial<EfficiencyReport>;
    if (!Array.isArray(parsed.recentRecords)) return emptyReport();
    return { ...emptyReport(), ...parsed, recentRecords: parsed.recentRecords };
  } catch {
    return emptyReport();
  }
}

function saveReport(reportPath: string, report: EfficiencyReport): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
}

function recomputeReport(records: EfficiencyComparisonRecord[]): EfficiencyReport {
  const report = emptyReport();
  report.recentRecords = records;
  report.totalComparisons = records.length;
  report.qualifying = records.filter((record) => record.qualifies).length;
  report.disqualified = report.totalComparisons - report.qualifying;
  report.capabilityRegressions = records.filter((record) =>
    record.reasons.some((reason) => reason.startsWith("capability-regression:"))
  ).length;
  if (records.length > 0) {
    const total = records.reduce((sum, record) => sum + record.tokenSavingRatio, 0);
    report.averageTokenSavingRatio = round(total / records.length);
  }
  const responseDeltas = records
    .map((record) => record.responseCountDeltaRatio)
    .filter((value): value is number => typeof value === "number");
  report.responseCountMeasured = responseDeltas.length;
  report.averageResponseCountDeltaRatio =
    responseDeltas.length === 0
      ? null
      : round(responseDeltas.reduce((sum, value) => sum + value, 0) / responseDeltas.length);
  return report;
}

/** Append one paired comparison to graphflow-out/efficiency.json and return the recomputed report. */
export function recordEfficiencyComparison(
  config: GraphFlowConfig,
  input: EfficiencyComparisonInput,
  options: { now?: string; tolerance?: number } = {}
): { record: EfficiencyComparisonRecord; report: EfficiencyReport; path: string } {
  const record = evaluateEfficiencyComparison(input, options);
  const path = resolveEfficiencyReportPath(config);
  const report = loadReport(path);
  const records = [record, ...report.recentRecords].slice(0, MAX_RECENT_RECORDS);
  const next = recomputeReport(records);
  saveReport(path, next);
  return { record, report: next, path };
}

export function getEfficiencyReport(config: GraphFlowConfig): EfficiencyReport {
  return loadReport(resolveEfficiencyReportPath(config));
}

export function resetEfficiencyReport(config: GraphFlowConfig): { path: string; reset: boolean } {
  const path = resolveEfficiencyReportPath(config);
  if (!existsSync(path)) return { path, reset: false };
  saveReport(path, emptyReport());
  return { path, reset: true };
}

/** Capability floor over the paired report. Fails only on thresholds the caller sets. */
export function evaluateEfficiencyFloor(
  report: EfficiencyReport,
  thresholds: EfficiencyFloorThresholds = {}
): FloorResult {
  const minQualifying = thresholds.minQualifying ?? 0;
  const maxCapabilityRegressions = thresholds.maxCapabilityRegressions ?? 0;
  const checks: FloorCheck[] = [
    { name: "efficiency-qualifying", actual: report.qualifying, required: minQualifying },
    { name: "efficiency-capability-regressions", actual: report.capabilityRegressions, maximum: maxCapabilityRegressions },
  ];
  const failures = checks.flatMap((check) => {
    if (check.required !== undefined && check.actual < check.required) {
      return [check.name + ": " + check.actual + " < " + check.required];
    }
    if (check.maximum !== undefined && check.actual > check.maximum) {
      return [check.name + ": " + check.actual + " > " + check.maximum];
    }
    return [];
  });
  return { ok: failures.length === 0, checks, failures };
}

/**
 * Capability floor over context-fidelity stats. Anchors/body coverage are the
 * measurable capability metrics GraphFlow owns; a candidate that lowers them is
 * not allowed to count as an efficiency improvement.
 */
export function evaluateFidelityFloor(
  stats: ContextFidelityStats,
  thresholds: FidelityFloorThresholds = {}
): FloorResult {
  const minAnchorRecallPercent = thresholds.minAnchorRecallPercent ?? 0;
  const minBodyCoveragePercent = thresholds.minBodyCoveragePercent ?? 0;
  const checks: FloorCheck[] = [];
  const failures: string[] = [];

  if (stats.sampleCount > 0) {
    checks.push({ name: "fidelity-anchor-recall", actual: stats.averageAnchorRecallPercent, required: minAnchorRecallPercent });
    if (stats.averageAnchorRecallPercent < minAnchorRecallPercent) {
      failures.push("fidelity-anchor-recall: " + stats.averageAnchorRecallPercent + " < " + minAnchorRecallPercent);
    }
  }
  if (stats.bodyCoverageSampleCount > 0) {
    checks.push({ name: "fidelity-body-coverage", actual: stats.averageBodyCoveragePercent, required: minBodyCoveragePercent });
    if (stats.averageBodyCoveragePercent < minBodyCoveragePercent) {
      failures.push("fidelity-body-coverage: " + stats.averageBodyCoveragePercent + " < " + minBodyCoveragePercent);
    }
  }
  return { ok: failures.length === 0, checks, failures };
}

/** Human note that keeps the paired report distinct from retrieval fidelity. */
export const EFFICIENCY_NOT_FIDELITY_NOTE =
  "paired efficiency compares baseline vs packaged arms for the same work; it is not retrieval Hit@k";
