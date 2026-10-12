/**
 * scip-ingest.ts — parse and ingest a Sourcegraph SCIP index into the graph.
 *
 * SCIP (github.com/sourcegraph/scip) is a precise code-intelligence protobuf
 * format. A .scip file is a stream of length-delimited protobuf messages:
 * zero or more standalone `Document` messages followed by one final `Index`
 * message (scip-typescript emits standalone Documents and an Index whose
 * `documents` may additionally carry copies). Messages are NOT compressed.
 *
 * Ingest mapping (complements the tree-sitter name-matched reference edges
 * from file-indexer-edges.ts; SCIP edges are exact, which is the
 * "SCIP as LLM antihallucinogen" angle):
 *
 * - definition occurrence (symbol_roles & 1)
 *     → Symbol node `scip:{raw scip symbol}` (metadata.scipSymbol keeps the
 *       raw symbol string) + `defines` edge `file:{relative_path}` → symbol
 * - reference occurrence (any other roles)
 *     → `references` edge `file:{relative_path}` → `scip:{raw symbol}`.
 *       SCIP reference occurrences do not carry the referencing symbol name,
 *       so the edge source is the document's FILE node — the same file-level
 *       convention buildBatchReferenceEdges uses for tree-sitter edges.
 * - reference to a symbol with no definition anywhere in the index
 *     → stub Symbol node (metadata.external = true) so the edge never dangles.
 *
 * Id conventions follow file-indexer-nodes.ts: `file:{relPath}` for files
 * (paths normalized to forward slashes). `scip:` is a new, collision-free
 * prefix owned by this ingest — it never overwrites tree-sitter `symbol:`
 * nodes. Existing `file:` nodes are NOT overwritten (a minimal node would
 * clobber the richer File node from workspace indexing); they are only
 * created when missing.
 */

import { isAbsolute, relative as relativePath } from "node:path";
import type { GraphEdge, GraphNode } from "../../core/types.js";
import type { GraphClient } from "../client-factory.js";
import { logger } from "../../utils/logger.js";
import { ProtobufParseError, ProtobufReader, forEachField } from "./protobuf.js";

/** SymbolRoles.Definition (scip.proto: `Definition = 1 << 0`). */
export const SCIP_SYMBOL_ROLE_DEFINITION = 1 << 0;

/** Structural .scip errors (empty stream, truncated message) reuse the protobuf error type. */
export class ScipFormatError extends ProtobufParseError {
  constructor(message: string, offset: number) {
    super(message, offset);
    this.name = "ScipFormatError";
  }
}

// ---------------------------------------------------------------------------
// Field numbers from the official scip.proto.
// ---------------------------------------------------------------------------
// Index: metadata=1, documents=2, external_symbols=3, symbols=4
const INDEX_DOCUMENTS_FIELD = 2;
// Document: relative_path=1, occurrences=5, symbols=6
const DOCUMENT_RELATIVE_PATH_FIELD = 1;
const DOCUMENT_OCCURRENCES_FIELD = 5;
const DOCUMENT_SYMBOLS_FIELD = 6;
// Occurrence: range=1 (repeated int32), symbol=2, symbol_roles=3, syntax_kind=4, override_documentation=5, diagnostics=7
const OCCURRENCE_RANGE_FIELD = 1;
const OCCURRENCE_SYMBOL_FIELD = 2;
const OCCURRENCE_SYMBOL_ROLES_FIELD = 3;
// SymbolInformation: symbol=1, kind=2, documentation=3, relationships=4
const SYMBOL_INFO_SYMBOL_FIELD = 1;
const SYMBOL_INFO_DOCUMENTATION_FIELD = 3;

export interface ScipOccurrence {
  /** [startLine, startChar, endLine, endChar] (some languages append extra ints). */
  range: number[];
  symbol: string;
  symbolRoles: number;
}

export interface ScipSymbolInformation {
  symbol: string;
  documentation: string[];
}

export interface ScipDocument {
  relativePath: string;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
}

export interface ScipParsed {
  documents: ScipDocument[];
  /** Standalone stream chunks that failed to parse (logged, never fatal). */
  malformedDocuments: number;
}

function parseOccurrence(bytes: Uint8Array, origin: number): ScipOccurrence {
  const occurrence: ScipOccurrence = { range: [], symbol: "", symbolRoles: 0 };
  forEachField(bytes, origin, (fieldNumber, wireType, reader) => {
    if (fieldNumber === OCCURRENCE_RANGE_FIELD) {
      // `range` is repeated int32: accept both the packed (wire 2) and the
      // unpacked (wire 0) encoding — proto3 encoders pack by default, but the
      // field predates that convention and hand-written emitters vary.
      if (wireType === 0) {
        occurrence.range.push(reader.readVarint());
        return true;
      }
      if (wireType === 2) {
        const packed = reader.readLengthDelimited();
        const packedReader = new ProtobufReader(packed, reader.offset - packed.length);
        while (!packedReader.atEnd()) {
          occurrence.range.push(packedReader.readVarint());
        }
        return true;
      }
      return false;
    }
    if (fieldNumber === OCCURRENCE_SYMBOL_FIELD && wireType === 2) {
      occurrence.symbol = reader.readString();
      return true;
    }
    if (fieldNumber === OCCURRENCE_SYMBOL_ROLES_FIELD && wireType === 0) {
      occurrence.symbolRoles = reader.readVarint();
      return true;
    }
    return false;
  });
  return occurrence;
}

function parseSymbolInformation(bytes: Uint8Array, origin: number): ScipSymbolInformation {
  const info: ScipSymbolInformation = { symbol: "", documentation: [] };
  forEachField(bytes, origin, (fieldNumber, wireType, reader) => {
    if (fieldNumber === SYMBOL_INFO_SYMBOL_FIELD && wireType === 2) {
      info.symbol = reader.readString();
      return true;
    }
    if (fieldNumber === SYMBOL_INFO_DOCUMENTATION_FIELD && wireType === 2) {
      info.documentation.push(reader.readString());
      return true;
    }
    return false;
  });
  return info;
}

function parseDocument(bytes: Uint8Array, origin: number): ScipDocument {
  const document: ScipDocument = { relativePath: "", occurrences: [], symbols: [] };
  forEachField(bytes, origin, (fieldNumber, wireType, reader) => {
    if (fieldNumber === DOCUMENT_RELATIVE_PATH_FIELD && wireType === 2) {
      document.relativePath = reader.readString();
      return true;
    }
    if (fieldNumber === DOCUMENT_OCCURRENCES_FIELD && wireType === 2) {
      const sub = reader.readSubmessage();
      document.occurrences.push(parseOccurrence(sub.bytes, sub.origin));
      return true;
    }
    if (fieldNumber === DOCUMENT_SYMBOLS_FIELD && wireType === 2) {
      const sub = reader.readSubmessage();
      document.symbols.push(parseSymbolInformation(sub.bytes, sub.origin));
      return true;
    }
    return false;
  });
  return document;
}

/** Parse the final Index message (only `documents` is interpreted). */
function parseIndexMessage(bytes: Uint8Array, origin: number): ScipDocument[] {
  const documents: ScipDocument[] = [];
  forEachField(bytes, origin, (fieldNumber, wireType, reader) => {
    if (fieldNumber === INDEX_DOCUMENTS_FIELD && wireType === 2) {
      const sub = reader.readSubmessage();
      documents.push(parseDocument(sub.bytes, sub.origin));
      return true;
    }
    return false;
  });
  return documents;
}

/**
 * Walk the length-delimited message stream of a .scip file.
 *
 * The LAST message is the Index (metadata, external_symbols and global
 * symbols are skipped as uninterpreted fields); earlier standalone Document
 * messages are also accepted. Documents are deduped by relative_path with the
 * Index copy preferred. Malformed standalone documents are logged and counted
 * instead of failing the parse — one bad chunk must not abort the ingest —
 * while a malformed stream structure or Index throws a typed error.
 */
export function parseScipIndex(bytes: Uint8Array): ScipParsed {
  const reader = new ProtobufReader(bytes);
  const standalone: ScipDocument[] = [];
  let malformedDocuments = 0;

  // The stream has no explicit terminator: a chunk is only known to be "not
  // the last one" once a following chunk has been read. So each iteration
  // first commits the PREVIOUS chunk as a standalone Document, then reads the
  // next one; the chunk left over after the loop is the Index.
  let pending: { bytes: Uint8Array; origin: number } | undefined;
  while (!reader.atEnd()) {
    if (pending) {
      try {
        standalone.push(parseDocument(pending.bytes, pending.origin));
      } catch (err) {
        malformedDocuments += 1;
        logger.warn(
          { origin: pending.origin, err: err instanceof Error ? err.message : String(err) },
          "[graphflow] scip parse: skipping malformed standalone document"
        );
      }
    }
    pending = reader.readSubmessage();
  }

  if (!pending) {
    throw new ScipFormatError("empty .scip stream: no messages", 0);
  }

  // The Index is strict: a corrupt Index means the file itself is unusable.
  const indexDocuments = parseIndexMessage(pending.bytes, pending.origin);

  // Dedupe by relative_path, preferring the Index copy (Map.set on an existing
  // key replaces the value while keeping first-seen insertion order).
  const byPath = new Map<string, ScipDocument>();
  for (const doc of standalone) {
    if (doc.relativePath) {
      byPath.set(doc.relativePath, doc);
    }
  }
  for (const doc of indexDocuments) {
    if (doc.relativePath) {
      byPath.set(doc.relativePath, doc);
    }
  }
  return { documents: [...byPath.values()], malformedDocuments };
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/** Per-file occurrence cap (default); 0 disables the limit. */
export const DEFAULT_MAX_OCCURRENCES_PER_FILE = 5000;

export interface ScipIngestOptions {
  maxOccurrencesPerFile?: number;
  /** Workspace root; used to relativize absolute relative_path values. */
  root?: string;
}

export interface ScipIngestSummary {
  documents: number;
  symbolsCreated: number;
  edgesCreated: number;
  skippedDocuments: number;
}

function scipSymbolNodeId(symbol: string): string {
  return `scip:${symbol}`;
}

/** Best-effort display name: the last descriptor of the scip symbol string. */
function scipSymbolDisplayName(symbol: string): string {
  const parts = symbol.split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? symbol;
  const name = last.replace(/[()#?!].*$/, "").replace(/\/+$/, "");
  return name || symbol;
}

/** Normalize a scip relative_path to forward-slash workspace-relative form. */
function normalizeRelPath(rawPath: string, root?: string): string {
  let path = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (root && isAbsolute(path)) {
    const rel = relativePath(root, path).replace(/\\/g, "/");
    if (rel !== "" && !rel.startsWith("..")) {
      path = rel;
    }
  }
  return path;
}

function buildSymbolNode(
  symbol: string,
  defining: { file: string; line: number } | undefined,
  info: ScipSymbolInformation | undefined
): GraphNode {
  const name = scipSymbolDisplayName(symbol);
  const documentation = info?.documentation
    ?.slice(0, 3)
    .map((entry) => entry.slice(0, 500))
    .filter((entry) => entry.length > 0);
  return {
    id: scipSymbolNodeId(symbol),
    type: "Symbol",
    content: defining
      ? `scip ${name} (${symbol}) @${defining.file}:${defining.line}`
      : `scip ${name} (${symbol}) [external]`,
    metadata: {
      scipSymbol: symbol,
      name,
      source: "scip",
      ...(defining ? { file: defining.file, line: defining.line } : { external: true }),
      ...(documentation && documentation.length > 0 ? { documentation } : {}),
    },
  };
}

function pushDedupedEdge(edges: GraphEdge[], seen: Set<string>, from: string, to: string, relation: GraphEdge["relation"]): void {
  const key = `${from}|${relation}|${to}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  edges.push({ from, to, relation });
}

/** One document's node/edge batch. Pure — store writes happen in the caller. */
function buildDocumentBatch(
  doc: ScipDocument,
  definitions: Map<string, { file: string; line: number }>,
  createdSymbols: Set<string>,
  existingFileIds: Set<string>,
  seenEdges: Set<string>,
  root: string | undefined
): { nodes: GraphNode[]; edges: GraphEdge[]; symbols: number } {
  const relPath = normalizeRelPath(doc.relativePath, root);
  const fileNodeId = `file:${relPath}`;
  const symbolInfoBySymbol = new Map(doc.symbols.map((info) => [info.symbol, info]));

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let symbols = 0;

  // Never overwrite a richer existing file node from workspace indexing.
  if (!existingFileIds.has(fileNodeId)) {
    existingFileIds.add(fileNodeId);
    nodes.push({
      id: fileNodeId,
      type: "File",
      content: relPath,
      metadata: { path: relPath, source: "scip" },
    });
  }

  const createSymbolNodeIfNeeded = (symbol: string): string => {
    const nodeId = scipSymbolNodeId(symbol);
    if (!createdSymbols.has(nodeId)) {
      createdSymbols.add(nodeId);
      nodes.push(buildSymbolNode(symbol, definitions.get(symbol), symbolInfoBySymbol.get(symbol)));
      symbols += 1;
    }
    return nodeId;
  };

  for (const occurrence of doc.occurrences) {
    if (!occurrence.symbol) {
      continue;
    }
    const isDefinition = (occurrence.symbolRoles & SCIP_SYMBOL_ROLE_DEFINITION) !== 0;
    const symbolNodeId = scipSymbolNodeId(occurrence.symbol);
    if (isDefinition) {
      // Only the defining document materializes the rich node; other docs
      // merely point at it.
      const defining = definitions.get(occurrence.symbol);
      if (defining?.file === relPath) {
        createSymbolNodeIfNeeded(occurrence.symbol);
      }
      pushDedupedEdge(edges, seenEdges, fileNodeId, symbolNodeId, "defines");
    } else {
      if (!definitions.has(occurrence.symbol)) {
        // External symbol (defined outside this index): stub node so the
        // references edge never dangles.
        createSymbolNodeIfNeeded(occurrence.symbol);
      }
      pushDedupedEdge(edges, seenEdges, fileNodeId, symbolNodeId, "references");
    }
  }

  return { nodes, edges, symbols };
}

/**
 * Ingest a parsed .scip buffer into the graph as precise defines/references
 * edges. Per-document failure-safe: a document that exceeds
 * `maxOccurrencesPerFile` (default {@link DEFAULT_MAX_OCCURRENCES_PER_FILE},
 * 0 disables) or whose batch write throws is skipped with a counted skip and
 * a warning log; the ingest itself only throws when the whole file cannot be
 * parsed (typed ProtobufParseError / ScipFormatError).
 */
export async function ingestScipIndex(
  client: GraphClient,
  bytes: Uint8Array,
  options: ScipIngestOptions = {}
): Promise<ScipIngestSummary> {
  const maxOccurrences =
    options.maxOccurrencesPerFile ?? DEFAULT_MAX_OCCURRENCES_PER_FILE;
  const root = options.root;

  const parsed = parseScipIndex(bytes);
  const summary: ScipIngestSummary = {
    documents: 0,
    symbolsCreated: 0,
    edgesCreated: 0,
    skippedDocuments: parsed.malformedDocuments,
  };

  const cap = maxOccurrences > 0 ? Math.floor(maxOccurrences) : 0;
  const accepted = parsed.documents.filter((doc) => {
    if (cap > 0 && doc.occurrences.length > cap) {
      summary.skippedDocuments += 1;
      logger.warn(
        { path: doc.relativePath, occurrences: doc.occurrences.length, cap },
        "[graphflow] scip ingest: document exceeds maxOccurrencesPerFile, skipping"
      );
      return false;
    }
    return true;
  });

  if (accepted.length === 0) {
    return summary;
  }

  // Global definition map first (first definition wins), so a reference in an
  // early document never materializes a stub for a symbol defined later.
  const definitions = new Map<string, { file: string; line: number }>();
  for (const doc of accepted) {
    const relPath = normalizeRelPath(doc.relativePath, root);
    for (const occurrence of doc.occurrences) {
      if (!occurrence.symbol || definitions.has(occurrence.symbol)) {
        continue;
      }
      if ((occurrence.symbolRoles & SCIP_SYMBOL_ROLE_DEFINITION) !== 0) {
        definitions.set(occurrence.symbol, { file: relPath, line: occurrence.range[0] ?? 0 });
      }
    }
  }

  // Which file nodes already exist (one lookup for the whole ingest — never a
  // per-document readSnapshot). Missing ones are created; existing richer
  // File nodes from workspace indexing are left untouched.
  const fileNodeIds = new Set(
    accepted.map((doc) => `file:${normalizeRelPath(doc.relativePath, root)}`)
  );
  const existingFileIds = new Set<string>();
  if (client.getNodesByIds) {
    try {
      const existing = await client.getNodesByIds([...fileNodeIds]);
      for (const node of existing) {
        existingFileIds.add(node.id);
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "[graphflow] scip ingest: getNodesByIds unavailable, creating file nodes unconditionally"
      );
    }
  }

  const createdSymbols = new Set<string>();
  const seenEdges = new Set<string>();

  for (const doc of accepted) {
    try {
      const batch = buildDocumentBatch(
        doc,
        definitions,
        createdSymbols,
        existingFileIds,
        seenEdges,
        root
      );
      if (batch.nodes.length > 0 && batch.edges.length > 0) {
        if (client.upsertGraph) {
          await client.upsertGraph({ nodes: batch.nodes, edges: batch.edges });
        } else {
          await client.upsertNodes(batch.nodes);
          await client.upsertEdges(batch.edges);
        }
      } else if (batch.nodes.length > 0) {
        await client.upsertNodes(batch.nodes);
      } else if (batch.edges.length > 0) {
        await client.upsertEdges(batch.edges);
      }
      summary.documents += 1;
      summary.symbolsCreated += batch.symbols;
      summary.edgesCreated += batch.edges.length;
    } catch (err) {
      summary.skippedDocuments += 1;
      logger.warn(
        { path: doc.relativePath, err: err instanceof Error ? err.message : String(err) },
        "[graphflow] scip ingest: document batch failed, skipping"
      );
    }
  }

  return summary;
}
