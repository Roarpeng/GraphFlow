import type { WorkspaceSnapshot } from "../security/write-audit.js";
import type { RiskClass, TraceSecurityDecision } from "../trace.js";
import type { AgentExecutorSpec } from "../workers/agent-task-worker.js";

/**
 * The security seam the pipeline calls (spec §6–§8). The pipeline never
 * decides policy itself; it asks this adapter and records the verdict.
 */

export interface SecurityContext {
  workspaceRoot: string;
  readOnly: boolean;
  network: boolean;
  externalWriteApproval: boolean;
  subAgents: boolean;
  /** Declared write scope (contract `permissions.write`); absent → only the root/policy checks apply. */
  writeScope?: string[];
}

export interface WriteAudit {
  decision: TraceSecurityDecision;
  /** Paths written during the run, relative to the workspace root ("../…" when outside it). */
  newlyChanged: string[];
  /** Subset: files already dirty before the run whose content changed (same git status). */
  rewrittenDirty?: string[];
  /** Subset: git-ignored entries written. */
  ignoredChanged?: string[];
  /** Subset: paths outside the workspace root. */
  outsideRoot?: string[];
}

export interface PipelineSecurity {
  policyVersion: string;
  /** Validation commands are launched by eff-agent itself: each must be allowed. */
  checkCommands(commands: string[], ctx: SecurityContext): TraceSecurityDecision;
  /** The agent CLI launch (the CLI's own internal tool calls are outside this gate). */
  checkWorkerLaunch(executor: AgentExecutorSpec, ctx: SecurityContext): TraceSecurityDecision;
  /** Declared write scope must stay inside the workspace root (checked before anything runs). */
  checkWriteScope(ctx: SecurityContext): TraceSecurityDecision;
  /**
   * Workspace snapshot (undefined when not a git repo). The post-run call passes
   * the pre-run snapshot so the same files are re-signed for comparison.
   */
  snapshot(root: string, before?: WorkspaceSnapshot): WorkspaceSnapshot | undefined;
  auditWrites(before: WorkspaceSnapshot | undefined, after: WorkspaceSnapshot | undefined, ctx: SecurityContext): WriteAudit;
  redact(text: string): string;
  redactDeep<T>(value: T): T;
  wrapUntrusted(source: string, text: string): string;
  /** Cache-poisoning guard; `output` is the raw (unredacted) result. */
  admitToCache(input: { output: string; validationPassed: boolean; evidence: string[] }): { admit: boolean; reason: string };
}

export function allow(risk: RiskClass, reasons: string[] = []): TraceSecurityDecision {
  return { verdict: "allow", risk, reasons };
}

const RISK_ORDER: RiskClass[] = ["R0", "R1", "R2", "R3", "R4", "R5"];

/** Combine decisions: any deny wins, then approval-required; the highest risk is kept. */
export function combineDecisions(decisions: TraceSecurityDecision[]): TraceSecurityDecision {
  if (decisions.length === 0) return allow("R0");
  const risk = decisions.reduce<RiskClass>(
    (max, d) => (RISK_ORDER.indexOf(d.risk) > RISK_ORDER.indexOf(max) ? d.risk : max),
    "R0"
  );
  const verdict = decisions.some((d) => d.verdict === "deny")
    ? "deny"
    : decisions.some((d) => d.verdict === "approval-required")
      ? "approval-required"
      : "allow";
  return { verdict, risk, reasons: decisions.flatMap((d) => d.reasons) };
}
