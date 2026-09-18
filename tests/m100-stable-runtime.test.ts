import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installMcpToDetectedAgents,
  resolveStableRuntimeInstall,
  stableRuntimeRoot,
} from "../src/integrations/agent-mcp-installer";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function withIsolatedHome<T>(home: string, run: () => T): T {
  const prevProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  const prevAppData = process.env.APPDATA;
  if (process.platform === "win32") process.env.USERPROFILE = home;
  else process.env.HOME = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  try {
    return run();
  } finally {
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
  }
}

describe("M100 stable runtime (VSIX one-command, never-dangling entries)", () => {
  it("stableRuntimeRoot lives under ~/.graphflow/runtime (isolated HOME)", () => {
    const home = makeTempRoot("gf-stable-root-");
    withIsolatedHome(home, () => {
      expect(stableRuntimeRoot()).toBe(join(home, ".graphflow", "runtime"));
    });
  });

  it("resolveStableRuntimeInstall finds a synced copy and fails open without one", () => {
    const home = makeTempRoot("gf-stable-probe-");
    withIsolatedHome(home, () => {
      // No synced copy yet → undefined (callers fall through to npx).
      expect(resolveStableRuntimeInstall()).toBeUndefined();
      // Sync the layout the VSIX writes (~/.graphflow/runtime/dist/...).
      mkdirSync(join(home, ".graphflow", "runtime", "dist", "surfaces", "mcp"), { recursive: true });
      writeFileSync(
        join(home, ".graphflow", "runtime", "dist", "surfaces", "mcp", "server.js"),
        "// server",
        "utf8"
      );
      expect(resolveStableRuntimeInstall()).toMatchObject({
        runtimeRoot: join(home, ".graphflow", "runtime"),
        serverPath: join(home, ".graphflow", "runtime", "dist", "surfaces", "mcp", "server.js"),
      });
    });
  });

  it("preferGlobalInstall chain falls through to the stable runtime (never dangling)", () => {
    const home = makeTempRoot("gf-stable-chain-");
    mkdirSync(join(home, ".zcode"), { recursive: true });
    withIsolatedHome(home, () => {
      // Sync the VSIX-style stable runtime inside the isolated HOME.
      const stableDir = join(home, ".graphflow", "runtime");
      mkdirSync(join(stableDir, "dist", "surfaces", "mcp"), { recursive: true });
      writeFileSync(join(stableDir, "dist", "surfaces", "mcp", "server.js"), "// server", "utf8");

      installMcpToDetectedAgents({
        strategy: "npx",
        installScope: "user",
        agentIdsOverride: ["zcode"],
        preferGlobalInstall: true,
        // No override — exercise the real global → stable → npx chain. The
        // dev machine may have an npm global install; both direct (global or
        // stable) and the npx fallback are acceptable, but a direct entry
        // must reference an EXISTING file (never-dangling contract).
      });
      const entry = (JSON.parse(
        (require("node:fs") as typeof import("node:fs")).readFileSync(
          join(home, ".zcode", "cli", "config.json"),
          "utf8"
        )
      ) as { mcp?: { servers?: Record<string, { args?: string[]; cwd?: string }> } }).mcp?.servers
        ?.graphflow;
      const args = entry?.args ?? [];
      const direct = args.find((a) => a.endsWith("server.js"));
      if (direct !== undefined) {
        expect(existsSync(direct)).toBe(true);
        expect(entry?.cwd).toBeDefined();
      } else {
        expect(args).toContain("--package=@roarpeng/graphflow");
      }
    });
  });
});
