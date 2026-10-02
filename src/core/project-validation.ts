import { readFileSync } from "node:fs";
import { join } from "node:path";

const projectGateCache = new Map<string, string[]>();

/** The workspace's own validation gates, read from package.json scripts. */
export function projectValidationGates(workspaceRoot: string): string[] {
  const cached = projectGateCache.get(workspaceRoot);
  if (cached) return cached;
  const gates: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    if (scripts.typecheck) gates.push("npm run typecheck");
    if (scripts.test) gates.push("npm test");
    if (gates.length === 0 && scripts.build) gates.push("npm run build");
  } catch {
    // No package.json (or not JSON): no project-level gates to offer.
  }
  projectGateCache.set(workspaceRoot, gates);
  return gates;
}
