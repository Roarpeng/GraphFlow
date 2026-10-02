import { createHash } from "node:crypto";
import type { Measurement } from "../measurement.js";
import type { TaskTrace } from "../trace.js";

/**
 * OpenTelemetry export (spec §11) without a network dependency: a TaskTrace
 * becomes one root span plus one child span per TraceEvent, serializable as
 * OTLP/JSON for any collector. Ids are derived from trace.traceId so the same
 * trace always exports the same spans (spec §28 replayability).
 *
 * Privacy (spec §12): task text and high-cardinality identifiers (session,
 * project, fingerprint) are opt-in; event evidence is exported only as a count.
 */

export interface OtelAttributeValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

export interface OtelAttribute {
  key: string;
  value: OtelAttributeValue;
}

export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtelAttribute[];
  status: { code: 0 | 1 | 2; message?: string };
}

export interface TraceToOtelOptions {
  /** §12: the raw task text leaves the process only when explicitly enabled. */
  includeTaskText?: boolean;
  /** §12: sessionId / projectId / fingerprint are high-cardinality and opt-in. */
  includeIdentifiers?: boolean;
  serviceVersion?: string;
}

export const OTEL_SCOPE_NAME = "graphflow-efficiency-agent";
const SPAN_KIND_INTERNAL = 1;
const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/** OTLP rejects all-zero ids; sha256 output practically never is, but guard anyway. */
const nonZeroId = (hex: string): string => (/^0+$/.test(hex) ? `${hex.slice(0, -1)}1` : hex);

export function otelTraceId(traceId: string): string {
  return nonZeroId(sha256Hex(`trace:${traceId}`).slice(0, 32));
}

export function otelSpanId(traceId: string, salt: string): string {
  return nonZeroId(sha256Hex(`span:${traceId}:${salt}`).slice(0, 16));
}

const toUnixNano = (ms: number): string => (BigInt(Math.max(0, Math.trunc(ms))) * 1_000_000n).toString();

const parseMs = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
};

const str = (key: string, value: string): OtelAttribute => ({ key, value: { stringValue: value } });
const bool = (key: string, value: boolean): OtelAttribute => ({ key, value: { boolValue: value } });
const num = (key: string, value: number): OtelAttribute =>
  Number.isInteger(value)
    ? { key, value: { intValue: String(value) } }
    : { key, value: { doubleValue: value } };

const measurementAttrs = (key: string, m: Measurement | undefined): OtelAttribute[] =>
  m === undefined ? [] : [num(key, m.value), str(`${key}.provenance`, m.provenance)];

function rootAttributes(trace: TaskTrace, options: TraceToOtelOptions): OtelAttribute[] {
  const attrs: OtelAttribute[] = [str("gen_ai.operation.name", "agent.task")];
  if (trace.model) {
    attrs.push(str("gen_ai.system", trace.model.provider), str("gen_ai.request.model", trace.model.tier));
  }
  if (options.serviceVersion !== undefined) attrs.push(str("service.version", options.serviceVersion));
  attrs.push(str("eff.trace.id", trace.traceId));
  if (trace.task.taskId !== undefined) attrs.push(str("eff.task.id", trace.task.taskId));
  attrs.push(str("eff.task.category", trace.task.category));
  if (options.includeTaskText === true) attrs.push(str("eff.task.text", trace.task.text));
  if (options.includeIdentifiers === true) {
    if (trace.sessionId !== undefined) attrs.push(str("eff.session.id", trace.sessionId));
    if (trace.projectId !== undefined) attrs.push(str("eff.project.id", trace.projectId));
    if (trace.fingerprint !== undefined) attrs.push(str("eff.fingerprint", trace.fingerprint));
  }
  attrs.push(str("eff.run.mode", trace.run.mode), str("eff.run.worker", trace.run.worker));
  if (trace.decision) {
    attrs.push(str("eff.reuse_mode", trace.decision.reuseMode));
    attrs.push(...measurementAttrs("eff.decision.duration_ms", trace.decision.durationMs));
  }
  attrs.push(...measurementAttrs("eff.context.tokens", trace.context.tokens));
  attrs.push(num("eff.context.anchors", trace.context.anchors));
  attrs.push(bool("eff.cache_hit", trace.context.cacheHit));
  if (trace.context.invalidationReason !== undefined) {
    attrs.push(str("eff.cache.invalidation_reason", trace.context.invalidationReason));
  }
  attrs.push(...measurementAttrs("eff.llm.calls", trace.llm.calls));
  attrs.push(...measurementAttrs("eff.llm.input_tokens", trace.llm.inputTokens));
  attrs.push(...measurementAttrs("eff.llm.output_tokens", trace.llm.outputTokens));
  attrs.push(...measurementAttrs("eff.llm.total_tokens", trace.llm.totalTokens));
  attrs.push(...measurementAttrs("eff.llm.cost_usd", trace.llm.costUsd));
  attrs.push(...measurementAttrs("eff.rounds", trace.rounds));
  attrs.push(num("eff.tools.count", trace.tools.length));
  attrs.push(num("eff.validation.checks", trace.validation.length));
  if (trace.validationStatus !== undefined) attrs.push(str("eff.validation_status", trace.validationStatus));
  attrs.push(bool("eff.success", trace.result.success));
  if (trace.judged !== undefined) attrs.push(bool("eff.judged", trace.judged));
  if (trace.record) {
    attrs.push(
      num("eff.policy_version", trace.record.policyVersion),
      str("eff.decision_id", trace.record.decisionId),
      str("eff.cache_namespace", trace.record.cacheNamespace),
      str("eff.contract_version", trace.record.contractVersion)
    );
    if (trace.record.workerVersion !== undefined) attrs.push(str("eff.worker_version", trace.record.workerVersion));
  }
  if (trace.securityDecision) {
    attrs.push(
      str("eff.security.verdict", trace.securityDecision.verdict),
      str("eff.security.risk", trace.securityDecision.risk)
    );
  }
  attrs.push(...measurementAttrs("eff.cost.estimated", trace.cost?.estimated));
  attrs.push(...measurementAttrs("eff.cost.actual", trace.cost?.actual));
  if (trace.failure) {
    attrs.push(str("eff.failure.stage", trace.failure.stage), str("eff.failure.reason", trace.failure.reason));
  }
  return attrs;
}

export function traceToOtelSpans(trace: TaskTrace, options: TraceToOtelOptions = {}): OtelSpan[] {
  const traceId = otelTraceId(trace.traceId);
  const rootSpanId = otelSpanId(trace.traceId, "root");
  const events = trace.events ?? [];

  const startMs = parseMs(trace.run.startedAt) ?? parseMs(events[0]?.at) ?? 0;
  const lastEventMs = parseMs(events[events.length - 1]?.at);
  const endMs = Math.max(startMs, parseMs(trace.run.finishedAt) ?? lastEventMs ?? startMs);

  const failed = !trace.result.success || trace.failure !== undefined;
  const root: OtelSpan = {
    traceId,
    spanId: rootSpanId,
    name: "eff_agent.task",
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: toUnixNano(startMs),
    endTimeUnixNano: toUnixNano(endMs),
    attributes: rootAttributes(trace, options),
    status: failed
      ? { code: STATUS_ERROR, message: trace.failure ? `${trace.failure.stage}: ${trace.failure.reason}` : "task failed" }
      : { code: STATUS_OK },
  };

  const children = events.map((event, index): OtelSpan => {
    const eventStart = parseMs(event.at) ?? startMs;
    const nextAt = index + 1 < events.length ? parseMs(events[index + 1]?.at) : undefined;
    const eventEnd = Math.max(eventStart, nextAt ?? endMs);
    return {
      traceId,
      spanId: otelSpanId(trace.traceId, `event:${index}:${event.stage}`),
      parentSpanId: rootSpanId,
      name: `eff_agent.${event.stage}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: toUnixNano(eventStart),
      endTimeUnixNano: toUnixNano(eventEnd),
      attributes: [
        str("eff.stage", event.stage),
        str("eff.outcome", event.outcome),
        str("eff.reason", event.reason),
        num("eff.policy_version", event.policyVersion),
        num("eff.evidence.count", event.evidence.length),
      ],
      status: { code: STATUS_UNSET },
    };
  });

  return [root, ...children];
}

export function toOtlpJson(
  spans: OtelSpan[],
  resource: { serviceName?: string; serviceVersion?: string } = {}
): { resourceSpans: unknown[] } {
  const resourceAttributes: OtelAttribute[] = [
    str("service.name", resource.serviceName ?? OTEL_SCOPE_NAME),
    str("telemetry.sdk.name", OTEL_SCOPE_NAME),
    str("telemetry.sdk.language", "nodejs"),
  ];
  if (resource.serviceVersion !== undefined) resourceAttributes.push(str("service.version", resource.serviceVersion));
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [
          {
            scope: {
              name: OTEL_SCOPE_NAME,
              ...(resource.serviceVersion !== undefined ? { version: resource.serviceVersion } : {}),
            },
            spans: spans.map((span) => ({
              ...span,
              attributes: span.attributes.map((attr) => ({ key: attr.key, value: { ...attr.value } })),
              status: { ...span.status },
            })),
          },
        ],
      },
    ],
  };
}
