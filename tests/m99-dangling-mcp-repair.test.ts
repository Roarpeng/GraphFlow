import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getMcpInstallStatus,
  repairDanglingGraphflowMcpEntries,
} from "../src/integrations/agent-mcp-installer";
import { buildDoctorReport } from "../src/surfaces/cli/init";

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

describe("M99 dangling MCP entry detection + one-command repair", () => {
  it("flags an entry whose launch target no longer exists (dead extension launcher)", () => {
    const home = makeTempRoot("gf-dangling-cursor-");
    const deadLauncher = join(home, ".cursor", "extensions", "roarpeng.graphflow-1.16.0-universal", "mcp-launcher.cjs");
    mkdirSync(join(home, ".cursor", "extensions", "roarpeng.graphflow-1.16.0-universal"), { recursive: true });
    // The IDE upgraded and the directory content vanished; only the config
    // entry survives pointing at the dead path.
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          graphflow: { command: "node", args: [deadLauncher], env: { GRAPHFLOW_MCP_STDIO: "1" } },
        },
      }, null, 2),
      "utf8"
    );

    withIsolatedHome(home, () => {
      const status = getMcpInstallStatus().find((s) => s.agentId === "cursor");
      expect(status?.installed).toBe(true);
      expect(status?.dangling).toBe(true);
      expect(status?.danglingTargets).toContain(deadLauncher);

      const doctor = buildDoctorReport(home);
      const check = doctor.checks.find((c) => c.agent.includes("dangling entry"));
      expect(check?.status).toBe("missing");
      expect(check?.message ?? "").toContain(deadLauncher);
    });
  });

  it("healthy entries are not flagged", () => {
    const home = makeTempRoot("gf-healthy-cursor-");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const realScript = join(home, ".cursor", "graphflow-server.js");
    writeFileSync(realScript, "// server", "utf8");
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          graphflow: { command: process.execPath, args: [realScript] },
          other: { command: "npx" }, // bare commands are never dangling-checked
        },
      }, null, 2),
      "utf8"
    );

    withIsolatedHome(home, () => {
      const status = getMcpInstallStatus().find((s) => s.agentId === "cursor");
      expect(status?.installed).toBe(true);
      expect(status?.dangling).toBeUndefined();
    });
  });

  it("repair rewrites the dangling entry to a launchable shape", () => {
    const home = makeTempRoot("gf-repair-zcode-");
    mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
    const deadLauncher = join(home, ".zcode", "extensions", "roarpeng.graphflow-1.16.0", "mcp-launcher.cjs");
    writeFileSync(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({
        mcp: { servers: { graphflow: { command: "node", args: [deadLauncher], env: { GRAPHFLOW_MCP_STDIO: "1" } } } },
      }, null, 2),
      "utf8"
    );

    withIsolatedHome(home, () => {
      const before = getMcpInstallStatus().find((s) => s.agentId === "zcode");
      expect(before?.dangling).toBe(true);

      const repairs = repairDanglingGraphflowMcpEntries();
      const zcode = repairs.find((r) => r.agentId === "zcode");
      expect(zcode?.repaired).toBe(true);
      expect(zcode?.danglingTargets).toContain(deadLauncher);

      const configPath = join(home, ".zcode", "cli", "config.json");
      const after = JSON.parse(readFileSync(configPath, "utf8")) as {
        mcp?: { servers?: Record<string, { args?: string[]; command?: string }> };
      };
      const entry = after.mcp?.servers?.graphflow;
      // Replaced: no npx cold-start, no dead path — a real node + server or
      // npx fallback with no dead absolute paths.
      const args = entry?.args ?? [];
      for (const arg of args) {
        if (arg.startsWith("/") || /^[A-Za-z]:[\\/]/.test(arg)) {
          expect(existsSync(arg)).toBe(true);
        }
      }
      expect(args).not.toContain(deadLauncher);

      const statusAfter = getMcpInstallStatus().find((s) => s.agentId === "zcode");
      expect(statusAfter?.dangling).toBeUndefined();
    });
  });

  it("repair is a no-op when nothing dangles", () => {
    const home = makeTempRoot("gf-repair-clean-");
    mkdirSync(join(home, ".zcode"), { recursive: true });
    withIsolatedHome(home, () => {
      // No config at all → no dangling → no repairs, no crash.
      const repairs = repairDanglingGraphflowMcpEntries();
      expect(repairs).toEqual([]);
    });
  });
});
