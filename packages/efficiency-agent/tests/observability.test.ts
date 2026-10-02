import { describe, expect, it } from "vitest";
import {
  createEventRecorder,
  MAX_EVIDENCE_CHARS,
  MAX_EVIDENCE_ITEMS,
  otelTraceId,
  renderReplay,
  replayProblems,
  toOtlpJson,
  traceToOtelSpans,
  type OtelSpan,
} from "../src/observability/index.js";
import { estimated, measured } from "../src/measurement.js";
import type { TaskTrace, TraceEvent, TraceStage } from "../src/trace.js";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const event = (stage: TraceStage, offsetMs: number, overrides?: Partial<TraceEvent>): TraceEvent => ({
  at: iso(offsetMs),
  stage,
  outcome: "ok",
  reason: `${stage} done`,
  evidence: [],
  policyVersion: 3,
  ...(overrides ?? {}),
});

const completeTrace = (overrides?: Partial<TaskTrace>): TaskTrace => ({
  schemaVersion: "1.0",
  traceId: "trace-abc",
  task: { text: "fix the secret login bug in auth.ts", taskId: "task-1", category: "bugfix" },
  run: { worker: "local-command", mode: "adaptive", startedAt: iso(0), finishedAt: iso(10_000) },
  context: { tokens: estimated(1200, "chars/4", 0.7), anchors: 4, cacheHit: false },
  llm: { calls: measured(2), totalTokens: measured(3000) },
  tools: [{ name: "graphflow_context", calls: measured(1) }],
  rounds: measured(1),
  validation: [
    { name: "tsc", passed: true },
    { name: "vitest", passed: true },
  ],
  result: { success: true },
  sessionId: "session-xyz",
  projectId: "project-1",
  fingerprint: "fp-123",
  model: { provider: "anthropic", tier: "standard" },
  cost: { estimated: estimated(0.02, "token-price-table") },
  validationStatus: "passed",
  securityDecision: { verdict: "allow", risk: "R1", reasons: ["workspace write"] },
  record: {
    decisionId: "dec-1",
    policyVersion: 3,
    contractVersion: "1.0",
    workerVersion: "0.4.0",
    toolVersions: { graphflow: "2.0.3", git: "2.45" },
    cacheNamespace: "ns-main",
  },
  events: [
    event("flags", 0),
    event("fingerprint", 500, { evidence: ["semantic:abc", "project:def"] }),
    event("reuse-gate", 1_000, { outcome: "FRESH", reason: "no cached trajectory" }),
    event("security", 1_500, { outcome: "allow" }),
    event("execute", 2_000),
    event("validate", 8_000, { outcome: "passed" }),
  ],
  judged: true,
  oracle: { passed: true, checks: [{ name: "repro-test", passed: true }] },
  decision: { reuseMode: "FRESH", durationMs: measured(40), llmCalls: measured(0) },
  ...(overrides ?? {}),
});

const attr = (span: OtelSpan, key: string): OtelSpan["attributes"][number]["value"] | undefined =>
  span.attributes.find((a) => a.key === key)?.value;

describe("createEventRecorder", () => {
  it("records events in insertion order with ISO timestamps from the clock", () => {
    let clock = T0;
    const recorder = createEventRecorder(1, () => clock);
    recorder.record("flags", "on", "flags loaded");
    clock += 250;
    recorder.record("reuse-gate", "FRESH", "no match", ["a", "b"]);
    clock += 250;
    recorder.record("execute", "ok", "ran");
    const events = recorder.events();
    expect(events.map((e) => e.stage)).toEqual(["flags", "reuse-gate", "execute"]);
    expect(events.map((e) => e.at)).toEqual([iso(0), iso(250), iso(500)]);
    expect(events[0]?.evidence).toEqual([]);
    expect(events[1]?.evidence).toEqual(["a", "b"]);
  });

  it("caps evidence to 8 items of 300 chars each", () => {
    const recorder = createEventRecorder(1, () => T0);
    const evidence = Array.from({ length: 12 }, (_, i) => `${i}:${"x".repeat(500)}`);
    recorder.record("context", "ok", "big", evidence);
    const [recorded] = recorder.events();
    expect(recorded?.evidence).toHaveLength(MAX_EVIDENCE_ITEMS);
    expect(MAX_EVIDENCE_ITEMS).toBe(8);
    expect(MAX_EVIDENCE_CHARS).toBe(300);
    for (const item of recorded?.evidence ?? []) expect(item.length).toBe(300);
    expect(recorded?.evidence[0]?.startsWith("0:")).toBe(true);
    expect(recorded?.evidence[7]?.startsWith("7:")).toBe(true);
    expect(evidence[0]?.length).toBeGreaterThan(300);
  });

  it("stamps the current policy version and switches when told", () => {
    const recorder = createEventRecorder(2, () => T0);
    recorder.record("flags", "ok", "before");
    recorder.setPolicyVersion(5);
    recorder.record("learn", "ok", "after");
    expect(recorder.events().map((e) => e.policyVersion)).toEqual([2, 5]);
  });

  it("returns copies that cannot mutate the recorder", () => {
    const recorder = createEventRecorder(1, () => T0);
    recorder.record("flags", "ok", "r", ["e"]);
    const first = recorder.events();
    first[0]!.evidence.push("tampered");
    first[0]!.outcome = "tampered";
    first.push(event("learn", 0));
    const second = recorder.events();
    expect(second).toHaveLength(1);
    expect(second[0]?.outcome).toBe("ok");
    expect(second[0]?.evidence).toEqual(["e"]);
  });

  it("defaults the clock to Date.now", () => {
    const before = Date.now();
    const recorder = createEventRecorder(1);
    recorder.record("flags", "ok", "r");
    const at = Date.parse(recorder.events()[0]!.at);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
});

describe("traceToOtelSpans", () => {
  it("derives deterministic 32/16 hex ids from trace.traceId", () => {
    const a = traceToOtelSpans(completeTrace());
    const b = traceToOtelSpans(completeTrace());
    expect(a.map((s) => [s.traceId, s.spanId, s.parentSpanId])).toEqual(
      b.map((s) => [s.traceId, s.spanId, s.parentSpanId])
    );
    for (const span of a) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(new Set(a.map((s) => s.spanId)).size).toBe(a.length);
    expect(a[0]?.traceId).toBe(otelTraceId("trace-abc"));
    const other = traceToOtelSpans(completeTrace({ traceId: "trace-other" }));
    expect(other[0]?.traceId).not.toBe(a[0]?.traceId);
    expect(other[0]?.spanId).not.toBe(a[0]?.spanId);
  });

  it("builds a root span covering the run with the GenAI/eff attribute set", () => {
    const [root] = traceToOtelSpans(completeTrace(), { serviceVersion: "2.1.0" });
    expect(root?.name).toBe("eff_agent.task");
    expect(root?.parentSpanId).toBeUndefined();
    expect(root?.startTimeUnixNano).toBe(`${T0}000000`);
    expect(root?.endTimeUnixNano).toBe(`${T0 + 10_000}000000`);
    expect(root?.status).toEqual({ code: 1 });
    const span = root!;
    expect(attr(span, "gen_ai.operation.name")).toEqual({ stringValue: "agent.task" });
    expect(attr(span, "gen_ai.system")).toEqual({ stringValue: "anthropic" });
    expect(attr(span, "gen_ai.request.model")).toEqual({ stringValue: "standard" });
    expect(attr(span, "service.version")).toEqual({ stringValue: "2.1.0" });
    expect(attr(span, "eff.task.id")).toEqual({ stringValue: "task-1" });
    expect(attr(span, "eff.task.category")).toEqual({ stringValue: "bugfix" });
    expect(attr(span, "eff.run.mode")).toEqual({ stringValue: "adaptive" });
    expect(attr(span, "eff.run.worker")).toEqual({ stringValue: "local-command" });
    expect(attr(span, "eff.reuse_mode")).toEqual({ stringValue: "FRESH" });
    expect(attr(span, "eff.context.tokens")).toEqual({ intValue: "1200" });
    expect(attr(span, "eff.context.tokens.provenance")).toEqual({ stringValue: "estimated" });
    expect(attr(span, "eff.llm.calls")).toEqual({ intValue: "2" });
    expect(attr(span, "eff.llm.calls.provenance")).toEqual({ stringValue: "measured" });
    expect(attr(span, "eff.rounds")).toEqual({ intValue: "1" });
    expect(attr(span, "eff.cache_hit")).toEqual({ boolValue: false });
    expect(attr(span, "eff.validation_status")).toEqual({ stringValue: "passed" });
    expect(attr(span, "eff.success")).toEqual({ boolValue: true });
    expect(attr(span, "eff.judged")).toEqual({ boolValue: true });
    expect(attr(span, "eff.policy_version")).toEqual({ intValue: "3" });
    expect(attr(span, "eff.decision_id")).toEqual({ stringValue: "dec-1" });
    expect(attr(span, "eff.cache_namespace")).toEqual({ stringValue: "ns-main" });
    expect(attr(span, "eff.security.verdict")).toEqual({ stringValue: "allow" });
    expect(attr(span, "eff.security.risk")).toEqual({ stringValue: "R1" });
    expect(attr(span, "eff.cost.estimated")).toEqual({ doubleValue: 0.02 });
    expect(attr(span, "eff.cost.estimated.provenance")).toEqual({ stringValue: "estimated" });
  });

  it("excludes task text and high-cardinality identifiers by default (§12)", () => {
    const spans = traceToOtelSpans(completeTrace());
    const serialized = JSON.stringify(spans);
    expect(serialized).not.toContain("secret login bug");
    expect(attr(spans[0]!, "eff.task.text")).toBeUndefined();
    expect(attr(spans[0]!, "eff.session.id")).toBeUndefined();
    expect(attr(spans[0]!, "eff.project.id")).toBeUndefined();
    expect(attr(spans[0]!, "eff.fingerprint")).toBeUndefined();
    // Event evidence is exported as a count only.
    expect(serialized).not.toContain("semantic:abc");
  });

  it("includes task text and identifiers only when opted in", () => {
    const [root] = traceToOtelSpans(completeTrace(), { includeTaskText: true, includeIdentifiers: true });
    expect(attr(root!, "eff.task.text")).toEqual({ stringValue: "fix the secret login bug in auth.ts" });
    expect(attr(root!, "eff.session.id")).toEqual({ stringValue: "session-xyz" });
    expect(attr(root!, "eff.project.id")).toEqual({ stringValue: "project-1" });
    expect(attr(root!, "eff.fingerprint")).toEqual({ stringValue: "fp-123" });
  });

  it("marks the root span ERROR when the task failed or a failure is recorded", () => {
    const [failed] = traceToOtelSpans(completeTrace({ result: { success: false } }));
    expect(failed?.status).toEqual({ code: 2, message: "task failed" });
    const [withFailure] = traceToOtelSpans(
      completeTrace({ failure: { stage: "execute", reason: "worker crashed" } })
    );
    expect(withFailure?.status).toEqual({ code: 2, message: "execute: worker crashed" });
    expect(attr(withFailure!, "eff.failure.stage")).toEqual({ stringValue: "execute" });
  });

  it("emits one child span per event, parented to the root, with chained time windows", () => {
    const trace = completeTrace();
    const [root, ...children] = traceToOtelSpans(trace);
    const events = trace.events!;
    expect(children).toHaveLength(events.length);
    children.forEach((child, i) => {
      const ev = events[i]!;
      expect(child.name).toBe(`eff_agent.${ev.stage}`);
      expect(child.parentSpanId).toBe(root?.spanId);
      expect(child.traceId).toBe(root?.traceId);
      expect(child.startTimeUnixNano).toBe(`${Date.parse(ev.at)}000000`);
      const nextAt = events[i + 1]?.at;
      const expectedEnd = nextAt !== undefined ? Date.parse(nextAt) : T0 + 10_000;
      expect(child.endTimeUnixNano).toBe(`${expectedEnd}000000`);
      expect(attr(child, "eff.outcome")).toEqual({ stringValue: ev.outcome });
      expect(attr(child, "eff.reason")).toEqual({ stringValue: ev.reason });
      expect(attr(child, "eff.policy_version")).toEqual({ intValue: "3" });
      expect(attr(child, "eff.evidence.count")).toEqual({ intValue: String(ev.evidence.length) });
    });
    expect(attr(children[1]!, "eff.evidence.count")).toEqual({ intValue: "2" });
  });

  it("falls back to the last event when finishedAt is missing and handles no events", () => {
    const trace = completeTrace();
    const { finishedAt: _omit, ...run } = trace.run;
    const [root] = traceToOtelSpans({ ...trace, run });
    expect(root?.endTimeUnixNano).toBe(`${T0 + 8_000}000000`);
    const bare = traceToOtelSpans({ ...trace, events: [] });
    expect(bare).toHaveLength(1);
  });
});

describe("toOtlpJson", () => {
  it("wraps spans in the OTLP/JSON resourceSpans → scopeSpans shape", () => {
    const spans = traceToOtelSpans(completeTrace());
    const otlp = toOtlpJson(spans, { serviceName: "eff-agent", serviceVersion: "2.1.0" });
    const json = JSON.parse(JSON.stringify(otlp)) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
        scopeSpans: Array<{ scope: { name: string; version?: string }; spans: OtelSpan[] }>;
      }>;
    };
    expect(json.resourceSpans).toHaveLength(1);
    const [rs] = json.resourceSpans;
    expect(rs?.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "eff-agent" } });
    expect(rs?.resource.attributes).toContainEqual({ key: "service.version", value: { stringValue: "2.1.0" } });
    expect(rs?.scopeSpans[0]?.scope).toEqual({ name: "graphflow-efficiency-agent", version: "2.1.0" });
    expect(rs?.scopeSpans[0]?.spans).toEqual(spans);
    expect(rs?.scopeSpans[0]?.spans[0]).not.toHaveProperty("parentSpanId");
  });

  it("defaults service.name and does not alias input spans", () => {
    const spans = traceToOtelSpans(completeTrace());
    const otlp = toOtlpJson(spans) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
        scopeSpans: Array<{ scope: { name: string }; spans: OtelSpan[] }>;
      }>;
    };
    const rs = otlp.resourceSpans[0]!;
    expect(rs.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "graphflow-efficiency-agent" },
    });
    expect(rs.scopeSpans[0]?.scope).toEqual({ name: "graphflow-efficiency-agent" });
    rs.scopeSpans[0]!.spans[0]!.attributes[0]!.value.stringValue = "tampered";
    expect(spans[0]?.attributes[0]?.value.stringValue).toBe("agent.task");
  });
});

describe("replay", () => {
  it("a complete trace has zero replay problems", () => {
    expect(replayProblems(completeTrace())).toEqual([]);
  });

  it("renders header, decision record, events, security, validation, oracle and result", () => {
    const lines = renderReplay(completeTrace());
    expect(lines[0]).toContain('task "fix the secret login bug in auth.ts"');
    expect(lines[0]).toContain("bugfix");
    expect(lines.some((l) => l.includes("mode=adaptive") && l.includes("worker=local-command"))).toBe(true);
    expect(lines).toContain(
      "Decision dec-1: policy v3, contract 1.0, worker 0.4.0, cache ns-main, tools git@2.45, graphflow@2.0.3"
    );
    expect(lines).toContain("[fingerprint] ok - fingerprint done (evidence: semantic:abc; project:def) @policy v3");
    expect(lines).toContain("[reuse-gate] FRESH - no cached trajectory @policy v3");
    expect(lines).toContain("Security: allow (R1) - workspace write");
    expect(lines).toContain("Validation passed: tsc=PASS, vitest=PASS");
    expect(lines).toContain("Oracle passed: repro-test=PASS");
    expect(lines).toContain("Judged: yes");
    expect(lines[lines.length - 1]).toBe("Result: success");
  });

  it("renders missing record, no events and failures", () => {
    const { record: _r, ...rest } = completeTrace({
      events: [],
      result: { success: false },
      failure: { stage: "execute", reason: "boom" },
    });
    const lines = renderReplay(rest);
    expect(lines).toContain("Decision record: missing");
    expect(lines).toContain("Events: none");
    expect(lines).toContain("Failure at execute: boom");
    expect(lines[lines.length - 1]).toBe("Result: failure");
  });

  it("flags a missing decision record", () => {
    const { record: _r, ...rest } = completeTrace();
    expect(replayProblems(rest)).toEqual(["missing decision record"]);
  });

  it("flags missing events (absent or empty)", () => {
    const { events: _e, ...rest } = completeTrace();
    expect(replayProblems(rest)).toEqual(["missing events"]);
    expect(replayProblems(completeTrace({ events: [] }))).toEqual(["missing events"]);
  });

  it("flags events that are not chronologically ordered", () => {
    const events = [...completeTrace().events!];
    const swapped = [events[0]!, events[2]!, events[1]!, ...events.slice(3)];
    const problems = replayProblems(completeTrace({ events: swapped }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/not chronologically ordered/);
  });

  it("flags invalid event timestamps", () => {
    const events = completeTrace().events!.map((e, i) => (i === 1 ? { ...e, at: "yesterday" } : e));
    expect(replayProblems(completeTrace({ events }))[0]).toMatch(/invalid timestamp/);
  });

  it('flags a trace with no "reuse-gate" event', () => {
    const events = completeTrace().events!.filter((e) => e.stage !== "reuse-gate");
    expect(replayProblems(completeTrace({ events }))).toEqual(['no "reuse-gate" event']);
  });

  it("flags success without execute/validate unless the task was reused", () => {
    const noWork = completeTrace().events!.filter((e) => e.stage !== "execute" && e.stage !== "validate");
    const problems = replayProblems(completeTrace({ events: noWork }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no "execute" or "validate" event/);

    const reused = noWork.map((e) => (e.stage === "reuse-gate" ? { ...e, outcome: "REUSE" } : e));
    expect(replayProblems(completeTrace({ events: reused }))).toEqual([]);

    // A failed task needs no execute/validate evidence to be replayable.
    expect(replayProblems(completeTrace({ events: noWork, result: { success: false } }))).toEqual([]);

    // Either execute or validate alone is enough.
    const executeOnly = completeTrace().events!.filter((e) => e.stage !== "validate");
    expect(replayProblems(completeTrace({ events: executeOnly }))).toEqual([]);
  });

  it('flags a securityDecision without a "security" event', () => {
    const events = completeTrace().events!.filter((e) => e.stage !== "security");
    expect(replayProblems(completeTrace({ events }))).toEqual([
      'securityDecision present but no "security" event',
    ]);
    const { securityDecision: _s, ...noDecision } = completeTrace({ events });
    expect(replayProblems(noDecision)).toEqual([]);
  });

  it("flags policyVersion mismatches between the record and events", () => {
    const events = completeTrace().events!.map((e, i) => (i >= 4 ? { ...e, policyVersion: 4 } : e));
    expect(replayProblems(completeTrace({ events }))).toEqual(["policyVersion mismatch: record v3 but events carry v4"]);
  });

  it("an EventRecorder-built trace replays cleanly", () => {
    let clock = T0;
    const tick = (): number => (clock += 100);
    const recorder = createEventRecorder(3, tick);
    recorder.record("flags", "ok", "loaded");
    recorder.record("reuse-gate", "REUSE", "exact fingerprint hit", ["fp-123"]);
    recorder.record("security", "allow", "read-only");
    const trace = completeTrace({ events: recorder.events() });
    expect(replayProblems(trace)).toEqual([]);
    expect(traceToOtelSpans(trace)).toHaveLength(4);
  });
});
