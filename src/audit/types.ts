/**
 * R9 Promise Ledger / Closing Audit — shared types (frozen contract).
 *
 * The audit answers one question with provable facts: "did the work that
 * SAYS it is done actually land everywhere it must?" Findings are derived
 * from observable side effects (working-tree changes, manifests, graph
 * wiring, container/loader configs, docs) — never from intent guessing.
 *
 * Delivery stance: challenge, not gate — findings are surfaced to the agent
 * (outcome pre-check, cross-session reminder, CLI). `strict` mode upgrades
 * the outcome pre-check to refuse a success report while findings are open.
 */

/** One unresolved obligation discovered by a checker. */
export interface AuditFinding {
  /** Stable machine id, e.g. "dependency-lock-missing:lodash". */
  id: string;
  kind:
    | "dependency"
    | "orphan-file"
    | "container-ref"
    | "loader-ref"
    | "doc-consistency"
    | "rule"
    | "plan-step";
  severity: "error" | "warning";
  /** Human/agent-readable Chinese question ("忘了吗？" style), evidence-backed. */
  message: string;
  /** File paths / symbols / manifests that prove the finding. */
  evidence: {
    files?: string[];
    symbol?: string;
    rule?: string;
    detail?: string;
  };
  /** Concrete next action the agent can take. */
  remediation: string;
}

export interface AuditSummary {
  total: number;
  errors: number;
  warnings: number;
  checkers: Array<{ name: string; findings: number }>;
}

export interface AuditReport {
  command: "audit";
  /** How the changed-file baseline was derived. */
  baseline: {
    strategy: "git-working-tree" | "git-ref" | "none";
    ref?: string;
    changedFiles: string[];
    note: string;
  };
  strict: boolean;
  findings: AuditFinding[];
  summary: AuditSummary;
  ok: boolean;
}

export interface AuditOptions {
  /** Expand the diff baseline to a git ref (default: uncommitted working tree). */
  since?: string;
  /** Treat warnings as blocking too (used by the outcome pre-check gate). */
  strict?: boolean;
  /** Test hook: inject changed files, skipping baseline detection. */
  changedFilesOverride?: string[];
  /** Test hook: inject the project root (default: workspaceRoot / cwd). */
  rootOverride?: string;
}

/** Checker contract — deterministic given (files, root, graph probe). */
export interface AuditChecker {
  name: string;
  /**
   * @param changedFiles baseline-changed files (relative posix paths); may be
   * empty when no baseline is derivable — stateful checkers still run.
   * @param root absolute project root.
   * @param context graph + rule-engine handles (see AuditContext).
   */
  run(changedFiles: string[], root: string, context: AuditContext): Promise<AuditFinding[]>;
}

/** R7-d privacy audit surface: verifiable local-first facts. */
export interface PrivacyAuditFacts {
  /** Workspace-relative artifact paths that exist on disk. */
  existingPaths: string[];
  /** Workspace-relative artifact paths that do not exist (never created). */
  missingPaths: string[];
  /** All network endpoints; each flagged whether it is required without config. */
  endpoints: Array<{ url: string; requiredWithoutConfig: boolean; when: string }>;
  /** Global config path + whether it exists + POSIX mode when readable. */
  globalConfig: { path: string; exists: boolean; mode?: string };
  /** Providers with a configured key (env or file) — boolean only, never values. */
  configuredProviders: string[];
  /** Whether any provider key is currently visible to the process. */
  anyKeyConfigured: boolean;
}

export interface AuditContext {
  /** Load configured audit rules (graphflow.audit.json) — never throws. */
  loadRules(): AuditRuleSet;
  /** Probe the graph for a file's node + inbound wiring. Fail-open to undefined. */
  probeFile?(relPath: string): Promise<{ nodeId?: string; inboundEdges: number } | undefined>;
}

/**
 * Declarative project rule (graphflow.audit.json). The canonical example is
 * the driver case: files matching `drivers/**` that appear in the baseline
 * MUST be referenced by one of `mustBeReferencedBy` globs — otherwise the
 * "load the driver" obligation is dangling.
 */
export interface AuditRule {
  name: string;
  description?: string;
  /** Glob for files whose appearance creates the obligation. */
  filePattern: string;
  /** Globs for config files that must reference at least one matched file. */
  mustBeReferencedBy: string[];
  /** Finder kind for reporting; defaults to "rule". */
  kind?: AuditFinding["kind"];
  severity?: AuditFinding["severity"];
  remediation?: string;
}

export interface AuditRuleSet {
  rules: AuditRule[];
  /** Path the rules were loaded from; absent when using built-ins only. */
  source?: string;
}

/** Promise-ledger persistence (cross-session reminder backing store). */
export interface PromiseLedgerEntry {
  sessionId: string;
  /** ISO timestamp the audit ran at session end. */
  recordedAt: string;
  findingIds: string[];
  messages: string[];
  status: "open" | "resolved";
  resolvedAt?: string;
}
