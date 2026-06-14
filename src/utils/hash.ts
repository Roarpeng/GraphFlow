/**
 * DJB2a variant hash function (initial value 5381, multiplier 33, XOR, base36).
 * Used for episodic-memory and reflector.
 */
export function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Multiplicative hash function (initial value 0, multiplier 31, multiply, base16).
 * Used for file-indexer.
 */
export function hashTextHex(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}
