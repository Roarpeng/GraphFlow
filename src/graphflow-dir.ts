/**
 * GraphFlow writes caches (indexes, graph JSON, task runners, session state) under
 * `<workspace>/.graphflow`. That directory belongs to GraphFlow, not to the user's
 * repository, so it must never show up as untracked work.
 *
 * Keeping the ignore rule inside the directory means no edit to the user's own
 * `.gitignore`, and it applies even when `.graphflow` is the only new path.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GRAPHFLOW_GITIGNORE = "# GraphFlow cache — generated, do not commit\n*\n";

/** Creates `<rootDir>/.graphflow` and makes git ignore its contents. */
export function ensureGraphflowDir(rootDir: string): string {
  const dir = join(rootDir, ".graphflow");
  mkdirSync(dir, { recursive: true });
  const ignorePath = join(dir, ".gitignore");
  if (!existsSync(ignorePath)) {
    try {
      writeFileSync(ignorePath, GRAPHFLOW_GITIGNORE, "utf8");
    } catch {
      // A read-only cache dir must not fail the command that only wanted a cache.
    }
  }
  return dir;
}
