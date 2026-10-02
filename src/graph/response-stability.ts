/**
 * U2 (host prefix cacheability): prefix-stability measurement.
 *
 * A provider prompt cache is a left-to-right prefix match — one differing byte
 * re-prices every token behind it. These helpers quantify how much of the
 * previous response's leading bytes survived into the next one, which is the
 * number a host (or `contextPressure` / economics reporting) needs to judge
 * whether a response shape is actually cache-friendly.
 */

/**
 * Longest-common-prefix bytes over the longer input's total bytes, in [0, 1].
 *
 * - Two empty strings are identical prefixes of each other: 1.
 * - One empty, one not: no shared prefix: 0.
 * - `computePrefixStability("abcdef", "abcxyz") === 0.5` — half the leading
 *   bytes (UTF-8 aware, so CJK dialogue content measures by real bytes) of the
 *   longer input survived.
 */
export function computePrefixStability(prev: string, next: string): number {
  const prevBytes = Buffer.byteLength(prev, "utf8");
  const nextBytes = Buffer.byteLength(next, "utf8");
  if (prevBytes === 0 && nextBytes === 0) {
    return 1;
  }

  // Common prefix measured in UTF-16 code units, then converted once to bytes:
  // a partial multi-byte character can never end a code-unit-equal prefix.
  const bound = Math.min(prev.length, next.length);
  let units = 0;
  while (units < bound && prev.charCodeAt(units) === next.charCodeAt(units)) {
    units += 1;
  }
  const prefixBytes = Buffer.byteLength(prev.slice(0, units), "utf8");
  const maxBytes = Math.max(prevBytes, nextBytes);
  if (maxBytes === 0) {
    return 1;
  }
  return prefixBytes / maxBytes;
}
