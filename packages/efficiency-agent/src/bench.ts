import { estimated, measured, proxy, type Measurement } from "./measurement.js";
import type { TaskTrace, TraceTaskInfo } from "./trace.js";

/**
 * Pure trace builders for the P0 benchmark runner. Provenance honesty is
 * decided HERE, at construction: the runner cannot accidentally emit a bare
 * number, because the builder types force a Measurement and the constructors
 * state their method.
 *
 * v0 scope note: baseline/shadow arms both drive the substrate's bridge path
 * (no LLM keys, worker never executes). These arms measure the PACKAGING and
 * ADVISING pipeline — context cost, decision cost, rounds — not worker
 * outcomes. Worker-outcome arms arrive with the P2 broker.
 */

export interface RunObservation {
  task: TraceTaskInfo;
  worker: string;
  mode: "baseline" | "shadow";
  startedAt: string;
  finishedAt: string;
  /** Wall-clock ms of the full runTaskResult call. Measured. */
  totalDurationMs: number;
  /** Bridge packaging succeeded (status DELEGATED) without crashing. */
  packaged: boolean;
  /** Character length of the executionDescriptor.context block. Measured. */
  descriptorContextChars: number;
  /** Attempts reported by the run summary. Measured. */
  attempts: number;
  /** Anchor count in the packaged descriptor/advisory context. Measured. */
  anchors: number;
  /** Present in the shadow arm: the substrate advisory. */
  advisory?: {
    taskId: string;
    reuseMode: "REUSE" | "ADAPT" | "FRESH";
    durationMs: number;
    llmCalls: number;
  };
}

function descriptorTokens(descriptorContextChars: number): Measurement {
  // The substrate does not yet expose per-run token counts on the summary;
  // chars/4 over the descriptor context block is the honest interim stand-in
  // and MUST stay labeled proxy until the summary carries real counts.
  return proxy(Math.ceil(descriptorContextChars / 4), "descriptor-chars/4", 0.6);
}

export function buildRunTrace(observation: RunObservation): TaskTrace {
  const trace: TaskTrace = {
    schemaVersion: "1.0",
    traceId: `${observation.mode}-${observation.task.taskId ?? observation.task.text.slice(0, 24)}`,
    task: observation.task,
    run: {
      worker: observation.worker,
      mode: observation.mode,
      startedAt: observation.startedAt,
      finishedAt: observation.finishedAt,
    },
    context: {
      tokens: descriptorTokens(observation.descriptorContextChars),
      anchors: observation.anchors,
      cacheHit: false,
    },
    // Bridge mode makes zero model calls by construction; the run is
    // delegated to the connected agent outside this benchmark's scope.
    llm: { calls: measured(0) },
    tools: [],
    rounds: measured(Math.max(1, observation.attempts)),
    validation: [],
    result: { success: observation.packaged },
  };
  if (observation.advisory) {
    const share =
      observation.totalDurationMs > 0
        ? observation.advisory.durationMs / observation.totalDurationMs
        : 0;
    trace.decision = {
      reuseMode: observation.advisory.reuseMode,
      durationMs: measured(observation.advisory.durationMs),
      llmCalls: measured(observation.advisory.llmCalls),
      // A ratio computed from two measured quantities is still derived by a
      // formula (R3 estimated, method mandatory) — and the denominator
      // excludes worker execution (which never ran in these arms).
      costShare: estimated(
        Number(share.toFixed(4)),
        "decisionMs/totalRunMs (packaging only)",
        0.9
      ),
    };
  }
  return trace;
}
