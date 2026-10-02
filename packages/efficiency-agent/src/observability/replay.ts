import type { TaskTrace, TraceEvent } from "../trace.js";

/**
 * Trace replay (spec §24 / §28 "100% trace replayable"): render a TaskTrace
 * as a human-readable decision log, and list everything that would stop the
 * trace from being replayed. `replayProblems(trace).length === 0` is the
 * replayability gate.
 */

const formatEvent = (event: TraceEvent): string => {
  const evidence = event.evidence.length > 0 ? ` (evidence: ${event.evidence.join("; ")})` : "";
  return `[${event.stage}] ${event.outcome} - ${event.reason}${evidence} @policy v${event.policyVersion}`;
};

const formatChecks = (checks: ReadonlyArray<{ name: string; passed: boolean }>): string =>
  checks.length === 0 ? "no checks" : checks.map((c) => `${c.name}=${c.passed ? "PASS" : "FAIL"}`).join(", ");

export function renderReplay(trace: TaskTrace): string[] {
  const lines: string[] = [];
  const taskId = trace.task.taskId !== undefined ? ` id=${trace.task.taskId}` : "";
  lines.push(`Trace ${trace.traceId}: task "${trace.task.text}" (${trace.task.category}${taskId})`);
  lines.push(
    `Run: mode=${trace.run.mode} worker=${trace.run.worker} started=${trace.run.startedAt}` +
      (trace.run.finishedAt !== undefined ? ` finished=${trace.run.finishedAt}` : "")
  );
  if (trace.model) lines.push(`Model: ${trace.model.provider} / ${trace.model.tier}`);
  if (trace.fingerprint !== undefined) lines.push(`Fingerprint: ${trace.fingerprint}`);

  if (trace.record) {
    const r = trace.record;
    const tools = Object.entries(r.toolVersions)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, version]) => `${name}@${version}`)
      .join(", ");
    lines.push(
      `Decision ${r.decisionId}: policy v${r.policyVersion}, contract ${r.contractVersion}` +
        (r.workerVersion !== undefined ? `, worker ${r.workerVersion}` : "") +
        `, cache ${r.cacheNamespace}, tools ${tools.length > 0 ? tools : "none"}`
    );
  } else {
    lines.push("Decision record: missing");
  }
  if (trace.decision) lines.push(`Reuse mode: ${trace.decision.reuseMode}`);

  const events = trace.events ?? [];
  if (events.length === 0) lines.push("Events: none");
  for (const event of events) lines.push(formatEvent(event));

  if (trace.securityDecision) {
    const s = trace.securityDecision;
    lines.push(`Security: ${s.verdict} (${s.risk})${s.reasons.length > 0 ? ` - ${s.reasons.join("; ")}` : ""}`);
  }
  lines.push(`Validation${trace.validationStatus !== undefined ? ` ${trace.validationStatus}` : ""}: ${formatChecks(trace.validation)}`);
  if (trace.regression) {
    lines.push(`Regression ${trace.regression.passed ? "passed" : "failed"}: ${formatChecks(trace.regression.checks)}`);
  }
  if (trace.oracle) {
    lines.push(`Oracle ${trace.oracle.passed ? "passed" : "failed"}: ${formatChecks(trace.oracle.checks)}`);
  }
  if (trace.judged !== undefined) lines.push(`Judged: ${trace.judged ? "yes" : "no"}`);
  if (trace.failure) lines.push(`Failure at ${trace.failure.stage}: ${trace.failure.reason}`);
  lines.push(`Result: ${trace.result.success ? "success" : "failure"}`);
  return lines;
}

export function replayProblems(trace: TaskTrace): string[] {
  const problems: string[] = [];
  if (trace.record === undefined) problems.push("missing decision record");

  const events = trace.events ?? [];
  if (events.length === 0) {
    problems.push("missing events");
    return problems;
  }

  let previous = Number.NEGATIVE_INFINITY;
  for (const [index, event] of events.entries()) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) {
      problems.push(`event ${index} (${event.stage}) has an invalid timestamp: ${event.at}`);
      continue;
    }
    if (at < previous) {
      problems.push(`events not chronologically ordered: event ${index} (${event.stage}) precedes its predecessor`);
    }
    previous = Math.max(previous, at);
  }

  const reuseEvents = events.filter((event) => event.stage === "reuse-gate");
  if (reuseEvents.length === 0) problems.push('no "reuse-gate" event');

  const reused = reuseEvents[reuseEvents.length - 1]?.outcome.toUpperCase() === "REUSE";
  const executedOrValidated = events.some((event) => event.stage === "execute" || event.stage === "validate");
  if (trace.result.success && !executedOrValidated && !reused) {
    problems.push('result.success is true but there is no "execute" or "validate" event and the task was not reused');
  }

  if (trace.securityDecision !== undefined && !events.some((event) => event.stage === "security")) {
    problems.push('securityDecision present but no "security" event');
  }

  if (trace.record !== undefined) {
    const expected = trace.record.policyVersion;
    const mismatched = Array.from(
      new Set(events.filter((event) => event.policyVersion !== expected).map((event) => event.policyVersion))
    );
    if (mismatched.length > 0) {
      problems.push(
        `policyVersion mismatch: record v${expected} but events carry v${mismatched.sort((a, b) => a - b).join(", v")}`
      );
    }
  }
  return problems;
}
