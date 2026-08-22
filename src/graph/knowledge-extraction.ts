import type { GraphEdge, GraphNode } from "../core/types.js";

export interface KnowledgeTurnRecord {
  turnId: string;
  query: string;
  reply: string;
}

export interface KnowledgeDocumentInput {
  text?: string;
  turns?: KnowledgeTurnRecord[];
}

export type KnowledgeExtractionInput = string | KnowledgeTurnRecord | KnowledgeDocumentInput;

export interface KnowledgeEvidence {
  /** Offset within the containing document field, query, or reply. */
  start: number;
  end: number;
  field?: "text" | "query" | "reply";
  sourceTurnId?: string;
}

export interface KnowledgeGraphNodeMetadata {
  domain: "doc";
  kind: "concept" | "requirement";
  confidence: number;
  evidence: KnowledgeEvidence[];
  sourceIds?: string[];
  sourceTurnIds?: string[];
  cue?: string;
}

export interface KnowledgeGraphFragment {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface KnowledgeExtractionOptions {
  /** Existing graph source ID, normally `file:<relative-path>`. */
  sourceNodeId?: string;
}

interface RawConcept {
  name: string;
  start: number;
  end: number;
  confidence: number;
}

const REQUIREMENT_CUES: Array<{ cue: string; pattern: RegExp; confidence: number }> = [
  { cue: "must", pattern: /\bmust(?:\s+not)?\b/i, confidence: 0.94 },
  { cue: "shall", pattern: /\bshall(?:\s+not)?\b/i, confidence: 0.95 },
  { cue: "required to", pattern: /\b(?:is\s+|are\s+)?required\s+to\b/i, confidence: 0.88 },
  { cue: "needs to", pattern: /\bneeds?\s+to\b/i, confidence: 0.84 },
  { cue: "should", pattern: /\bshould(?:\s+not)?\b/i, confidence: 0.82 },
  { cue: "必须", pattern: /必须/, confidence: 0.94 },
  { cue: "需要", pattern: /需要/, confidence: 0.86 },
  { cue: "应当", pattern: /应当|应当不/, confidence: 0.86 },
  { cue: "应该", pattern: /应该/, confidence: 0.8 },
  { cue: "不得", pattern: /不得|不能/, confidence: 0.92 },
];

const TECHNICAL_HEADS = [
  "api", "architecture", "cache", "client", "contract", "database", "design",
  "engine", "extractor", "graph", "index", "indexer", "interface", "kernel",
  "module", "parser", "pipeline", "protocol", "queue", "schema", "service",
  "storage", "store", "system", "transport", "workflow",
];

const ENGLISH_STOP_WORDS = new Set([
  "a", "all", "an", "and", "are", "as", "at", "be", "been", "but", "by",
  "can", "could", "do", "does", "for", "from", "had", "has", "have", "how",
  "i", "if", "in", "into", "is", "it", "its", "may", "might", "must", "need",
  "needs", "not", "of", "on", "or", "our", "shall", "should", "so", "that",
  "the", "their", "them", "then", "there", "these", "they", "this", "to",
  "too", "was", "we", "were", "what", "when", "where", "which", "while",
  "who", "why", "will", "with", "would", "you", "your",
]);

const CONCEPT_SUFFIXES = [
  "系统", "模块", "接口", "服务", "协议", "缓存", "队列", "架构", "引擎",
  "调度器", "数据库", "工作流", "管道", "图谱", "提取器", "设计",
];

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function nodeId(kind: "concept" | "requirement", value: string): string {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  const asciiSlug = normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/^-+|-+$/g, "");
  const digest = stableHash(`${kind}:${normalized}`);
  return `${kind}:${asciiSlug ? `${asciiSlug}-` : ""}${digest}`;
}

function normalizeCandidate(candidate: string): string {
  return candidate.replace(/[`'".,;:!?()\[\]{}<>]+$/g, "").replace(/^[`'"(\[{<]+/g, "").trim();
}

function isTechnicalCandidate(candidate: string): boolean {
  const value = normalizeCandidate(candidate);
  if (!value) return false;

  if (/[\u4e00-\u9fff]/.test(value)) {
    return CONCEPT_SUFFIXES.some((suffix) => value.endsWith(suffix));
  }

  const hasCodeShape =
    /[/_]|_|-/.test(value) ||
    /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+/.test(value) ||
    /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)+$/.test(value);
  const words = value.toLowerCase().split(/[\s/-]+/).filter(Boolean);
  const hasDottedIdentifier = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value);
  if (hasDottedIdentifier) {
    return true;
  }
  if (words.some((word) => ENGLISH_STOP_WORDS.has(word))) {
    // A stop word is acceptable inside an explicit code identifier, but not in prose phrases.
    if (!hasCodeShape || /\s/.test(value.trim())) return false;
  }
  return TECHNICAL_HEADS.includes(words.at(-1) ?? "");
}

function extractConceptsFromSegment(segment: { text: string; start: number }): RawConcept[] {
  const found = new Map<string, RawConcept>();
  const add = (raw: string, localStart: number, localEnd: number, confidence: number): void => {
    const name = normalizeCandidate(raw);
    if (name.length < 2 || name.length > 100 || !isTechnicalCandidate(name)) return;
    const previous = found.get(name.toLowerCase());
    if (!previous || previous.confidence < confidence) {
      found.set(name.toLowerCase(), {
        name,
        start: segment.start + localStart,
        end: segment.start + localEnd,
        confidence,
      });
    }
  };

  const patterns: Array<{ pattern: RegExp; confidence: number }> = [
    { pattern: /`([^`\n]{2,100})`/g, confidence: 0.96 },
    { pattern: /\b[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g, confidence: 0.95 },
    { pattern: /\b[A-Za-z][\w.-]*(?:\/[\w.-]+)+\b/g, confidence: 0.94 },
    { pattern: /\b[a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g, confidence: 0.94 },
    { pattern: /\b[A-Za-z][A-Za-z0-9_-]*(?:_[A-Za-z0-9_-]+)+\b/g, confidence: 0.93 },
    {
      pattern: new RegExp(
        `\\b(?:[A-Za-z][A-Za-z0-9-]*(?:\\s+[A-Za-z][A-Za-z0-9-]*){0,3}\\s+(?:${TECHNICAL_HEADS.join("|")}))\\b`,
        "gi"
      ),
      confidence: 0.82,
    },
    {
      pattern: new RegExp(`[\\u4e00-\\u9fff]{2,16}(?:${CONCEPT_SUFFIXES.join("|")})`, "g"),
      confidence: 0.84,
    },
  ];

  for (const { pattern, confidence } of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(segment.text)) !== null) {
      const raw = match[1] ?? match[0];
      const index = match.index + match[0].indexOf(raw);
      add(raw, index, index + raw.length, confidence);
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }

  return [...found.values()].sort((left, right) => left.start - right.start);
}

function* segments(text: string, offset = 0): Generator<{ text: string; start: number }> {
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text.at(index + 1);
    const boundary =
      char !== undefined &&
      ".?!;。！？；".includes(char) &&
      (next === undefined || /\s/.exec(next) !== null);
    const isNewline = char === "\n";
    if (!boundary && !isNewline && index < text.length - 1) continue;

    const raw = text.slice(start, isNewline ? index : index + 1);
    const cleaned = raw.trim();
    if (cleaned.length > 2) {
      const relativeStart = raw.indexOf(cleaned);
      yield {
        text: cleaned,
        start: offset + start + (relativeStart >= 0 ? relativeStart : 0),
      };
    }
    start = index + 1;
  }
}

function matchRequirementCue(text: string): { cue: string; confidence: number } | undefined {
  let best: { cue: string; confidence: number } | undefined;
  for (const item of REQUIREMENT_CUES) {
    if (item.pattern.test(text) && (best?.confidence ?? 0) < item.confidence) {
      best = { cue: item.cue, confidence: item.confidence };
    }
  }
  return best;
}

function pushEvidence(
  target: KnowledgeEvidence[],
  evidence: KnowledgeEvidence,
): void {
  if (
    !target.some(
      (item) =>
        item.start === evidence.start &&
        item.end === evidence.end &&
        item.field === evidence.field &&
        item.sourceTurnId === evidence.sourceTurnId,
    )
  ) {
    target.push(evidence);
  }
}

function processField(
  text: string,
  field: KnowledgeEvidence["field"],
  sourceTurnId?: string,
  nodesByKind?: {
    concept: Map<string, GraphNode>;
    requirement: Map<string, GraphNode>;
  },
): void {
  if (!nodesByKind) return;

  for (const segment of segments(text)) {
    const cue = matchRequirementCue(segment.text);
    const concepts = extractConceptsFromSegment(segment);

    if (cue) {
      const id = nodeId("requirement", segment.text.slice(0, 500));
      const existing = nodesByKind.requirement.get(id);
      const evidence: KnowledgeEvidence = {
        start: segment.start,
        end: segment.start + segment.text.length,
        ...(field ? { field } : {}),
        ...(sourceTurnId ? { sourceTurnId } : {}),
      };
      if (existing) {
        const metadata = existing.metadata as unknown as KnowledgeGraphNodeMetadata;
        pushEvidence(metadata.evidence, evidence);
        metadata.confidence = Math.max(metadata.confidence, cue.confidence + (concepts.length ? 0.03 : 0));
        if (metadata.confidence === cue.confidence) {
          metadata.cue = cue.cue;
        }
      } else {
        nodesByKind.requirement.set(id, {
          id,
          type: "Requirement",
          content: segment.text.slice(0, 500),
          metadata: {
            domain: "doc",
            kind: "requirement",
            confidence: Math.min(0.98, cue.confidence + (concepts.length ? 0.03 : 0)),
            cue: cue.cue,
            evidence: [evidence],
          },
        });
      }
    }

    for (const concept of concepts) {
      const id = nodeId("concept", concept.name);
      const existing = nodesByKind.concept.get(id);
      const evidence: KnowledgeEvidence = {
        start: concept.start,
        end: concept.end,
        ...(field ? { field } : {}),
        ...(sourceTurnId ? { sourceTurnId } : {}),
      };
      if (existing) {
        const metadata = existing.metadata as unknown as KnowledgeGraphNodeMetadata;
        pushEvidence(metadata.evidence, evidence);
        metadata.confidence = Math.max(metadata.confidence, concept.confidence);
      } else {
        nodesByKind.concept.set(id, {
          id,
          type: "Concept",
          content: concept.name,
          metadata: {
            domain: "doc",
            kind: "concept",
            confidence: concept.confidence,
            evidence: [evidence],
          },
        });
      }
    }
  }
}

/**
 * Extract deterministic Concept/Requirement fragments from dialogue or document text.
 * No network access or model inference is involved.
 */
export function extractEngineeringKnowledgeGraphFragment(
  input: KnowledgeExtractionInput,
  options: KnowledgeExtractionOptions = {},
): KnowledgeGraphFragment {
  const document: KnowledgeDocumentInput =
    typeof input === "string"
      ? { text: input }
      : "turnId" in input
        ? { turns: [input] }
        : input;

  const concepts = new Map<string, GraphNode>();
  const requirements = new Map<string, GraphNode>();
  const maps = { concept: concepts, requirement: requirements };

  processField(document.text ?? "", "text", undefined, maps);
  for (const turn of document.turns ?? []) {
    const turnId = turn.turnId.trim();
    processField(turn.query ?? "", "query", turnId || undefined, maps);
    processField(turn.reply ?? "", "reply", turnId || undefined, maps);
  }

  const nodes = [...requirements.values(), ...concepts.values()];
  const sourceIds = new Set(options.sourceNodeId ? [options.sourceNodeId] : []);
  const edges = new Map<string, GraphEdge>();
  for (const node of nodes) {
    const metadata = node.metadata as unknown as KnowledgeGraphNodeMetadata;
    const turnIds = metadata.evidence
      .map((item) => item.sourceTurnId)
      .filter((item): item is string => Boolean(item));
    if (turnIds.length > 0) metadata.sourceTurnIds = [...new Set(turnIds)];

    for (const sourceId of sourceIds) {
      edges.set(`${node.id}\u0000${sourceId}`, {
        from: node.id,
        to: sourceId,
        relation: "derived_from",
      });
    }
    if (sourceIds.size > 0) metadata.sourceIds = [...sourceIds];
  }

  return { nodes, edges: [...edges.values()] };
}

/** Descriptive alias preferred by integrations that treat this as a graph adapter. */
export const extractKnowledgeGraphFragment = extractEngineeringKnowledgeGraphFragment;
