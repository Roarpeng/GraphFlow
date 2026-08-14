/**
 * DeepSeek Harness (dsh) installer — home-level cordis.patch.yml overlay.
 *
 * GraphFlow ships as a dsh bundle (`dsh.bundle` + `cordis.patch.yml`). Users can:
 *   dsh plugin --profile web add @roarpeng/graphflow
 *
 * `graphflow install` also writes the same MCP insert into `$DSH_HOME/cordis.patch.yml`
 * (shared by every profile) when ~/.dsh (or DSH_HOME / GRAPHFLOW_DSH_HOME) exists.
 * Skills go to `$DSH_HOME/skills/graphflow/SKILL.md` via skill-installer targets.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DSH_HOME_ENV = "GRAPHFLOW_DSH_HOME";
export const DSH_MCP_ROW_ID = "mcp-graphflow";
export const DSH_PATCH_BEGIN = "# GRAPHFLOW-DSH-BEGIN";
export const DSH_PATCH_END = "# GRAPHFLOW-DSH-END";

export interface DshHarnessPaths {
  dshHome: string;
  patchPath: string;
  skillsRoot: string;
  skillPath: string;
}

export interface DshHarnessStatus {
  agent: string;
  detected: boolean;
  installed: boolean;
  dshHome: string;
  patchPath: string;
  skillPath: string;
  skillInstalled: boolean;
}

export interface DshHarnessInstallResult {
  status: "created" | "updated" | "skipped" | "error";
  filePath?: string;
  message?: string;
}

/** Resolve DeepSeek Harness home: GRAPHFLOW_DSH_HOME, else DSH_HOME, else ~/.dsh. */
export function resolveDshHome(override?: string): string {
  const explicit = override?.trim() || process.env[DSH_HOME_ENV]?.trim() || process.env.DSH_HOME?.trim();
  if (explicit) {
    return explicit;
  }
  return join(homedir(), ".dsh");
}

export function getDshHarnessPaths(dshHome = resolveDshHome()): DshHarnessPaths {
  const skillsRoot = join(dshHome, "skills");
  return {
    dshHome,
    patchPath: join(dshHome, "cordis.patch.yml"),
    skillsRoot,
    skillPath: join(skillsRoot, "graphflow", "SKILL.md"),
  };
}

export function isDshHarnessDetected(dshHome = resolveDshHome()): boolean {
  return existsSync(dshHome);
}

/**
 * The insert layer GraphFlow contributes as a dsh bundle.
 * Keep in sync with repo-root `cordis.patch.yml` (asserted by tests).
 */
export function buildGraphFlowDshInsertPatch(): string {
  return [
    "- insert:",
    `    - id: ${DSH_MCP_ROW_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: graphflow",
    "        transport: stdio",
    "        command: npx",
    "        args:",
    "          - '-y'",
    "          - '--package=@roarpeng/graphflow'",
    "          - graphflow-mcp",
    "        env:",
    "          GRAPHFLOW_MCP_STDIO: '1'",
    "          GRAPHFLOW_LOG_JSON: '1'",
    "        failOnStartupError: false",
    "",
  ].join("\n");
}

export function wrapDshManagedPatch(insertPatch: string = buildGraphFlowDshInsertPatch()): string {
  return `${DSH_PATCH_BEGIN}\n${insertPatch.trimEnd()}\n${DSH_PATCH_END}\n`;
}

export function patchContainsGraphFlowDsh(content: string): boolean {
  if (content.includes(DSH_PATCH_BEGIN) && content.includes(DSH_PATCH_END)) {
    return true;
  }
  return new RegExp(`^\\s*-\\s*id:\\s*${DSH_MCP_ROW_ID}\\s*$`, "m").test(content);
}

function upsertManagedPatch(existing: string, managed: string): { next: string; changed: boolean; kind: "created" | "updated" | "skipped" } {
  const beginIdx = existing.indexOf(DSH_PATCH_BEGIN);
  const endIdx = existing.indexOf(DSH_PATCH_END);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + DSH_PATCH_END.length).replace(/^\n/, "");
    const next = `${before}${managed}${after}`.replace(/\n{3,}/g, "\n\n");
    if (next === existing) {
      return { next, changed: false, kind: "skipped" };
    }
    return { next, changed: true, kind: "updated" };
  }

  if (!existing.trim()) {
    return { next: managed, changed: true, kind: "created" };
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return { next: `${existing}${separator}${managed}`, changed: true, kind: "updated" };
}

export function removeManagedDshPatch(content: string): { next: string; removed: boolean } {
  const beginIdx = content.indexOf(DSH_PATCH_BEGIN);
  const endIdx = content.indexOf(DSH_PATCH_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    return { next: content, removed: false };
  }
  const before = content.slice(0, beginIdx);
  const after = content.slice(endIdx + DSH_PATCH_END.length).replace(/^\n/, "");
  return { next: `${before}${after}`.replace(/\n{3,}/g, "\n\n").trimStart(), removed: true };
}

export function getDshHarnessStatus(options: { dshHome?: string } = {}): DshHarnessStatus {
  const paths = getDshHarnessPaths(resolveDshHome(options.dshHome));
  const detected = existsSync(paths.dshHome);
  let installed = false;
  if (detected && existsSync(paths.patchPath)) {
    try {
      installed = patchContainsGraphFlowDsh(readFileSync(paths.patchPath, "utf8"));
    } catch {
      installed = false;
    }
  }
  return {
    agent: "DeepSeek Harness",
    detected,
    installed,
    dshHome: paths.dshHome,
    patchPath: paths.patchPath,
    skillPath: paths.skillPath,
    skillInstalled: existsSync(paths.skillPath),
  };
}

export function installDshHarness(options: { dshHome?: string } = {}): DshHarnessInstallResult {
  const paths = getDshHarnessPaths(resolveDshHome(options.dshHome));
  if (!existsSync(paths.dshHome)) {
    return {
      status: "skipped",
      filePath: paths.patchPath,
      message: "DeepSeek Harness not detected",
    };
  }

  try {
    mkdirSync(dirname(paths.patchPath), { recursive: true });
    const existing = existsSync(paths.patchPath) ? readFileSync(paths.patchPath, "utf8") : "";
    const managed = wrapDshManagedPatch();
    const { next, kind } = upsertManagedPatch(existing, managed);
    if (kind === "skipped") {
      return { status: "skipped", filePath: paths.patchPath, message: "already up to date" };
    }
    writeFileSync(paths.patchPath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
    return { status: kind, filePath: paths.patchPath };
  } catch (error) {
    return {
      status: "error",
      filePath: paths.patchPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function uninstallDshHarness(options: { dshHome?: string } = {}): DshHarnessInstallResult {
  const paths = getDshHarnessPaths(resolveDshHome(options.dshHome));
  if (!existsSync(paths.patchPath)) {
    return {
      status: "skipped",
      filePath: paths.patchPath,
      message: "not found",
    };
  }

  try {
    const existing = readFileSync(paths.patchPath, "utf8");
    const { next, removed } = removeManagedDshPatch(existing);
    if (!removed) {
      return { status: "skipped", filePath: paths.patchPath, message: "no GraphFlow block" };
    }
    if (!next.trim()) {
      writeFileSync(paths.patchPath, "", "utf8");
    } else {
      writeFileSync(paths.patchPath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
    }
    return { status: "updated", filePath: paths.patchPath, message: "removed GraphFlow MCP insert" };
  } catch (error) {
    return {
      status: "error",
      filePath: paths.patchPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
