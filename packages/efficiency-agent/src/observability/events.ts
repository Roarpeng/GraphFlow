import type { TraceEvent, TraceStage } from "../trace.js";

/**
 * Event recorder (spec §3 / §11): every pipeline state transition leaves
 * stage + outcome + reason + evidence + policyVersion, in insertion order.
 * Evidence is capped so a chatty stage cannot bloat the trace.
 */

export const MAX_EVIDENCE_ITEMS = 8;
export const MAX_EVIDENCE_CHARS = 300;

export interface EventRecorder {
  record(stage: TraceStage, outcome: string, reason: string, evidence?: string[]): void;
  setPolicyVersion(version: number): void;
  /** Copies, in insertion order. */
  events(): TraceEvent[];
}

const capEvidence = (evidence: readonly string[]): string[] =>
  evidence.slice(0, MAX_EVIDENCE_ITEMS).map((item) => String(item).slice(0, MAX_EVIDENCE_CHARS));

export function createEventRecorder(policyVersion: number, now: () => number = Date.now): EventRecorder {
  let currentPolicyVersion = policyVersion;
  const recorded: TraceEvent[] = [];
  return {
    record(stage, outcome, reason, evidence = []) {
      recorded.push({
        at: new Date(now()).toISOString(),
        stage,
        outcome,
        reason,
        evidence: capEvidence(evidence),
        policyVersion: currentPolicyVersion,
      });
    },
    setPolicyVersion(version) {
      currentPolicyVersion = version;
    },
    events() {
      return recorded.map((event) => ({ ...event, evidence: [...event.evidence] }));
    },
  };
}
