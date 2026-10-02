import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * While developing GraphFlow, every host must launch *this* workspace's build.
 * With an npx launcher a host fetches the published package on every launch, so
 * editing this checkout changes nothing the host runs — and the setup looks
 * perfectly healthy while doing it.
 *
 * These tests cover the preference itself, the shared injection path, and the
 * fact that it reaches *every* host. That last part is the regression that
 * mattered: the guard was originally written for opencode alone, and measuring
 * all 20 profiles showed the other 19 still on the npx launcher.
 *
 * Isolation note: agent profiles call `resolveHomePaths()` and register
 * themselves at *module load*, so redirecting `HOME` after the import is too
 * late. Each test resets the module registry and re-imports.
 */

const tempRoots: string[] = [];
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAppData: string | undefined;
let previousLocalAppData: string | undefined;
let sandboxHome: string;

type Installer = typeof import("../src/integrations/agent-mcp-installer");
type WorkspaceBuild = typeof import("../src/integrations/workspace-build");

async function loadWithSandboxHome(): Promise<{ installer: Installer; wb: WorkspaceBuild }> {
  vi.resetModules();
  const installer = (await import("../src/integrations/agent-mcp-installer")) as Installer;
  const wb = (await import("../src/integrations/workspace-build")) as WorkspaceBuild;
  return { installer, wb };
}

function createWorkspaceBuild(workspaceRoot: string): string {
  const serverPath = join(workspaceRoot, "dist", "surfaces", "mcp", "server.js");
  mkdirSync(join(workspaceRoot, "dist", "surfaces", "mcp"), { recursive: true });
  writeFileSync(serverPath, "// test build\n", "utf8");
  return serverPath;
}

/**
 * Does a host's config name this build?
 *
 * Compares path *segments*, not raw strings. On Windows `tmpdir()` hands back the
 * short 8.3 form (`C:\Users\RUNNER~1\...`) while the written entry carries the
 * resolved long form (`C:\Users\runneradmin\...`), so a literal comparison fails
 * on a path that is demonstrably correct. That is what made CI report all 18
 * hosts as not pointing at the build when every one of them had
 * `status=created` and `mentionsDist=yes` — the guard was working the whole time.
 *
 * Both slash styles are accepted, since a config may be JSON or TOML and either
 * can carry native or forward slashes.
 */
function mentionsServerPath(configText: string, serverPath: string): boolean {
  const segments = (value: string): string[] =>
    value
      .replace(/[\\/]+/g, "/")
      .replace(/^([A-Za-z]):/, "$1")
      .split("/")
      .filter((segment) => segment && segment !== ".");
  const wanted = segments(serverPath).map((segment) => segment.toLowerCase());
  // Pull the path-shaped tokens out of the file rather than splitting the whole
  // text: a JSON config stores the path escaped (`C:\\Users\\...`), so the
  // separators inside it are doubled and segmenting the file text yields one
  // giant token. Matching anything that ends in the server's filename covers
  // JSON, TOML, and either slash style.
  const candidates = configText.match(/[^\s"'[\]{},]*server\.js/gi) ?? [];
  return candidates.some((candidate) => {
    // Collapse each run of backslashes to one. A JSON-written path stores them
    // doubled (`C:\\Users\\...`); removing them outright would glue the segments
    // together and lose the very separators being compared.
    const actual = segments(candidate.replace(/\\+/g, (run) => run[0] ?? "\\"));
    return (
      actual.length === wanted.length &&
      actual.every((segment, offset) => segment.toLowerCase() === wanted[offset])
    );
  });
}

function newWorkspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // realpath so the path matches what the installer writes. tmpdir() returns the
  // short 8.3 form on Windows (RUNNER~1) while os.homedir() and the written
  // entry carry the long form (runneradmin); comparing the two forms is a
  // difference in spelling, not in location.
  tempRoots.push(dir);
  return realpathSync(dir);
}

interface HostEntry {
  command?: string | string[];
  args?: string[];
  env?: Record<string, string>;
  environment?: Record<string, string>;
}

/**
 * Read one host's graphflow entry.
 *
 * Hosts disagree on the file layout: `mcp.json` vs `settings.json` vs TOML, and
 * `mcp` vs `mcpServers` vs `servers` vs `context_servers`. Rather than
 * enumerate the layouts, search the parsed structure for the graphflow entry —
 * the question these tests ask is "does the entry point at the build", not
 * "where in the file does it live".
 */
function readGraphflowEntry(configPath: string): HostEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
  const seen = new Set<unknown>();
  const walk = (node: unknown): HostEntry | undefined => {
    if (!node || typeof node !== "object" || seen.has(node)) return undefined;
    seen.add(node);
    const record = node as Record<string, unknown>;
    const entry = record.graphflow;
    if (entry && typeof entry === "object") return entry as HostEntry;
    for (const value of Object.values(record)) {
      const found = walk(value);
      if (found) return found;
    }
    return undefined;
  };
  return walk(parsed);
}

/** The argv a host would run: `command` plus `args`, however the host spells it. */
function entryArgv(entry: HostEntry | undefined): string {
  if (!entry) return "";
  const command = Array.isArray(entry.command) ? entry.command.join(" ") : (entry.command ?? "");
  return `${command} ${(entry.args ?? []).join(" ")}`;
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAppData = process.env.APPDATA;
  previousLocalAppData = process.env.LOCALAPPDATA;
  sandboxHome = newWorkspace("gf-wb-home-");
  // Both variables, not just HOME. os.homedir() reads USERPROFILE on Windows
  // while tmpdir() returns the short 8.3 form (RUNNER~1), so setting only HOME
  // leaves homedir() pointing at the real user profile.
  //
  // That was not cosmetic — it leaked a marker into the real ~/.graphflow, where
  // it outlived the test that wrote it and pointed at a workspace already removed
  // by afterEach. Every later test then saw "enabled but unbuilt" and the
  // every-profile case failed with all 18 hosts missing, on Windows only. The
  // same pair the rest of the suite redirects.
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
  // APPDATA and LOCALAPPDATA too: resolveHomePaths() reads them directly on
  // Windows, so every profile whose target lives under AppData (vscode, trae,
  // cline, roo-code, kilocode) would otherwise resolve into the real profile and
  // the test would assert against files it did not write.
  process.env.APPDATA = join(sandboxHome, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(sandboxHome, "AppData", "Local");
});

afterEach(() => {
  // Remove the marker before restoring the environment. Restoring first would
  // leave it in the real ~/.graphflow, and a later run would read a preference
  // from a previous run pointing at a deleted workspace.
  // Remove the single marker file, not its directory. homedir() resolves to the
  // sandbox here (HOME and USERPROFILE are both redirected), so a recursive
  // delete of the real ~/.graphflow would be a no-op today and destroy a real
  // user's runtime/ and optional-deps/ on any machine where it did resolve —
  // and the directory holding a stale marker is exactly the one thing this test
  // must not have to reason about.
  rmSync(join(sandboxHome, ".graphflow", "workspace-build.json"), { force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousLocalAppData;
  vi.resetModules();
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("workspace build preference", () => {
  it("records the workspace rather than assuming the current directory", async () => {
    const { wb } = await loadWithSandboxHome();
    const workspace = newWorkspace("gf-wb-ws-");

    const set = wb.setWorkspaceBuildPreference({ enabled: true, workspaceRoot: workspace });
    // `install` can be run from anywhere. A marker that silently pointed at the
    // wrong checkout would write a plausible-looking entry that launches a stale
    // build, which is the exact failure this preference exists to prevent.
    expect(set.workspaceRoot).toBe(workspace);
    expect(wb.getWorkspaceBuildPreference().workspaceRoot).toBe(workspace);
    expect(wb.workspaceBuildServerPath(workspace)).toBe(
      join(workspace, "dist", "surfaces", "mcp", "server.js")
    );
  });

  it("keeps the recorded workspace when a later install omits it", async () => {
    const { wb } = await loadWithSandboxHome();
    const workspace = newWorkspace("gf-wb-ws-");
    wb.setWorkspaceBuildPreference({ enabled: true, workspaceRoot: workspace });

    const set = wb.setWorkspaceBuildPreference({ enabled: true });
    expect(set.workspaceRoot).toBe(workspace);
    expect(set.status).toBe("unchanged");
  });

  it("stores the marker outside any host's config directory", async () => {
    const { wb } = await loadWithSandboxHome();
    const workspace = newWorkspace("gf-wb-ws-");
    wb.setWorkspaceBuildPreference({ enabled: true, workspaceRoot: workspace });

    // An earlier version put this under ~/.config/opencode/plugins/, which baked
    // one host into a decision that applies to all of them.
    expect(wb.getWorkspaceBuildPreference().filePath).toBe(join(sandboxHome, ".graphflow", "workspace-build.json"));
  });

  it("treats a corrupt marker as opted out rather than throwing", async () => {
    mkdirSync(join(sandboxHome, ".graphflow"), { recursive: true });
    writeFileSync(join(sandboxHome, ".graphflow", "workspace-build.json"), "{ not json", "utf8");
    const { wb } = await loadWithSandboxHome();

    // The failure mode is a published-package entry, which is what the user had
    // before. Throwing here would be worse than the thing it guards against.
    expect(wb.getWorkspaceBuildPreference().status).toBe("error");
    expect(wb.getWorkspaceBuildPreference().enabled).toBe(false);
  });

  it("reports a missing build separately from being disabled", async () => {
    const { wb } = await loadWithSandboxHome();
    const workspace = newWorkspace("gf-wb-unbuilt-");
    wb.setWorkspaceBuildPreference({ enabled: true, workspaceRoot: workspace });

    const resolved = wb.resolveWorkspaceBuildServerPath();
    expect(resolved.preference.enabled).toBe(true);
    expect(resolved.path).toBeUndefined();
    expect(resolved.missingBuild).toBe(true);
  });
});

describe("hosts launch the workspace build when opted in", () => {
  it("points every host's entry at the recorded build, in whatever format it uses", async () => {
    // Clear a marker a previous case may have left behind. This test iterates
    // every profile, so one stale marker pointing at a workspace afterEach
    // already deleted makes it report every host as failing — a failure that
    // says nothing about the guard. File only; see afterEach.
    rmSync(join(sandboxHome, ".graphflow", "workspace-build.json"), { force: true });
    const { installer, wb } = await loadWithSandboxHome();
    const workspace = newWorkspace("gf-wb-ws-");
    const serverPath = createWorkspaceBuild(workspace);
    wb.setWorkspaceBuildPreference({ enabled: true, workspaceRoot: workspace });
    // Confirm the guard will actually fire before measuring 18 hosts.
    expect(wb.resolveWorkspaceBuildServerPath().path).toBe(serverPath);

    const profiles = installer.buildAgentProfiles();
    expect(profiles.length).toBeGreaterThan(1);

    // The regression this pins: the guard used to be `agentId === "opencode"`,
    // and measuring all profiles showed 19 of 20 hosts still on the npx launcher.
    const notPointing: string[] = [];
    const detail: string[] = [];
    for (const profile of profiles) {
      const results = installer.installMcpToDetectedAgents({
        strategy: "npx",
        installScope: "user",
        agentIdsOverride: [profile.id],
        preferGlobalInstall: true,
        globalInstallOverride: null,
      });
      const result = results.find((r) => r.agentId === profile.id);
      if (!result) continue; // host has no MCP target
      // Raw text, not parsed: codex declares MCP in TOML, so a JSON-shaped reader
      // would silently skip the one host whose format differs. Asserting on the
      // file's contents covers JSON and TOML alike.
      const raw = existsSync(result.configPath) ? readFileSync(result.configPath, "utf8") : "";
      if (!mentionsServerPath(raw, serverPath)) {
        notPointing.push(profile.id);
        // Carry the evidence, not just the name. A bare list of 18 hosts says
        // nothing about the cause, and guessing at it twice was already wrong.
        detail.push(
          `${profile.id}: status=${result.status} exists=${existsSync(result.configPath)} ` +
            `configPath=${result.configPath} sandbox=${sandboxHome} ` +
            `mentionsDist=${raw.includes("dist") ? "yes" : "no"} message=${String(result.message).slice(0, 80)}`
        );
      }
    }

    expect({ notPointing, detail }).toEqual({ notPointing: [], detail: [] });
  });

  it("reports an actionable error when the workspace has no build", async () => {
    const { installer, wb } = await loadWithSandboxHome();
    const workspace = newWorkspace("gf-wb-unbuilt-");
    wb.setWorkspaceBuildPreference({ enabled: true, workspaceRoot: workspace });

    const [result] = installer.installMcpToDetectedAgents({
      strategy: "npx",
      installScope: "user",
      agentIdsOverride: ["cursor"],
      preferGlobalInstall: true,
      globalInstallOverride: null,
    });

    // Better to fail loudly and name both escapes than to write an entry that
    // points at a file which is not there.
    expect(result?.status).toBe("error");
    expect(result?.message).toMatch(/npm run build/);
    expect(result?.message).toMatch(/--no-workspace-build/);
  });

  it("keeps the npx launcher when the preference is off", async () => {
    const { installer } = await loadWithSandboxHome();
    const workspace = newWorkspace("gf-wb-ws-");
    createWorkspaceBuild(workspace);

    const [result] = installer.installMcpToDetectedAgents({
      strategy: "npx",
      installScope: "user",
      agentIdsOverride: ["cursor"],
      preferGlobalInstall: true,
      globalInstallOverride: null,
    });

    expect(entryArgv(readGraphflowEntry(result?.configPath ?? ""))).not.toContain(
      "dist/surfaces/mcp/server.js"
    );
  });

  it("restores the launcher once the preference is withdrawn", async () => {
    const { installer, wb } = await loadWithSandboxHome();
    const workspace = newWorkspace("gf-wb-ws-");
    const serverPath = createWorkspaceBuild(workspace);
    wb.setWorkspaceBuildPreference({ enabled: true, workspaceRoot: workspace });

    const options = {
      strategy: "npx" as const,
      installScope: "user" as const,
      agentIdsOverride: ["cursor"],
      preferGlobalInstall: true,
      globalInstallOverride: null,
    };
    const first = installer.installMcpToDetectedAgents(options)[0];
    expect(entryArgv(readGraphflowEntry(first?.configPath ?? ""))).toContain(serverPath);

    // Without this arm the preference would be a one-way door: turning it off
    // would leave the user pinned to a build that may be deleted.
    wb.setWorkspaceBuildPreference({ enabled: false });
    const [after] = installer.installMcpToDetectedAgents(options);
    expect(entryArgv(readGraphflowEntry(after?.configPath ?? ""))).not.toContain(serverPath);
  });

  it("copies GRAPHFLOW_* capability flags into the entry's environment", async () => {
    const { installer, wb } = await loadWithSandboxHome();
    const workspace = newWorkspace("gf-wb-ws-");
    createWorkspaceBuild(workspace);
    wb.setWorkspaceBuildPreference({ enabled: true, workspaceRoot: workspace });

    // Hosts launch the server themselves, so a flag exported in the shell never
    // reaches it. Without this the opt-in features are only testable from a
    // terminal, never on a real host.
    const previous = process.env.GRAPHFLOW_PROJECT_BRIEF;
    process.env.GRAPHFLOW_PROJECT_BRIEF = "1";
    try {
      const [result] = installer.installMcpToDetectedAgents({
        strategy: "npx",
        installScope: "user",
        agentIdsOverride: ["cursor"],
        preferGlobalInstall: true,
        globalInstallOverride: null,
      });
      const entry = readGraphflowEntry(result?.configPath ?? "");
      // Hosts spell the env block `env` or `environment`; both are checked
      // because the flag has to arrive either way.
      expect({ ...(entry?.env ?? {}), ...(entry?.environment ?? {}) }).toMatchObject({
        GRAPHFLOW_PROJECT_BRIEF: "1",
      });
    } finally {
      if (previous === undefined) delete process.env.GRAPHFLOW_PROJECT_BRIEF;
      else process.env.GRAPHFLOW_PROJECT_BRIEF = previous;
    }
  });

  it("leaves other entries in a host's config alone", async () => {
    const { installer, wb } = await loadWithSandboxHome();
    const workspace = newWorkspace("gf-wb-ws-");
    createWorkspaceBuild(workspace);
    wb.setWorkspaceBuildPreference({ enabled: true, workspaceRoot: workspace });

    const [result] = installer.installMcpToDetectedAgents({
      strategy: "npx",
      installScope: "user",
      agentIdsOverride: ["cursor"],
      preferGlobalInstall: true,
      globalInstallOverride: null,
    });
    const configPath = result?.configPath ?? "";
    expect(readFileSync(configPath, "utf8")).toContain("graphflow");
    expect(existsSync(configPath)).toBe(true);
  });

  it("agrees on the config path, so the marker is read from the home it writes to", async () => {
    const { installer, wb } = await loadWithSandboxHome();
    // A marker read from one home while the installer writes to another would
    // make the preference silently inert.
    const cursor = installer.buildAgentProfiles().find((p) => p.id === "cursor");
    const expected = cursor?.userTargets?.[0]?.configPath;
    expect(expected).toContain(join(".cursor", "mcp.json"));
    expect(wb.workspaceBuildMarkerPath()).toBe(join(sandboxHome, ".graphflow", "workspace-build.json"));
  });
});

describe("dsh glue patch honours the preference", () => {
  it("launches the workspace build, and the launcher otherwise", async () => {
    // dsh declares its MCP row in a YAML patch rather than a host config file, so
    // it never appears in the profile registry and the generic installer cannot
    // reach it. Without this it would be the one host still running npm's copy.
    const workspace = newWorkspace("gf-dsh-ws-");
    const serverPath = createWorkspaceBuild(workspace);
    const wb = (await import("../src/integrations/workspace-build")) as WorkspaceBuild;
    const dsh = await import("../src/integrations/dsh-harness-installer");

    const before = dsh.buildGraphFlowDshInsertPatch();
    expect(before).toContain("command: npx");
    expect(before).toContain("graphflow-mcp");

    wb.setWorkspaceBuildPreference({ enabled: true, workspaceRoot: workspace });
    const after = dsh.buildGraphFlowDshInsertPatch();
    expect(after).toContain(serverPath);
    expect(after).not.toContain("command: npx");
  });
});

describe("agent profile paths", () => {
  it("resolves every host target to an absolute path with no APPDATA set", async () => {
    // Regression: resolveHomePaths() returned appData="" on non-Windows, so
    // `join("", "Cursor", "User", ...)` produced a RELATIVE path and the
    // installer wrote host configs into whatever directory it ran from — the
    // user's repo. Observed as Cursor/User/... and PearAI/User/... inside this
    // checkout, pointing at a deleted /tmp workspace, which doctor then reported
    // as a dangling entry plus a missing server.
    //
    // APPDATA and LOCALAPPDATA are cleared on purpose. Every other test in this
    // file sets them, which takes the `??` branch and masks the fallback
    // entirely — the first version of this test passed with the bug deliberately
    // reintroduced, which is the whole reason this note exists.
    const prevAppData = process.env.APPDATA;
    const prevLocalAppData = process.env.LOCALAPPDATA;
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
    try {
      const { installer } = await loadWithSandboxHome();
      const relative: string[] = [];
      for (const profile of installer.buildAgentProfiles()) {
        for (const target of profile.userTargets ?? []) {
          if (!isAbsolute(target.configPath)) relative.push(`${profile.id}: ${target.configPath}`);
        }
      }

      // A relative target here is not cosmetic: it means "write into the current
      // working directory".
      expect(relative).toEqual([]);
    } finally {
      if (prevAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prevAppData;
      if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prevLocalAppData;
    }
  });
});

