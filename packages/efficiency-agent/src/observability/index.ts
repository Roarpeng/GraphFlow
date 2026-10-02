export {
  createEventRecorder,
  MAX_EVIDENCE_CHARS,
  MAX_EVIDENCE_ITEMS,
  type EventRecorder,
} from "./events.js";
export {
  OTEL_SCOPE_NAME,
  otelSpanId,
  otelTraceId,
  toOtlpJson,
  traceToOtelSpans,
  type OtelAttribute,
  type OtelAttributeValue,
  type OtelSpan,
  type TraceToOtelOptions,
} from "./otel.js";
export { renderReplay, replayProblems } from "./replay.js";
