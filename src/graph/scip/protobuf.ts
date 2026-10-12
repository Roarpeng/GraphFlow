/**
 * protobuf.ts — minimal hand-rolled protobuf wire-format reader.
 *
 * Scope: exactly what parsing an uncompressed .scip index needs — varints,
 * tags, length-delimited payloads, and unknown-field skipping. No schema
 * compiler, no dependencies (zero-dep constraint for the SCIP ingest path).
 *
 * Wire format recap (protobuf.dev/programming-guides/encoding):
 * - every field is `tag varint | payload`, where tag = field_number << 3 | wire_type
 * - wire types: 0 = varint, 1 = 64-bit (8 raw bytes), 2 = length-delimited,
 *   5 = 32-bit (4 raw bytes). Types 3/4 (groups) are deprecated and rejected.
 * - unknown fields MUST be skipped, not treated as errors.
 */

/** Protobuf wire types (3 and 4 — groups — are deprecated and unsupported). */
export type WireType = 0 | 1 | 2 | 5;

/** Typed parse failure carrying the absolute byte offset in the source buffer. */
export class ProtobufParseError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`protobuf parse error at byte ${offset}: ${message}`);
    this.name = "ProtobufParseError";
    this.offset = offset;
  }
}

export interface ProtobufTag {
  fieldNumber: number;
  wireType: WireType;
}

/** A length-delimited submessage plus the absolute offset where its bytes start. */
export interface ProtobufSubmessage {
  bytes: Uint8Array;
  origin: number;
}

/** A varint may span at most 10 bytes (64 bits, 7 bits per byte). */
const MAX_VARINT_BYTES = 10;

const utf8Decoder = new TextDecoder("utf-8");

function isWireType(value: number): value is WireType {
  return value === 0 || value === 1 || value === 2 || value === 5;
}

/**
 * Reader over a (possibly nested) protobuf buffer.
 *
 * `origin` is the absolute offset of `bytes[0]` inside the top-level file, so
 * errors from submessages report file-absolute positions, not slice-relative
 * ones. It defaults to 0 for top-level buffers.
 */
export class ProtobufReader {
  private cursor = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly origin = 0
  ) {}

  /** Absolute byte offset of the next unread byte. */
  get offset(): number {
    return this.origin + this.cursor;
  }

  /** True when every byte has been consumed. */
  atEnd(): boolean {
    return this.cursor >= this.bytes.length;
  }

  /**
   * Read one base-128 varint as an unsigned Number.
   *
   * Values above Number.MAX_SAFE_INTEGER (possible for 64-bit varints, e.g.
   * negative int32s sign-extended to 10 bytes) throw: the fields SCIP ingest
   * interprets (ranges, roles, kinds, lengths) are all small non-negative
   * integers, and silently truncating a real 64-bit value would corrupt the
   * graph. Skipped unknown varint fields never pass through here.
   */
  readVarint(): number {
    let result = 0;
    for (let index = 0; index < MAX_VARINT_BYTES; index += 1) {
      if (this.cursor >= this.bytes.length) {
        throw new ProtobufParseError("truncated varint", this.offset);
      }
      const byte = this.bytes[this.cursor]!;
      this.cursor += 1;
      result += (byte & 0x7f) * 2 ** (index * 7);
      if ((byte & 0x80) === 0) {
        if (result > Number.MAX_SAFE_INTEGER) {
          throw new ProtobufParseError("varint exceeds 53-bit safe integer range", this.offset);
        }
        return result;
      }
    }
    throw new ProtobufParseError(`varint longer than ${MAX_VARINT_BYTES} bytes`, this.offset);
  }

  /** Read a field tag and split it into field number and wire type. */
  readTag(): ProtobufTag {
    const tagOffset = this.offset;
    const value = this.readVarint();
    const wireType = value & 0b111;
    if (!isWireType(wireType)) {
      throw new ProtobufParseError(`unsupported wire type ${wireType} (groups are deprecated)`, tagOffset);
    }
    const fieldNumber = Math.floor(value / 8);
    if (fieldNumber < 1) {
      throw new ProtobufParseError(`invalid field number ${fieldNumber}`, tagOffset);
    }
    return { fieldNumber, wireType };
  }

  /** Read exactly `length` raw bytes (bounds-checked). */
  readBytes(length: number): Uint8Array {
    if (length < 0) {
      throw new ProtobufParseError(`negative byte length ${length}`, this.offset);
    }
    if (this.cursor + length > this.bytes.length) {
      throw new ProtobufParseError(
        `truncated payload: declared ${length} bytes, ${this.bytes.length - this.cursor} available`,
        this.offset
      );
    }
    const slice = this.bytes.subarray(this.cursor, this.cursor + length);
    this.cursor += length;
    return slice;
  }

  /** Read a length-delimited payload (varint length + that many bytes). */
  readLengthDelimited(): Uint8Array {
    return this.readBytes(this.readVarint());
  }

  /**
   * Read a length-delimited submessage, also reporting where its bytes start
   * so nested readers can keep file-absolute error offsets.
   */
  readSubmessage(): ProtobufSubmessage {
    const length = this.readVarint();
    const bytes = this.readBytes(length);
    return { bytes, origin: this.offset - length };
  }

  /** Read a length-delimited field as UTF-8 text. */
  readString(): string {
    return utf8Decoder.decode(this.readLengthDelimited());
  }

  /** Skip a field value of the given wire type. Unknown fields must be skippable. */
  skipField(wireType: WireType): void {
    switch (wireType) {
      case 0:
        this.readVarint();
        return;
      case 1:
        this.readBytes(8);
        return;
      case 2:
        this.readLengthDelimited();
        return;
      case 5:
        this.readBytes(4);
        return;
    }
  }

  /**
   * Iterate every field of the remaining bytes.
   *
   * The visitor returns true when it consumed the value (via readVarint /
   * readLengthDelimited / ...); returning false makes the driver skip the
   * field, which is how unknown fields are tolerated.
   */
  forEachField(visit: (fieldNumber: number, wireType: WireType, reader: ProtobufReader) => boolean): void {
    while (!this.atEnd()) {
      const { fieldNumber, wireType } = this.readTag();
      if (!visit(fieldNumber, wireType, this)) {
        this.skipField(wireType);
      }
    }
  }
}

/**
 * Standalone field visitor: parse `bytes` (starting at absolute file offset
 * `origin`) as one protobuf message and visit each of its fields.
 */
export function forEachField(
  bytes: Uint8Array,
  origin: number,
  visit: (fieldNumber: number, wireType: WireType, reader: ProtobufReader) => boolean
): void {
  new ProtobufReader(bytes, origin).forEachField(visit);
}
