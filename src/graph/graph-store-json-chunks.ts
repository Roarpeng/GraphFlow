/**
 * graph-store-json-chunks.ts — read the file graph store without materializing
 * the whole document as one string.
 *
 * `readFileSync(path, "utf8")` + `JSON.parse` is the fast path for normal
 * stores, but a workspace with millions of `references` edges serializes to
 * hundreds of MB, and a single JS string cannot exceed V8's maximum length
 * (~512 MB on 64-bit). Indexing such a workspace used to die while *writing*
 * ("Invalid string length"); after the writer became chunked it can now succeed,
 * so the reader needs the same treatment.
 *
 * The parser consumes incrementally from a `pull()` source, so it never holds
 * more than one element plus one chunk, and it is resumable across arbitrary
 * chunk boundaries. It understands exactly the document shape this project
 * writes — `{"nodes":[ … ],"edges":[ … ]}` — and ignores other top-level keys.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export interface ChunkedGraphStore {
  nodes: unknown[];
  edges: unknown[];
}

/** Flush the accumulated element buffer at this size while scanning. */
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

const isWhitespace = (ch: string): boolean =>
  ch === " " || ch === "\n" || ch === "\t" || ch === "\r";

class GraphStoreChunkParser {
  private buffer = "";
  private index = 0;

  constructor(private readonly pull: () => string | null) {}

  private fill(): boolean {
    if (this.index > 0) {
      this.buffer = this.buffer.slice(this.index);
      this.index = 0;
    }
    const next = this.pull();
    if (next === null || next === "") {
      return false;
    }
    this.buffer += next;
    return true;
  }

  private peek(): string | null {
    while (this.index >= this.buffer.length) {
      if (!this.fill()) return null;
    }
    return this.buffer[this.index]!;
  }

  private take(): string | null {
    const ch = this.peek();
    if (ch !== null) this.index += 1;
    return ch;
  }

  private skipWhitespace(): void {
    while (true) {
      const ch = this.peek();
      if (ch === null || !isWhitespace(ch)) return;
      this.index += 1;
    }
  }

  /** Read a JSON string literal starting at the opening quote. */
  private readString(): string | null {
    if (this.take() !== '"') return null;
    let text = '"';
    let escaped = false;
    while (true) {
      const ch = this.take();
      if (ch === null) return null;
      text += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') return text;
    }
  }

  /** Read one complete JSON value (object/array/string/number/literal). */
  private readValue(): { text: string; complete: boolean } {
    this.skipWhitespace();
    const first = this.peek();
    if (first === null) return { text: "", complete: false };
    let text = "";
    if (first === '"') {
      const str = this.readString();
      return str === null ? { text: "", complete: false } : { text: str, complete: true };
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    while (true) {
      const ch = this.take();
      if (ch === null) return { text, complete: false };
      text += ch;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        depth += 1;
        continue;
      }
      if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) return { text, complete: true };
        if (depth < 0) return { text, complete: true }; // scalar terminated early
        continue;
      }
      // Scalar (number / true / false / null): ends at the first delimiter.
      if (depth === 0 && (ch === "," || ch === "]" || ch === "}")) {
        // put the delimiter back for the caller
        this.index -= 1;
        return { text: text.slice(0, -1), complete: true };
      }
    }
  }

  private readElements(target: unknown[]): void {
    while (true) {
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === null) {
        // Input ended before the array closed: a partial graph must not be
        // mistaken for a complete one.
        throw new Error("Truncated graph store: unterminated array");
      }
      if (ch === "]") {
        this.index += 1;
        return;
      }
      if (ch === ",") {
        this.index += 1;
        continue;
      }
      const { text, complete } = this.readValue();
      if (!complete) {
        throw new Error("Truncated graph store: incomplete element");
      }
      target.push(JSON.parse(text));
    }
  }

  parse(): ChunkedGraphStore {
    const store: ChunkedGraphStore = { nodes: [], edges: [] };
    let rootClosed = false;
    while (true) {
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === null) break;
      if (ch === "{") {
        this.index += 1;
        continue;
      }
      if (ch === "}") {
        this.index += 1;
        rootClosed = true;
        continue;
      }
      if (ch === "," || ch === ":") {
        this.index += 1;
        continue;
      }
      if (ch !== '"') {
        // Unknown structure: stop rather than loop forever.
        break;
      }
      const key = this.readString();
      if (key === null) throw new Error("Truncated graph store: unterminated key");
      this.skipWhitespace();
      if (this.peek() === ":") this.index += 1;
      this.skipWhitespace();
      const name = JSON.parse(key) as string;
      if (name === "nodes" || name === "edges") {
        if (this.peek() !== "[") {
          throw new Error(`Truncated graph store: expected an array for "${name}"`);
        }
        this.index += 1;
        this.readElements(name === "nodes" ? store.nodes : store.edges);
        continue;
      }
      const { complete } = this.readValue();
      if (!complete) throw new Error(`Truncated graph store: incomplete "${name}"`);
    }
    if (!rootClosed) {
      throw new Error("Truncated graph store: unterminated root object");
    }
    return store;
  }
}

/** Parse a graph store document from a sequence of text chunks. */
export function readGraphStoreFromChunks(pull: () => string | null): ChunkedGraphStore {
  return new GraphStoreChunkParser(pull).parse();
}

/** Read a graph store file in bounded chunks (used above the single-string cap). */
export function readGraphStoreFileChunked(
  filePath: string,
  options: { chunkBytes?: number } = {}
): ChunkedGraphStore {
  const chunkBytes = Math.max(64 * 1024, options.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  const fd = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(chunkBytes);
  // StringDecoder keeps a partial multi-byte UTF-8 sequence across chunk reads,
  // so a character split at the boundary cannot corrupt the JSON.
  const decoder = new StringDecoder("utf8");
  try {
    return readGraphStoreFromChunks(() => {
      const read = readSync(fd, buffer, 0, chunkBytes, null);
      return read > 0 ? decoder.write(buffer.subarray(0, read)) : null;
    });
  } finally {
    closeSync(fd);
  }
}
