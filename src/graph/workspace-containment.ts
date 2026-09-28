import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Is `candidate` inside `root`?
 *
 * The graph is a project's private memory, so a node that came from another
 * project is not a cosmetic problem: it answers queries with foreign code,
 * inflates the module map, and survives re-indexing because nothing ever
 * deletes it. `../LightNav-0/...` had already been sitting in this repo's graph
 * as if it were ours.
 *
 * Two checks, because either alone is bypassable:
 *
 *  1. Lexical — resolve both sides and reject a `..` escape. Catches the direct
 *     case (`../../sibling/foo.ts`).
 *  2. Physical — resolve symlinks on both sides and re-check. A symlink *inside*
 *     the workspace pointing at `/etc` or a sibling checkout passes the lexical
 *     test and would import an entire foreign tree through a path that looks
 *     perfectly local.
 *
 * A root that does not exist on disk yet (a fresh workspace, or a test fixture)
 * falls back to the lexical check alone rather than throwing — the caller is
 * about to `statSync` the file anyway, and a missing root is not evidence that
 * the path is foreign.
 */
export function isInsideWorkspace(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = isAbsolute(candidate) ? resolve(candidate) : resolve(resolvedRoot, candidate);

  if (!lexicallyInside(resolvedRoot, resolvedCandidate)) return false;

  const physicalRoot = safeRealpath(resolvedRoot);
  const physicalCandidate = safeRealpath(resolvedCandidate);
  if (physicalRoot === undefined || physicalCandidate === undefined) {
    // Nothing to compare against (path does not exist yet, or is unreadable).
    // The lexical check already passed; `statSync` in the caller will produce
    // the real error.
    return true;
  }
  return lexicallyInside(physicalRoot, physicalCandidate);
}

function lexicallyInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  if (rel.length === 0) return true;
  // `relative` yields a parent escape as a leading `..` segment. A path merely
  // *containing* `..` in its middle is already resolved by the time we get here.
  return !rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith("../");
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  }
}

/**
 * Does this stored path escape the workspace?
 *
 * The read-side counterpart to {@link isInsideWorkspace}, for cleaning graphs
 * that were polluted before the write-side guard existed. Works on the relative
 * form that node ids carry (`file:../sibling/foo.ts`), so it needs no filesystem
 * access and can classify a whole snapshot at once.
 */
export function isWorkspaceEscapingPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  );
}
