import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

/**
 * M81 — installing GraphFlow into *any* agent host must never bake the
 * installer's own location into the MCP entry.
 *
 * The dsh failure was an injected `rootDir=/home/<user>`: the glue derived the
 * workspace from the *host process* cwd instead of the session workspace. The
 * same class of bug at install time is a config that pins `cwd` /
 * `GRAPHFLOW_WORKSPACE_ROOT` to whatever directory the user ran
 * `graphflow install` from (usually `$HOME`). GraphFlow refuses unsafe roots, so
 * such an entry breaks every tool call in that host — and the symptom looks
 * nothing like "the installer wrote the wrong path".
 *
 * This guard installs every migrated host into a sandboxed HOME and inspects the
 * artifacts it writes: only host-interpolated placeholders (`${workspaceFolder}`)
 * or paths inside the sandbox are allowed. The installer cwd, the sandbox HOME
 * and the real home must never appear as a workspace or cwd value.
 *
 * HOME is redirected *before* the installer modules load: profile registries
 * bake their config paths at import time (`resolveHomePaths()`), so a
 * `beforeEach` override would silently skip the sandbox for profile hosts.
 */
const REAL_HOME = resolve(homedir());
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "gf-m81-home-"));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;
process.env.APPDATA = join(SANDBOX_HOME, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(SANDBOX_HOME, "AppData", "Local");

const { isUnsafeWorkspaceFallback } = await import("../src/config/discover-workspace");
const { HOST_ADAPTER_MIGRATED_IDS, installViaHostAdapter } = await import(
  "../src/integrations/host-adapter-install"
);
const { resolveGlobalGraphflowInstall } = await import(
  "../src/integrations/agent-mcp-installer"
);

/**
 * Stable machine-level paths that ARE allowed in host configs: a
 * globally-installed GraphFlow package (npm prefix lives under $HOME for many
 * setups — e.g. ~/.npm-global — but the entry is intentional and survives
 * shell restarts) and the node binary that launches it.
 */
const GLOBAL_INSTALL = resolveGlobalGraphflowInstall();
const ALLOWED_STABLE_PATHS = new Set<string>(
  [
    GLOBAL_INSTALL?.serverPath,
    GLOBAL_INSTALL?.runtimeRoot,
    process.execPath,
  ].filter((value): value is string => typeof value === "string")
);

const extraRoots: string[] = [];

afterEach(() => {
  for (const dir of extraRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

afterAll(() => {
  try {
    rmSync(SANDBOX_HOME, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

function walkFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walkFiles(full, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      if (statSync(full).size > 512 * 1024) continue;
    } catch {
      continue;
    }
    acc.push(full);
  }
  return acc;
}

/** Values assigned to a workspace-bearing key, in JSON, TOML or opencode style. */
export function extractWorkspaceValues(content: string): string[] {
  const values: string[] = [];
  const patterns = [
    /GRAPHFLOW_WORKSPACE_ROOT["']?\s*[:=]\s*["']([^"'\n]*)["']/gi,
    /["']cwd["']\s*[:=]\s*["']([^"'\n]*)["']/gi,
    /^\s*cwd\s*[:=]\s*["']([^"'\n]*)["']/gim,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1] !== undefined) values.push(match[1].trim());
    }
  }
  return values;
}

describe("M81 host install workspace guard", () => {
  it("extracts workspace-bearing values from every config dialect", () => {
    expect(extractWorkspaceValues('{"env":{"GRAPHFLOW_WORKSPACE_ROOT":"/home/x"}}')).toEqual(["/home/x"]);
    expect(extractWorkspaceValues('{"cwd":"/home/x"}')).toEqual(["/home/x"]);
    expect(extractWorkspaceValues('cwd = "/home/x"\n')).toEqual(["/home/x"]);
    expect(extractWorkspaceValues('GRAPHFLOW_WORKSPACE_ROOT = "/home/x"')).toEqual(["/home/x"]);
    expect(extractWorkspaceValues('{"env":{"GRAPHFLOW_WORKSPACE_ROOT":"${workspaceFolder}"}}')).toEqual([
      "${workspaceFolder}",
    ]);
  });

  it("never pins the installer cwd, HOME, or AppData into any host config", () => {
    const installerCwd = resolve(process.cwd());
    const inspected: string[] = [];
    const offenders: string[] = [];

    for (const hostId of HOST_ADAPTER_MIGRATED_IDS) {
      const result = installViaHostAdapter(hostId, { home: SANDBOX_HOME });
      expect(result.status, `${hostId} install failed: ${result.message ?? ""}`).not.toBe("error");

      for (const file of walkFiles(SANDBOX_HOME)) {
        let content: string;
        try {
          content = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        if (!/graphflow/i.test(content)) continue;
        inspected.push(file);
        for (const value of extractWorkspaceValues(content)) {
          if (!value) continue;
          if (value === "${workspaceFolder}" || value === "${workspaceFolder}/") continue;
          // Intentional stable paths (global install / node binary) are exempt.
          if (ALLOWED_STABLE_PATHS.has(resolve(value))) continue;
          // Relative paths (".", "./sub") are host-resolved, not baked.
          if (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) continue;
          const resolved = resolve(value);
          const insideSandbox =
            resolved === SANDBOX_HOME || resolved.startsWith(`${SANDBOX_HOME}/`);
          const unsafe =
            isUnsafeWorkspaceFallback(resolved) ||
            resolved === installerCwd ||
            resolved === REAL_HOME ||
            !insideSandbox;
          if (unsafe) offenders.push(`${hostId}: ${value} (${file})`);
        }
      }
    }

    expect(offenders).toEqual([]);
    // Guard against a vacuous pass: real host configs must have been written.
    expect(inspected.length).toBeGreaterThan(5);
  });

  it("keeps the dsh MCP row dynamic instead of baking an install-time path", () => {
    const installerCwd = resolve(process.cwd());
    const result = installViaHostAdapter("deepseek-harness", { home: SANDBOX_HOME });
    expect(result.status).not.toBe("error");

    const patchFiles = walkFiles(SANDBOX_HOME).filter((file) => file.endsWith("cordis.patch.yml"));
    expect(patchFiles.length).toBeGreaterThan(0);
    const patch = readFileSync(patchFiles[0] as string, "utf8");
    // dsh resolves the MCP cwd at boot (`!!js process.cwd()`); the glue is what
    // feeds the real session workspace to tools. An absolute baked path here
    // would pin every session of every project to one directory.
    expect(patch).toContain("cwd: !!js process.cwd()");
    expect(patch).not.toContain(`cwd: ${installerCwd}`);
  });
});
