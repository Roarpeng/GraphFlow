/**
 * Point-in-time fact queries ("时点查询") over the dialogue graph's
 * bi-temporal edges (Conversation Graph 2.0: supersedes + validAt/invalidAt).
 *
 * Motivation: facts drift. Asking "what is the current pricing policy" must
 * answer the version effective NOW, not replay three historical revisions;
 * asking "which version applied when we signed in March" must be answered
 * against that point in time. This module productizes those semantics:
 *
 *   - recall is DELEGATED to searchDialogueTurns (includeSuperseded on) so
 *     ranking/matching stays in one place;
 *   - the returned hits are joined back onto full DialogueTurnRecords
 *     (DialogueSearchHit carries only a `superseded` flag, not the raw
 *     validAt/invalidAt epochs needed for boundary comparisons);
 *   - each fact is bucketed by the asOf instant:
 *       effective          validAt <= asOf AND (invalidAt missing OR > asOf)
 *       supersededAtPoint  invalidAt <= asOf (the "old story" at that time)
 *       (dropped)          validAt > asOf — a future version, not yet true
 *
 * Boundary semantics: validAt == asOf counts as effective (it became true at
 * that instant); invalidAt == asOf counts as expired (it stopped being true
 * at that instant).
 *
 * All timestamps are normalised to canonical ISO strings before comparison,
 * and a missing validAt is treated as infinitely early. Failures fail open:
 * an empty report plus an advisory sentence, never a thrown error.
 */
import type { GraphClient } from "./client-factory";
import { searchDialogueTurns } from "./graph-search";
import type { DialogueSearchHit } from "./graph-search";
import { listDialogueTurns } from "../learning/dialogue-thread";
import type { DialogueTurnRecord } from "../learning/dialogue-thread";

export interface TemporalFactOptions {
  /** Free-text recall query (same matching as searchDialogueTurns). */
  query: string;
  /** Point-in-time (ISO 8601). Defaults to `now` (injectable) / wall clock. */
  asOf?: string;
  /** Max recalled turns (passed through to searchDialogueTurns). */
  limit?: number;
}

export interface EffectiveFact {
  turnId: string;
  /** 该轮结论摘要：summary → title → assistantReply/userQuery 截断。 */
  summary: string;
  /** Canonical ISO instant when this conclusion became effective. */
  validAt?: string;
  /** Canonical ISO instant when this conclusion stopped being current. */
  invalidAt?: string;
  /** ids of earlier turns this conclusion corrected/replaced. */
  supersedesTurnIds?: string[];
}

export interface TemporalFactReport {
  query: string;
  /** Explicit asOf or the default instant (ISO; `now` injectable for tests). */
  asOf: string;
  /** Conclusions still effective at asOf (validAt <= asOf, invalidAt missing or > asOf). */
  effective: EffectiveFact[];
  /** Conclusions already superseded at/before asOf (the historical "old story"). */
  supersededAtPoint: EffectiveFact[];
  /** True when effective is empty (including the fail-open path). */
  unresolved: boolean;
  /** One-sentence Chinese advisory (empty-result guidance / failure note). */
  advisory: string;
}

/** Mirrors searchDialogueTurns' internal turn-scan window so the join sees every hit. */
const TURN_JOIN_WINDOW = 120;
const SUMMARY_MAX_CHARS = 200;

/** Bucket for one recalled fact relative to the asOf instant. */
type FactBucket = "effective" | "superseded" | "future";

/**
 * Query the dialogue graph for conclusions effective at a given instant.
 * Reuses searchDialogueTurns for recall (with superseded turns included),
 * then splits hits by bi-temporal validity against `asOf`.
 */
export async function queryFactsAt(
  client: GraphClient,
  options: TemporalFactOptions & { now?: string }
): Promise<TemporalFactReport> {
  const query = options.query;
  const asOf = resolveAsOf(options);

  try {
    // 召回：打开 includeSuperseded，历史版本先全部取回，再按时点分流。
    const searchOptions: { limit?: number; includeSuperseded: boolean } = {
      includeSuperseded: true,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };
    const hits = await searchDialogueTurns(client, query, searchOptions);

    // Hits don't carry raw epochs — join full records for validAt/invalidAt.
    // This call also doubles as failure detection: searchDialogueTurns swallows
    // its own errors (returns []), while listDialogueTurns lets them propagate.
    const turns = await listDialogueTurns(client, { limit: TURN_JOIN_WINDOW });
    const byId = new Map(turns.map((turn) => [turn.id, turn]));

    const effective: EffectiveFact[] = [];
    const supersededAtPoint: EffectiveFact[] = [];
    for (const hit of hits) {
      const fact = toEffectiveFact(hit, byId.get(hit.id));
      const bucket = classifyAt(fact, hit.superseded, asOf);
      if (bucket === "effective") {
        effective.push(fact);
      } else if (bucket === "superseded") {
        supersededAtPoint.push(fact);
      }
      // "future" (validAt after asOf): not yet true at this instant — dropped.
    }

    return {
      query,
      asOf,
      effective,
      supersededAtPoint,
      unresolved: effective.length === 0,
      advisory: buildAdvisory(effective.length, supersededAtPoint.length, asOf),
    };
  } catch {
    return failOpenReport(query, asOf);
  }
}

/** asOf precedence: explicit asOf > injected now > wall clock, canonicalised to ISO. */
function resolveAsOf(options: { asOf?: string; now?: string }): string {
  const raw = options.asOf ?? options.now ?? new Date().toISOString();
  return normalizeIso(raw) ?? new Date().toISOString();
}

/** Canonicalise any parseable instant to `new Date(...).toISOString()` form. */
function normalizeIso(value: string): string | undefined {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** Convert a stored ms-epoch (possibly missing/NaN) to canonical ISO. */
function epochToIso(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return normalizeIso(new Date(value).toISOString());
}

function clipText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…`;
}

/** Build one fact from a recall hit, enriched with the record's temporal fields. */
function toEffectiveFact(hit: DialogueSearchHit, record: DialogueTurnRecord | undefined): EffectiveFact {
  const validAt = record !== undefined ? epochToIso(record.validAt) : undefined;
  const invalidAt = record !== undefined ? epochToIso(record.invalidAt) : undefined;
  const supersedesTurnIds = record?.supersedesTurnIds;
  return {
    turnId: hit.id,
    summary: summarizeFact(hit, record),
    ...(validAt !== undefined ? { validAt } : {}),
    ...(invalidAt !== undefined ? { invalidAt } : {}),
    ...(supersedesTurnIds !== undefined && supersedesTurnIds.length > 0
      ? { supersedesTurnIds: [...supersedesTurnIds] }
      : {}),
  };
}

/** summary 回退链：record.summary → hit.summary → title × 2 → assistantReply/userQuery 截断。 */
function summarizeFact(hit: DialogueSearchHit, record: DialogueTurnRecord | undefined): string {
  const candidates = [
    record?.summary,
    hit.summary,
    record?.title,
    hit.title,
    record !== undefined ? clipText(record.assistantReply, SUMMARY_MAX_CHARS) : undefined,
    hit.userQuery,
  ];
  for (const candidate of candidates) {
    const text = candidate?.trim();
    if (text) return clipText(text, SUMMARY_MAX_CHARS);
  }
  return "(无摘要)";
}

/**
 * Classify one fact against asOf. All comparisons are canonical-ISO string
 * comparisons: missing validAt = infinitely early, missing invalidAt = still
 * current. `hitSuperseded` only acts as a fallback when the record join
 * missed (normally the record is present and decides alone).
 */
function classifyAt(fact: EffectiveFact, hitSuperseded: boolean, asOf: string): FactBucket {
  if (fact.validAt !== undefined && fact.validAt > asOf) return "future";
  if (fact.invalidAt === undefined) {
    return hitSuperseded ? "superseded" : "effective";
  }
  return fact.invalidAt > asOf ? "effective" : "superseded";
}

function buildAdvisory(effectiveCount: number, supersededCount: number, asOf: string): string {
  if (effectiveCount === 0) {
    return `在 ${asOf} 时点未找到仍有效的结论，建议更换 query 关键词或确认 asOf 时点后重试。`;
  }
  return `以 ${asOf} 为时点：${effectiveCount} 条结论有效，${supersededCount} 条历史结论已归入 supersededAtPoint 供追溯。`;
}

/** Fail-open：检索/读取异常时返回空报告 + 说明，绝不向上抛。 */
function failOpenReport(query: string, asOf: string): TemporalFactReport {
  return {
    query,
    asOf,
    effective: [],
    supersededAtPoint: [],
    unresolved: true,
    advisory: `时点事实检索失败（fail-open）：已按空结果返回，请确认图谱可查询后重试，或调整 query / asOf 时点。`,
  };
}
