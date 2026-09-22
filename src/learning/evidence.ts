import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type EvidenceSource = "manual" | "ci" | "agent" | "hook";

export interface OutcomeEvidence {
  repository?: string;
  /** Absent when the caller could not pin the outcome to a commit. */
  commit?: string;
  diff: string;
  /** Absent when no test command was supplied (verification grades it). */
  testCommand?: string;
  testResult: "pass" | "fail" | "unknown";
  artifacts: string[];
  userConfirmed: boolean;
  source: EvidenceSource;
  capturedAt: string;
  evidenceId: string;
  sha256: string;
}

export interface OutcomeEvidenceInput {
  repository?: string;
  commit?: string;
  diff?: string;
  testCommand?: string;
  testResult?: "pass" | "fail" | "unknown";
  artifacts?: readonly string[];
  userConfirmed?: boolean;
  source?: EvidenceSource;
  capturedAt?: string;
  evidenceId?: string;
}

export interface EvidenceVerification {
  level: "verified" | "partial" | "unverified";
  reasons: string[];
}

const EVIDENCE_SOURCES = new Set(["manual", "ci", "agent", "hook"]);

function stableEvidenceString(evidence: OutcomeEvidence): string {
  return JSON.stringify({
    repository: evidence.repository ?? "",
    commit: evidence.commit,
    diff: evidence.diff,
    testCommand: evidence.testCommand,
    testResult: evidence.testResult,
    artifacts: [...evidence.artifacts].sort(),
    userConfirmed: evidence.userConfirmed,
    source: evidence.source,
  });
}

export function normalizeOutcomeEvidence(
  input: OutcomeEvidenceInput | undefined
): OutcomeEvidence | undefined {
  if (!input) return undefined;
  const commit = input.commit?.trim();
  const diff = input.diff ?? "";
  const testCommand = input.testCommand?.trim();
  // Any substantive evidence field constructs the package; verification
  // LEVELS (verified / partial / unverified with reasons) are decided by
  // verifyOutcomeEvidence. The old gate (commit AND testCommand, else drop
  // the whole package) silently discarded e.g. a passing test command with
  // no commit and answered "no evidence package" — the user's submitted
  // evidence vanished instead of being graded honestly.
  const hasAnyEvidence = Boolean(
    commit ||
      diff.trim() ||
      testCommand ||
      (input.testResult && input.testResult !== "unknown") ||
      (input.artifacts ?? []).length > 0 ||
      input.userConfirmed === true
  );
  if (!hasAnyEvidence) return undefined;

  const evidence: OutcomeEvidence = {
    ...(input.repository?.trim() ? { repository: input.repository.trim() } : {}),
    ...(commit ? { commit } : {}),
    diff,
    ...(testCommand ? { testCommand } : {}),
    testResult: input.testResult === "pass" || input.testResult === "fail"
      ? input.testResult
      : "unknown",
    artifacts: [...new Set((input.artifacts ?? []).filter(Boolean))],
    userConfirmed: input.userConfirmed === true,
    source: input.source && EVIDENCE_SOURCES.has(input.source)
      ? input.source
      : "manual",
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    evidenceId: input.evidenceId ?? `ev:${randomUUID()}`,
    sha256: "",
  };
  evidence.sha256 = createHash("sha256").update(stableEvidenceString(evidence)).digest("hex");
  return evidence;
}

export function verifyOutcomeEvidence(
  evidence: OutcomeEvidence | undefined
): EvidenceVerification {
  if (!evidence) return { level: "unverified", reasons: ["no evidence package"] };
  const reasons: string[] = [];
  if (evidence.testResult !== "pass") reasons.push("tests did not pass");
  if (!evidence.diff.trim()) reasons.push("diff is empty");
  if (!evidence.userConfirmed) reasons.push("not user confirmed");
  if (reasons.length === 0) return { level: "verified", reasons };
  if (evidence.commit && evidence.testCommand) {
    return { level: "partial", reasons };
  }
  reasons.push("missing commit or test command");
  return { level: "unverified", reasons };
}

export interface GovernanceAuditEvent {
  seq: number;
  at: string;
  actor: string;
  action: string;
  subject: string;
  tenant: string;
  data?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

function eventHash(event: Omit<GovernanceAuditEvent, "hash">): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

export function readAuditEvents(path: string): GovernanceAuditEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GovernanceAuditEvent);
}

export function appendGovernanceAudit(
  path: string,
  input: Omit<GovernanceAuditEvent, "seq" | "at" | "prevHash" | "hash">
): GovernanceAuditEvent {
  const previous = readAuditEvents(path).at(-1);
  const withoutHash = {
    seq: (previous?.seq ?? 0) + 1,
    at: new Date().toISOString(),
    prevHash: previous?.hash ?? "genesis",
    ...input,
  };
  const event: GovernanceAuditEvent = { ...withoutHash, hash: eventHash(withoutHash) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(event)}\n`, { flag: "a", encoding: "utf8" });
  return event;
}

export function verifyAuditChain(events: GovernanceAuditEvent[]): boolean {
  let expectedPrev = "genesis";
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const { hash, ...rest } = event;
    if (
      event.seq !== index + 1 ||
      event.prevHash !== expectedPrev ||
      eventHash(rest as Omit<GovernanceAuditEvent, "hash">) !== hash
    ) {
      return false;
    }
    expectedPrev = hash;
  }
  return true;
}

export function defaultEvidenceAuditPath(workspaceRoot = process.cwd()): string {
  return join(workspaceRoot, ".graphflow", "evidence-audit.jsonl");
}
