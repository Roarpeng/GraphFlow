import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Prefer this checkout's build over the published package, for every host.
 *
 * The problem this solves is specific and was measured: with an npx launcher, a
 * host fetches the published package on every launch, so editing GraphFlow in a
 * checkout changes nothing the host runs. The setup looks perfectly healthy
 * while loading none of your edits, which is the worst failure shape available.
 *
 * Two design points, both learned the hard way:
 *
 * - The preference lives in a **global, host-neutral** marker
 *   (`~/.graphflow/workspace-build.json`), not inside any one host's config
 *   directory. An earlier version put it under `~/.config/opencode/plugins/`,
 *   which baked "opencode" into a decision that applies to every host and made
 *   the flag read as if it were opencode-specific.
 *
 * - The **workspace is recorded, not assumed**. `install` can be run from
 *   anywhere, and a marker that silently pointed at the wrong checkout would
 *   write a plausible-looking entry that launches a stale build — the exact
 *   failure this preference exists to prevent.
 *
 * It is applied in `installMcpToDetectedAgents`, the single choke point every
 * write path passes through. A guard inside one host's installer slice did not
 * hold: the global MCP pass rewrote the entry right after the slice changed it.
 */

export const WORKSPACE_BUILD_MARKER_FILE = "workspace-build.json";

export interface WorkspaceBuildPreference {
  enabled: boolean;
  /** Absolute path of the GraphFlow checkout whose build hosts should launch. */
  workspaceRoot?: string;
  filePath: string;
  status: "created" | "updated" | "removed" | "absent" | "unchanged" | "error";
  message?: string;
}

export function workspaceBuildMarkerPath(home?: string): string {
  return join(home ?? homedir(), ".graphflow", WORKSPACE_BUILD_MARKER_FILE);
}

/** The MCP server entry hosts should carry: `<root>/dist/surfaces/mcp/server.js`. */
export function workspaceBuildServerPath(workspaceRoot: string): string {
  return join(workspaceRoot, "dist", "surfaces", "mcp", "server.js");
}

export function getWorkspaceBuildPreference(options: { home?: string } = {}): WorkspaceBuildPreference {
  const filePath = workspaceBuildMarkerPath(options.home);
  if (!existsSync(filePath)) return { enabled: false, filePath, status: "absent" };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      enabled?: unknown;
      workspaceRoot?: unknown;
    };
    return {
      enabled: parsed.enabled === true,
      ...(typeof parsed.workspaceRoot === "string" && parsed.workspaceRoot
        ? { workspaceRoot: parsed.workspaceRoot }
        : {}),
      filePath,
      status: parsed.enabled === true ? "unchanged" : "absent",
    };
  } catch (error) {
    // A corrupt marker reads as "not enabled" rather than throwing: the failure
    // mode is a published-package entry, which is what the user had before.
    return {
      enabled: false,
      filePath,
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function setWorkspaceBuildPreference(options: {
  enabled: boolean;
  home?: string;
  workspaceRoot?: string;
}): WorkspaceBuildPreference {
  const filePath = workspaceBuildMarkerPath(options.home);
  try {
    if (!options.enabled) {
      if (!existsSync(filePath)) return { enabled: false, filePath, status: "unchanged" };
      rmSync(filePath);
      return { enabled: false, filePath, status: "removed" };
    }
    const before = getWorkspaceBuildPreference(options);
    // Omitting workspaceRoot keeps whatever was recorded. Defaulting to cwd here
    // would silently re-point a marker every time install ran from elsewhere.
    const workspaceRoot = options.workspaceRoot ?? before.workspaceRoot ?? process.cwd();
    mkdirSync(join(options.home ?? homedir(), ".graphflow"), { recursive: true });
    writeFileSync(
      filePath,
      `${JSON.stringify({ enabled: true, workspaceRoot }, null, 2)}\n`,
      "utf8"
    );
    const unchanged =
      before.enabled && before.status === "unchanged" && before.workspaceRoot === workspaceRoot;
    return {
      enabled: true,
      workspaceRoot,
      filePath,
      status: unchanged ? "unchanged" : before.status === "absent" ? "created" : "updated",
    };
  } catch (error) {
    return {
      enabled: false,
      filePath,
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The build hosts should launch, or `undefined` when the preference is off or
 * the checkout has not been built.
 *
 * A missing build is reported separately rather than treated as "off": silently
 * falling back to the published package is precisely the invisible-failure mode
 * described above.
 */
export function resolveWorkspaceBuildServerPath(
  options: { home?: string } = {}
): { path?: string; preference: WorkspaceBuildPreference; missingBuild: boolean } {
  const preference = getWorkspaceBuildPreference(options);
  if (!preference.enabled) return { preference, missingBuild: false };
  const root = preference.workspaceRoot ?? process.cwd();
  const path = workspaceBuildServerPath(root);
  return { ...(existsSync(path) ? { path } : {}), preference, missingBuild: !existsSync(path) };
}
