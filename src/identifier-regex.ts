/**
 * GraphFlow 3.7.0 — Identifier helpers shared by rename and blast-radius.
 *
 * `\b` is an ASCII word boundary, so `\bfoo\b` also matches the `foo` inside `$foo`
 * (JS identifiers may contain `$`) and inside non-ASCII identifiers such as `名字foo`.
 * Matching on `ID_Continue` lookarounds keeps whole-identifier semantics for every
 * language the rename engine touches, and `isIdentifierName` mirrors the same idea
 * when validating a new name.
 */

/** One `ID_Continue` code point, or `$` (not part of `ID_Continue`, but legal in JS). */
export const ID_CONTINUE_CLASS = "[\\p{ID_Continue}$]";

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pattern that matches `name` as a whole identifier. Requires the `u` flag; use
 * `identifierBoundaryRe` unless the pattern is embedded in a larger expression.
 */
export function identifierBoundary(name: string): string {
  return `(?<!${ID_CONTINUE_CLASS})${escapeRegExp(name)}(?!${ID_CONTINUE_CLASS})`;
}

export function identifierBoundaryRe(name: string, flags = ""): RegExp {
  return new RegExp(identifierBoundary(name), flags.includes("u") ? flags : `${flags}u`);
}

/**
 * True when `name` can be used as an identifier in every supported language:
 * `ID_Start` (or `_`/`$`, which JS allows in that position) followed by `ID_Continue`.
 */
export function isIdentifierName(name: string): boolean {
  return /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u.test(name);
}
