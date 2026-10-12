/**
 * tests/scip-ingest.test.ts — SCIP index ingestion.
 *
 * The .scip fixtures are hand-encoded in-test with a tiny protobuf ENCODER
 * (varint / tag / length-delimited — the exact mirror of what the reader
 * parses), so the tests are self-contained and pin the wire format without
 * any dependency.
 */
import { describe, expect, it } from "vitest";
import { GraphifyClient } from "../src/graph/graphify-client";
import { ProtobufParseError } from "../src/graph/scip/protobuf";
import {
  DEFAULT_MAX_OCCURRENCES_PER_FILE,
  ingestScipIndex,
  parseScipIndex,
} from "../src/graph/scip/scip-ingest";
import type { GraphEdge, GraphNode } from "../src/core/types";

// ---------------------------------------------------------------------------
// Test-side protobuf encoder (fields the parser reads + unknown-field probes)
// ---------------------------------------------------------------------------
const textEncoder = new TextEncoder();

function varint(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`bad varint input: ${value}`);
  }
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (rest > 0);
  return out;
}

function tag(fieldNumber: number, wireType: number): number[] {
  return varint((fieldNumber << 3) | wireType);
}

function varintField(fieldNumber: number, value: number): number[] {
  return [...tag(fieldNumber, 0), ...varint(value)];
}

function toBytes(payload: number[] | Uint8Array | string): number[] {
  if (typeof payload === "string") {
    return Array.from(textEncoder.encode(payload));
  }
  return Array.from(payload);
}

function bytesField(fieldNumber: number, payload: number[] | Uint8Array | string): number[] {
  const body = toBytes(payload);
  return [...tag(fieldNumber, 2), ...varint(body.length), ...body];
}

/** A .scip stream entry: varint message length + message bytes. */
function streamChunk(message: number[]): number[] {
  return [...varint(message.length), ...message];
}

interface OccurrenceOptions {
  symbol: string;
  /** symbol_roles varint (field 3). */
  roles?: number;
  /** Unpacked repeated range (field 1, wire 0). */
  range?: number[];
  /** Packed repeated range (field 1, wire 2) — alternate legal encoding. */
  packedRange?: number[];
  /** Extra raw bytes appended inside the occurrence message. */
  extra?: number[];
}

function occurrenceBytes(options: OccurrenceOptions): number[] {
  let out: number[] = [];
  for (const value of options.range ?? []) {
    out.push(...varintField(1, value));
  }
  if (options.packedRange) {
    out.push(...bytesField(1, options.packedRange.flatMap((value) => varint(value))));
  }
  out.push(...bytesField(2, options.symbol));
  if (options.roles !== undefined) {
    out.push(...varintField(3, options.roles));
  }
  out.push(...(options.extra ?? []));
  return out;
}

function documentBytes(relativePath: string, occurrences: number[][], extra: number[] = []): number[] {
  let out = bytesField(1, relativePath);
  for (const occurrence of occurrences) {
    out.push(...bytesField(5, occurrence));
  }
  out.push(...extra);
  return out;
}

function indexBytes(documents: number[][], extra: number[] = []): number[] {
  let out: number[] = [];
  for (const doc of documents) {
    out.push(...bytesField(2, doc));
  }
  out.push(...extra);
  return out;
}

function scipBytes(standaloneDocuments: number[][], index: number[]): Uint8Array {
  const out: number[] = [];
  for (const doc of standaloneDocuments) {
    out.push(...streamChunk(doc));
  }
  out.push(...streamChunk(index));
  return Uint8Array.from(out);
}

const SYMBOL = "x y z";

function snapshotOf(client: GraphifyClient): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return client.readSnapshot();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("scip ingest", () => {
  it("creates a precise Symbol node and file-level defines/references edges from a definition + a reference", async () => {
    const docA = documentBytes("src/a.ts", [
      occurrenceBytes({ symbol: SYMBOL, roles: 1, range: [3, 0, 3, 1] }),
    ]);
    const docB = documentBytes("src/b.ts", [
      occurrenceBytes({ symbol: SYMBOL, roles: 2, range: [7, 2, 7, 3] }),
    ]);
    const bytes = scipBytes([docA, docB], indexBytes([]));

    const parsed = parseScipIndex(bytes);
    expect(parsed.documents.map((doc) => doc.relativePath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parsed.malformedDocuments).toBe(0);

    const client = new GraphifyClient();
    const summary = await ingestScipIndex(client, bytes);

    expect(summary).toEqual({
      documents: 2,
      symbolsCreated: 1,
      edgesCreated: 2,
      skippedDocuments: 0,
    });

    const { nodes, edges } = snapshotOf(client);
    const symbolNode = nodes.find((node) => node.id === `scip:${SYMBOL}`);
    expect(symbolNode).toBeDefined();
    expect(symbolNode?.type).toBe("Symbol");
    expect(symbolNode?.metadata?.scipSymbol).toBe(SYMBOL);
    expect(symbolNode?.metadata?.file).toBe("src/a.ts");
    expect(symbolNode?.metadata?.line).toBe(3);
    expect(symbolNode?.metadata?.source).toBe("scip");

    // File context nodes exist so no edge endpoint dangles.
    for (const fileId of ["file:src/a.ts", "file:src/b.ts"]) {
      const fileNode = nodes.find((node) => node.id === fileId);
      expect(fileNode?.type).toBe("File");
    }

    expect(edges).toContainEqual({ from: "file:src/a.ts", to: `scip:${SYMBOL}`, relation: "defines" });
    expect(edges).toContainEqual({ from: "file:src/b.ts", to: `scip:${SYMBOL}`, relation: "references" });
  });

  it("accepts documents embedded in the final Index message and prefers the Index copy on relative_path collision", async () => {
    // Standalone copy of src/a.ts only references the symbol; the Index copy
    // defines it. The Index copy must win the dedupe.
    const standaloneA = documentBytes("src/a.ts", [
      occurrenceBytes({ symbol: SYMBOL, roles: 0, range: [0, 0, 0, 1] }),
    ]);
    const indexA = documentBytes("src/a.ts", [
      occurrenceBytes({ symbol: SYMBOL, roles: 1, range: [5, 0, 5, 2] }),
    ]);
    const indexB = documentBytes("src/b.ts", [
      occurrenceBytes({ symbol: SYMBOL, roles: 0, range: [1, 0, 1, 1] }),
    ]);
    const bytes = scipBytes([standaloneA], indexBytes([indexA, indexB]));

    const parsed = parseScipIndex(bytes);
    expect(parsed.documents).toHaveLength(2);
    const docA = parsed.documents.find((doc) => doc.relativePath === "src/a.ts");
    expect(docA?.occurrences).toHaveLength(1);
    expect(docA?.occurrences[0]?.symbolRoles & 1).toBe(1);
    expect(docA?.occurrences[0]?.range).toEqual([5, 0, 5, 2]);

    const client = new GraphifyClient();
    const summary = await ingestScipIndex(client, bytes);
    expect(summary.documents).toBe(2);
    expect(summary.symbolsCreated).toBe(1);
    expect(summary.edgesCreated).toBe(2);
    const { nodes, edges } = snapshotOf(client);
    // The preferred (Index) definition line survives into the symbol node.
    expect(nodes.find((node) => node.id === `scip:${SYMBOL}`)?.metadata?.line).toBe(5);
    expect(edges).toContainEqual({ from: "file:src/a.ts", to: `scip:${SYMBOL}`, relation: "defines" });
    expect(edges).toContainEqual({ from: "file:src/b.ts", to: `scip:${SYMBOL}`, relation: "references" });
  });

  it("skips unknown fields across wire types 0, 1, 5 and 2 (document, occurrence and index level) and decodes packed ranges", async () => {
    const unknowns = [
      ...varintField(100, 12345), // wire 0
      ...tag(99, 1), 1, 2, 3, 4, 5, 6, 7, 8, // wire 1 (fixed64)
      ...tag(98, 5), 9, 9, 9, 9, // wire 5 (fixed32)
      ...bytesField(97, "unknown payload"), // wire 2
    ];
    const occurrence = occurrenceBytes({
      symbol: SYMBOL,
      roles: 1,
      packedRange: [3, 0, 3, 9],
      extra: [...bytesField(200, "occurrence unknown"), ...varintField(201, 7)],
    });
    const doc = documentBytes("src/unknown.ts", [occurrence], unknowns);
    const bytes = scipBytes([doc], indexBytes([], [...varintField(50, 42)]));

    const parsed = parseScipIndex(bytes);
    expect(parsed.malformedDocuments).toBe(0);
    expect(parsed.documents).toHaveLength(1);
    const occurrenceOut = parsed.documents[0]?.occurrences[0];
    expect(occurrenceOut?.symbol).toBe(SYMBOL);
    expect(occurrenceOut?.symbolRoles).toBe(1);
    expect(occurrenceOut?.range).toEqual([3, 0, 3, 9]);

    const client = new GraphifyClient();
    const summary = await ingestScipIndex(client, bytes);
    expect(summary.documents).toBe(1);
    expect(summary.symbolsCreated).toBe(1);
  });

  it("throws a typed ProtobufParseError with a byte offset on truncated or malformed buffers", () => {
    const docA = documentBytes("src/a.ts", [occurrenceBytes({ symbol: SYMBOL, roles: 1 })]);

    // Truncated mid-message: the last two bytes of the stream are cut.
    const truncated = scipBytes([docA], indexBytes([])).slice(0, -2);
    expect(() => parseScipIndex(truncated)).toThrow(ProtobufParseError);
    expect(() => parseScipIndex(truncated)).toThrow(/byte \d+/);

    // Declared message length longer than the remaining bytes.
    const overlong = Uint8Array.from([...scipBytes([docA], indexBytes([])), 0x0a]);
    const overlongError = captureError(() => parseScipIndex(overlong));
    expect(overlongError).toBeInstanceOf(ProtobufParseError);
    expect(overlongError?.offset).toBeGreaterThan(0);

    // Malformed varint (continuation bit set, then EOF).
    const badVarint = Uint8Array.from([0x80, 0x80]);
    expect(() => parseScipIndex(badVarint)).toThrow(/truncated varint/);

    // Empty stream is a structural error, not a silent empty result.
    expect(() => parseScipIndex(Uint8Array.of())).toThrow(ProtobufParseError);
  });

  it("skips and counts documents over maxOccurrencesPerFile; the default cap is 5000", async () => {
    expect(DEFAULT_MAX_OCCURRENCES_PER_FILE).toBe(5000);

    const occurrences = [
      occurrenceBytes({ symbol: "s one", roles: 1 }),
      occurrenceBytes({ symbol: "s two", roles: 0 }),
      occurrenceBytes({ symbol: "s three", roles: 0 }),
    ];
    const doc = documentBytes("src/huge.ts", occurrences);
    const bytes = scipBytes([doc], indexBytes([]));

    const client = new GraphifyClient();
    const summary = await ingestScipIndex(client, bytes, { maxOccurrencesPerFile: 2 });
    expect(summary).toEqual({
      documents: 0,
      symbolsCreated: 0,
      edgesCreated: 0,
      skippedDocuments: 1,
    });
    const { nodes, edges } = snapshotOf(client);
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);

    // 0 disables the cap.
    const uncapped = await ingestScipIndex(new GraphifyClient(), bytes, { maxOccurrencesPerFile: 0 });
    expect(uncapped.documents).toBe(1);
    expect(uncapped.edgesCreated).toBe(3);
  });

  it("one malformed standalone document does not abort the ingest (counted skip)", async () => {
    // The occurrence body ends with a dangling varint continuation byte.
    const badOccurrence = [...occurrenceBytes({ symbol: "bad symbol", roles: 1 }), 0x80];
    const badDoc = documentBytes("src/bad.ts", [badOccurrence]);
    const goodDoc = documentBytes("src/a.ts", [
      occurrenceBytes({ symbol: SYMBOL, roles: 1, range: [2, 0, 2, 4] }),
    ]);
    const bytes = scipBytes([badDoc, goodDoc], indexBytes([]));

    const parsed = parseScipIndex(bytes);
    expect(parsed.malformedDocuments).toBe(1);
    expect(parsed.documents.map((doc) => doc.relativePath)).toEqual(["src/a.ts"]);

    const client = new GraphifyClient();
    const summary = await ingestScipIndex(client, bytes);
    expect(summary.documents).toBe(1);
    expect(summary.skippedDocuments).toBe(1);
    const { nodes } = snapshotOf(client);
    expect(nodes.some((node) => node.id === "file:src/a.ts")).toBe(true);
    expect(nodes.some((node) => node.id === "file:src/bad.ts")).toBe(false);
  });

  it("references to symbols defined nowhere in the index get stub Symbol nodes (metadata.external) and normalized paths", async () => {
    // Backslashes normalize to forward slashes in file node ids.
    const doc = documentBytes("src\\win\\c.ts", [
      occurrenceBytes({ symbol: "ext sym", roles: 0, range: [0, 0, 0, 3] }),
    ]);
    const bytes = scipBytes([doc], indexBytes([]));

    const client = new GraphifyClient();
    const summary = await ingestScipIndex(client, bytes);
    expect(summary.documents).toBe(1);
    expect(summary.symbolsCreated).toBe(1);
    expect(summary.edgesCreated).toBe(1);

    const { nodes, edges } = snapshotOf(client);
    const stub = nodes.find((node) => node.id === "scip:ext sym");
    expect(stub?.type).toBe("Symbol");
    expect(stub?.metadata?.external).toBe(true);
    expect(stub?.metadata?.scipSymbol).toBe("ext sym");
    expect(nodes.some((node) => node.id === "file:src/win/c.ts")).toBe(true);
    expect(edges).toContainEqual({
      from: "file:src/win/c.ts",
      to: "scip:ext sym",
      relation: "references",
    });
  });
});

function captureError(action: () => unknown): Error | undefined {
  try {
    action();
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return undefined;
}
