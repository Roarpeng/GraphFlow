import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { appendGovernanceAudit, defaultEvidenceAuditPath } from "../../../learning/evidence";
import { readJournalEntries } from "../../../hooks/auto-capture";
import { reportOutcome } from "./routing";
import type { DeviationKind } from "../../../learning/episodic-memory";
import type { OutcomeEvidenceInput } from "../../../learning/evidence";
import type { EngineeringLinkHints } from "../../../graph/episode-engineering-links";

export interface EvidenceBackfillEntry {
  episodeId: string;
  success: boolean;
  lessons?: string[];
  deviation?: DeviationKind;
  engineeringHints?: EngineeringLinkHints;
  evidence: OutcomeEvidenceInput;
}

export interface BackfillEvidenceOptions {
  configPath?: string;
  evidencePath: string;
  journalPath?: string;
  auditPath?: string;
  actor?: string;
  dryRun?: boolean;
}

export interface BackfillEvidenceResult {
  total: number;
  closed: number;
  failed: number;
  skipped: number;
  journalPath?: string;
  auditPath?: string;
  failures: Array<{ episodeId: string; reason: string }>;
}

function readEntries(path: string): EvidenceBackfillEntry[] {
  const raw = readFileSync(path, "utf8");
  const parsed = path.endsWith(".json")
    ? JSON.parse(raw)
    : raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (!Array.isArray(parsed)) throw new Error("evidence file must contain an array or JSONL entries");
  return parsed as EvidenceBackfillEntry[];
}

export async function backfillOutcomeEvidence(
  options: BackfillEvidenceOptions
): Promise<BackfillEvidenceResult> {
  const entries = readEntries(options.evidencePath);
  const failures: BackfillEvidenceResult["failures"] = [];
  let closed = 0;
  let skipped = 0;
  const auditPath = options.auditPath ?? defaultEvidenceAuditPath();

  for (const entry of entries) {
    if (!entry?.episodeId) {
      skipped += 1;
      continue;
    }
    if (options.dryRun) {
      closed += 1;
      continue;
    }
    try {
      const result = await reportOutcome(
        entry.episodeId,
        entry.success === true,
        entry.lessons ?? [],
        options.configPath,
        entry.deviation,
        entry.engineeringHints,
        entry.evidence
      );
      if (!result.ok) throw new Error(result.reason ?? "outcome rejected");
      closed += 1;
      appendGovernanceAudit(auditPath, {
        actor: options.actor ?? "evidence-backfill",
        action: "outcome.evidence.close",
        subject: entry.episodeId,
        tenant: "local",
        data: { evidence: entry.evidence, verification: result.evidence },
      });
    } catch (error) {
      failures.push({
        episodeId: entry.episodeId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const journalPath = options.journalPath;
  let removed = 0;
  if (!options.dryRun && journalPath && existsSync(journalPath) && closed > 0) {
    const closedIds = new Set(entries.map((entry) => entry.episodeId));
    const open = readJournalEntries(journalPath).filter((entry) => {
      if (!closedIds.has(entry.episodeId)) return true;
      removed += 1;
      return false;
    });
    const dir = dirname(journalPath);
    const temp = join(dir, `.session-journal-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(temp, open.map((entry) => JSON.stringify(entry)).join("\n") + (open.length ? "\n" : ""), "utf8");
    renameSync(temp, journalPath);
  }

  return {
    total: entries.length,
    closed,
    failed: failures.length,
    skipped,
    ...(journalPath && removed > 0 ? { journalPath } : {}),
    ...(existsSync(auditPath) ? { auditPath } : {}),
    failures,
  };
}

export function readEvidenceFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
