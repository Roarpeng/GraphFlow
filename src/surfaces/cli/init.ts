import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureGlobalGraphFlowConfig } from "../../config/scaffold";
import { resolveConfig } from "../../config/resolve";
import { diagnoseTeamConfig, type TeamDiagnosis } from "../team/diagnose.js";
import {
  installAllSkills,
  uninstallAllSkillsAndRules,
  getTraeInstallStatus,
  getAntigravityInstallStatus,
  getCopilotInstallStatus,
  getAgentInstructionStatus,
  getAgentSkillStatus,
  type SkillInstallSummary,
  type SkillUninstallResult,
} from "../../integrations/skill-installer";
import {
  detectInstalledAgents,
  formatModelConfigGuide,
  getMcpInstallStatus,
  installMcpToDetectedAgents,
  uninstallMcpFromDetectedAgents,
  type McpInstallResult,
  type McpRemoveResult,
} from "../../integrations/agent-mcp-installer";
import { type ClaudeCodeHooksResult } from "../../integrations/claude-code-hooks";
import {
  DSH_GLUE_ROW_ID,
  type DshHarnessInstallResult,
} from "../../integrations/dsh-harness-installer";
import {
  CLAUDE_CODE_HOST_ADAPTER_ID,
  CURSOR_HOST_ADAPTER_ID,
  DSH_HOST_ADAPTER_ID,
  HOST_ADAPTER_MIGRATED_IDS,
  KIMI_CODE_HOST_ADAPTER_ID,
  getHostAdapterInstallStatus,
  installViaHostAdapter,
  uninstallViaHostAdapter,
  type HostAdapterInstallResult,
} from "../../integrations/host-adapter-install";
import { getHostAdapter } from "../../integrations/host-adapter";
import { PROFILE_HOST_IDS, isProfileHost } from "../../integrations/profile-host-installer";
import { OPENCODE_HOST_ADAPTER_ID } from "../../integrations/opencode-plugin";
import { GEMINI_HOST_ADAPTER_ID } from "../../integrations/gemini-hooks";
import { CODEX_HOST_ADAPTER_ID } from "../../integrations/codex-hooks";

/** Agent ids written by a HostAdapter slice — excluded from the legacy doctor loops. */
const HOST_ADAPTER_MCP_IDS = new Set<string>([
  "cursor",
  "claude-code",
  "kimi-code",
  "cursor-windows",
  "claude-code-windows",
  "kimi-code-windows",
  // Profile-backed hosts own their MCP targets through the generic slice.
  ...PROFILE_HOST_IDS,
  ...PROFILE_HOST_IDS.map((id) => `${id}-windows`),
]);

/** Skill target names written by a HostAdapter slice — excluded from the legacy doctor loops. */
const HOST_ADAPTER_SKILL_AGENTS = new Set<string>([
  "Cursor skill",
  "Claude Code skill",
  "Kimi Code skill",
  "Roo Code skill",
  "Kilo Code skill",
  "Codex skill",
  "Codex (agents) skill",
  "Antigravity skill",
  "Qoder skill",
  "Qoder CN skill",
  "Opencode skill",
]);

/** Instruction target names written by a HostAdapter slice — excluded from the legacy doctor loops. */
const HOST_ADAPTER_INSTRUCTION_AGENTS = new Set<string>([
  "Kimi Code",
  "Windsurf",
  "Cline",
  "Roo Code",
  "Kilo Code",
  "Gemini",
  "Codex",
  "Opencode",
]);

const isWindows = process.platform === "win32";

function resolveHomePaths(): { home: string; appData: string; localAppData: string } {
  const home = homedir();
  const appData = process.env.APPDATA ?? (isWindows ? join(home, "AppData", "Roaming") : "");
  const localAppData = process.env.LOCALAPPDATA ?? (isWindows ? join(home, "AppData", "Local") : "");
  return { home, appData, localAppData };
}

function getTraeUserDirs(): Array<{ name: string; skillsDir: string }> {
  const { home, appData } = resolveHomePaths();
  const dirs: Array<{ name: string; skillsDir: string }> = [];

  if (isWindows) {
    if (existsSync(join(appData, "Trae"))) {
      dirs.push({ name: "Trae", skillsDir: join(appData, "Trae", "User", "skills") });
    }
    if (existsSync(join(appData, "Trae CN"))) {
      dirs.push({ name: "Trae CN", skillsDir: join(appData, "Trae CN", "User", "skills") });
    }
    if (existsSync(join(appData, "TRAE SOLO CN"))) {
      dirs.push({ name: "TRAE SOLO CN", skillsDir: join(appData, "TRAE SOLO CN", "User", "skills") });
    }
  } else {
    if (existsSync(join(home, ".config", "Trae"))) {
      dirs.push({ name: "Trae", skillsDir: join(home, ".config", "Trae", "User", "skills") });
    }
    if (existsSync(join(home, ".config", "Trae CN"))) {
      dirs.push({ name: "Trae CN", skillsDir: join(home, ".config", "Trae CN", "User", "skills") });
    }
    if (existsSync(join(home, ".config", "TRAE SOLO CN"))) {
      dirs.push({ name: "TRAE SOLO CN", skillsDir: join(home, ".config", "TRAE SOLO CN", "User", "skills") });
    }
  }

  return dirs;
}

function resolveSkillSourcePath(): string | undefined {
  const candidates: string[] = [
    join(process.cwd(), "skills", "graphflow"),
    join(__dirname, "..", "..", "..", "skills", "graphflow"),
    join(__dirname, "..", "..", "surfaces", "trae-skill", "graphflow"),
    join(__dirname, "..", "..", "..", "src", "surfaces", "trae-skill", "graphflow"),
    join(process.cwd(), "src", "surfaces", "trae-skill", "graphflow"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "SKILL.md"))) {
      return dir;
    }
  }
  return undefined;
}

function resolveCursorRulesSourcePath(): string | undefined {
  const candidates: string[] = [
    join(__dirname, "..", "..", "surfaces", "cursor-rules"),
    join(__dirname, "..", "..", "..", "src", "surfaces", "cursor-rules"),
    join(process.cwd(), "src", "surfaces", "cursor-rules"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "graphflow.mdc"))) {
      return dir;
    }
  }
  return undefined;
}

export interface SkillInstallResult {
  target: string;
  status: "created" | "updated" | "skipped" | "error";
  message?: string | undefined;
}

export interface CursorRulesInstallResult {
  target: string;
  status: "created" | "updated" | "skipped" | "error";
  message?: string;
}

export function installTraeSkills(): SkillInstallResult[] {
  const results: SkillInstallResult[] = [];

  try {
    const skillSourceDir = resolveSkillSourcePath();

    if (!skillSourceDir) {
      results.push({ target: "Trae", status: "skipped", message: "Skill source not found" });
      return results;
    }

    const traeDirs = getTraeUserDirs();
    if (traeDirs.length === 0) {
      results.push({ target: "Trae", status: "skipped", message: "No Trae installation detected" });
      return results;
    }

    const sourceSkillFile = join(skillSourceDir, "SKILL.md");

    for (const trae of traeDirs) {
      try {
        const destDir = join(trae.skillsDir, "graphflow");
        const destFile = join(destDir, "SKILL.md");

        const existed = existsSync(destFile);
        if (existed) {
          const existingContent = readFileSync(destFile, "utf8");
          const newContent = readFileSync(sourceSkillFile, "utf8");
          if (existingContent === newContent) {
            results.push({ target: trae.name, status: "skipped", message: "already up to date" });
            continue;
          }
        }

        mkdirSync(destDir, { recursive: true });
        copyFileSync(sourceSkillFile, destFile);
        results.push({ target: trae.name, status: existed ? "updated" : "created" });
      } catch (error) {
        results.push({
          target: trae.name,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    results.push({
      target: "Trae",
      status: "error",
      message: `Skill install failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return results;
}

export function installCursorRules(): CursorRulesInstallResult[] {
  const results: CursorRulesInstallResult[] = [];
  const rulesSourceDir = resolveCursorRulesSourcePath();

  if (!rulesSourceDir) {
    results.push({ target: "Cursor", status: "skipped", message: "Cursor rules source not found" });
    return results;
  }

  const { home, appData } = resolveHomePaths();
  const cursorRulesDirs: Array<{ name: string; path: string }> = [];

  // User-level Cursor rules directory
  const userRulesDir = join(home, ".cursor", "rules");
  if (existsSync(join(home, ".cursor"))) {
    cursorRulesDirs.push({ name: "Cursor (user)", path: userRulesDir });
  }

  // Also check AppData location (some Cursor versions)
  const appDataCursorDir = join(appData, "Cursor", "User", "rules");
  if (isWindows && existsSync(join(appData, "Cursor"))) {
    cursorRulesDirs.push({ name: "Cursor (AppData)", path: appDataCursorDir });
  }

  if (cursorRulesDirs.length === 0) {
    results.push({ target: "Cursor", status: "skipped", message: "No Cursor installation detected" });
    return results;
  }

  const sourceRulesFile = join(rulesSourceDir, "graphflow.mdc");

  for (const target of cursorRulesDirs) {
    try {
      const destDir = target.path;
      const destFile = join(destDir, "graphflow.mdc");

      const existed = existsSync(destFile);
      if (existed) {
        const existingContent = readFileSync(destFile, "utf8");
        const newContent = readFileSync(sourceRulesFile, "utf8");
        if (existingContent === newContent) {
          results.push({ target: target.name, status: "skipped", message: "already up to date" });
          continue;
        }
      }

      mkdirSync(destDir, { recursive: true });
      copyFileSync(sourceRulesFile, destFile);
      results.push({ target: target.name, status: existed ? "updated" : "created" });
    } catch (error) {
      results.push({
        target: target.name,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export interface InstallReport {
  command: "install";
  globalConfig: {
    path: string;
    status: "created" | "skipped" | "error";
    message?: string;
  };
  skills: SkillInstallSummary;
  mcp: McpInstallResult[];
  /** Claude Code SessionStart/SessionEnd/Stop hooks for flywheel auto-close. */
  claudeCodeHooks: ClaudeCodeHooksResult;
  /** DeepSeek Harness home-level cordis.patch.yml MCP overlay. */
  dshHarness: DshHarnessInstallResult;
  /** Post-install doctor self-check (never silently skip failures). */
  doctor: DoctorReport;
  /** True when MCP install had no errors and doctor reports no missing items. */
  ok: boolean;
  remediation: string[];
}

export interface BuildInstallReportOptions {
  /** When false, skip async graph bootstrap (tests / dry structural install). Default true. */
  bootstrapGraph?: boolean;
}

export function buildInstallReport(
  workspaceRoot: string = process.cwd(),
  options: BuildInstallReportOptions = {}
): InstallReport {
  const bootstrapGraph = options.bootstrapGraph !== false;
  const globalConfig = ensureGlobalGraphFlowConfig();
  // HostAdapter is the per-host install authority for every registry host:
  // hand-written slices (DSH / Cursor / Claude Code / Kimi Code) and the generic
  // profile-backed slice for the rest. Adding a host no longer needs edits here.
  const hostInstalls = new Map<string, HostAdapterInstallResult>();
  for (const hostId of HOST_ADAPTER_MIGRATED_IDS) {
    hostInstalls.set(hostId, installViaHostAdapter(hostId));
  }
  const hostResult = (hostId: string): HostAdapterInstallResult =>
    hostInstalls.get(hostId) ?? {
      hostId,
      displayName: getHostAdapter(hostId)?.displayName ?? hostId,
      status: "error",
      message: "host adapter dispatch missing",
    };

  const claudeInstalled = hostResult(CLAUDE_CODE_HOST_ADAPTER_ID);
  const dshInstalled = hostResult(DSH_HOST_ADAPTER_ID);
  const claudeCodeHooks: ClaudeCodeHooksResult = {
    status: claudeInstalled.status === "unsupported" ? "skipped" : claudeInstalled.status,
    ...(claudeInstalled.filePath !== undefined ? { filePath: claudeInstalled.filePath } : {}),
    ...(claudeInstalled.message !== undefined ? { message: claudeInstalled.message } : {}),
  };
  // Aggregate legacy writers stay for report shape and for host-scoped extras
  // that are not part of a host slice (Trae user Skills, project-level rules).
  // Every write is idempotent, so the adapter pass above remains authoritative.
  // Silent during report build so `--json` is not polluted; human text comes from formatInstallLegacyText.
  const skills = installAllSkills(undefined, () => undefined, workspaceRoot);
  const mcp = installMcpToDetectedAgents({
    strategy: "npx",
    installScope: "user",
    workspaceRoot,
  });
  const dshHarness: DshHarnessInstallResult = {
    status: dshInstalled.status === "unsupported" ? "skipped" : dshInstalled.status,
    ...(dshInstalled.filePath !== undefined ? { filePath: dshInstalled.filePath } : {}),
    ...(dshInstalled.message !== undefined ? { message: dshInstalled.message } : {}),
  };

  if (bootstrapGraph) {
    void bootstrapGraphIndex(workspaceRoot).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[WARN] Bootstrap graph index skipped: ${message}`);
    });
  }

  const doctor = buildDoctorReport(workspaceRoot);
  const mcpHasError = mcp.some((item) => item.status === "error");
  const hooksHasError = claudeCodeHooks.status === "error";
  const dshHasError = dshHarness.status === "error";
  const hostHasError = [...hostInstalls.values()].some((item) => item.status === "error");
  const skillHasError = [
    ...skills.traeSkills,
    ...skills.cursorRules,
    ...skills.claudeMd,
    ...skills.agentInstructions,
    ...skills.agentSkills,
    ...skills.projectRules,
  ].some((item) => item.status === "error");
  const ok =
    doctor.ok &&
    !mcpHasError &&
    !hooksHasError &&
    !dshHasError &&
    !hostHasError &&
    globalConfig.status !== "error";
  const remediation: string[] = [];
  if (!ok) {
    if (globalConfig.status === "error") {
      remediation.push(
        `Fix global config creation at ${globalConfig.path}${globalConfig.message ? `: ${globalConfig.message}` : "."}`
      );
    }
    if (mcpHasError) {
      remediation.push("Re-run `graphflow install` after fixing MCP target paths for agents marked error.");
    }
    if (hooksHasError) {
      remediation.push(
        `Fix Claude Code hooks install at ${claudeCodeHooks.filePath ?? ""}${
          claudeCodeHooks.message ? `: ${claudeCodeHooks.message}` : "."
        }`
      );
    }
    if (dshHasError) {
      remediation.push(
        `Fix DeepSeek Harness overlay at ${dshHarness.filePath ?? ""}${
          dshHarness.message ? `: ${dshHarness.message}` : "."
        }`
      );
    }
    for (const result of hostInstalls.values()) {
      if (result.status !== "error") continue;
      if (result.hostId === DSH_HOST_ADAPTER_ID) continue; // covered above
      remediation.push(
        `Fix ${result.displayName} HostAdapter install${result.filePath ? ` at ${result.filePath}` : ""}${
          result.message ? `: ${result.message}` : "."
        }`
      );
    }
    if (skillHasError) {
      remediation.push("Inspect skill/rules targets marked error and ensure agent directories are writable.");
    }
    remediation.push(...doctor.remediation);
  }

  return {
    command: "install",
    globalConfig: {
      path: globalConfig.path,
      status: globalConfig.status,
      ...(globalConfig.message ? { message: globalConfig.message } : {}),
    },
    skills,
    mcp,
    claudeCodeHooks,
    dshHarness,
    doctor,
    ok,
    remediation,
  };
}

export function formatInstallLegacyText(report: InstallReport): string {
  const lines: string[] = [];
  lines.push("[START] Installing GraphFlow — global config + skills/rules + MCP...");

  if (report.globalConfig.status === "created") {
    lines.push(`[CREATED] Global config: ${report.globalConfig.path}`);
  } else if (report.globalConfig.status === "error") {
    lines.push(
      `[ERROR] Global config: ${report.globalConfig.path}${report.globalConfig.message ? ` (${report.globalConfig.message})` : ""}`
    );
  } else {
    lines.push(`[SKIP] Global config already exists: ${report.globalConfig.path}`);
  }

  const skillGroups: Array<[string, SkillInstallSummary["traeSkills"]]> = [
    ["Trae Skill", report.skills.traeSkills],
    ["Cursor Rules", report.skills.cursorRules],
    ["Claude Code CLAUDE.md", report.skills.claudeMd],
    ["Agent instructions", report.skills.agentInstructions],
    ["Agent Skill", report.skills.agentSkills],
    ["Project rules", report.skills.projectRules],
  ];
  for (const [label, items] of skillGroups) {
    for (const result of items) {
      if (result.status === "error") {
        lines.push(`[WARN] ${label} ${result.target}: ${result.message ?? "error"}`);
      } else if (result.status === "skipped") {
        lines.push(`[SKIP] ${label} ${result.target}: ${result.message ?? "skipped"}`);
      } else {
        lines.push(
          `[OK] ${result.status === "created" ? "Created" : "Updated"} ${label} for ${result.target}`
        );
      }
    }
  }

  for (const result of report.mcp) {
    const icon = result.status === "error" ? "[ERROR]" : result.status === "skipped" ? "[SKIP]" : "[OK]";
    lines.push(
      `${icon} MCP ${result.agentName} (${result.scope}): ${result.status} -> ${result.configPath}${result.message ? ` (${result.message})` : ""}`
    );
  }

  {
    const hooks = report.claudeCodeHooks;
    const icon = hooks.status === "error" ? "[ERROR]" : hooks.status === "skipped" ? "[SKIP]" : "[OK]";
    lines.push(
      `${icon} Claude Code hooks: ${hooks.status}${hooks.filePath ? ` -> ${hooks.filePath}` : ""}${
        hooks.message ? ` (${hooks.message})` : ""
      }`
    );
  }

  {
    const dsh = report.dshHarness;
    const icon = dsh.status === "error" ? "[ERROR]" : dsh.status === "skipped" ? "[SKIP]" : "[OK]";
    lines.push(
      `${icon} DeepSeek Harness: ${dsh.status}${dsh.filePath ? ` -> ${dsh.filePath}` : ""}${
        dsh.message ? ` (${dsh.message})` : ""
      }`
    );
  }

  lines.push(
    `[FINISH] Installation complete! Global config: ${report.globalConfig.path}`
  );
  lines.push(
    `doctor ok=${report.doctor.ok} installed=${report.doctor.summary.installed} missing=${report.doctor.summary.missing} install ok=${report.ok}`
  );

  if (report.remediation.length > 0) {
    lines.push("");
    lines.push("Remediation:");
    for (const step of report.remediation) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n");
}

export function runInstall() {
  const report = buildInstallReport(process.cwd());
  console.log(formatInstallLegacyText(report));
  if (!report.ok) {
    process.exitCode = 1;
  }
  return report;
}

export function runInit() {
  if (process.env.GRAPHFLOW_SKIP_POSTINSTALL === "1" || process.env.CI === "true") {
    console.log("[SKIP] GraphFlow postinstall skipped in CI/automation.");
    return;
  }

  const workspaceRoot = process.cwd();
  console.log("[START] Initializing GraphFlow global config...");

  // 1. Create global config
  const globalConfig = ensureGlobalGraphFlowConfig();
  if (globalConfig.status === "created") {
    console.log(`[CREATED] Global config: ${globalConfig.path}`);
  } else {
    console.log(`[SKIP] Global config already exists: ${globalConfig.path}`);
  }

  // 2. Install all skills/rules via skill-installer
  installAllSkills(undefined, (message: string) => console.log(message), workspaceRoot);

  // 3. Bootstrap graph index
  void bootstrapGraphIndex(workspaceRoot).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[WARN] Bootstrap graph index skipped: ${message}`);
  });

  console.log(`[FINISH] Initialization complete! Global config: ${join(homedir(), ".graphflow.config.json")}`);
  console.log("[HINT] To run init on npm install, set GRAPHFLOW_ENABLE_POSTINSTALL=1");
}

export function runUninstall(workspaceRoot: string = process.cwd()) {
  console.log("[START] Uninstalling GraphFlow (MCP + Skills + Rules + hooks)...");

  // 1. Per-host removal through HostAdapter (every registry host).
  //    Runs first so the per-host slice owns its own MCP / Skill / rules / hooks.
  for (const hostId of HOST_ADAPTER_MIGRATED_IDS) {
    const label = getHostAdapter(hostId)?.displayName ?? hostId;
    const hostStatus = getHostAdapterInstallStatus(hostId);
    if (!hostStatus?.detected) {
      console.log(`[SKIP] ${label}: not detected`);
      continue;
    }
    const hostUninstalled = uninstallViaHostAdapter(hostId);
    const icon = hostUninstalled.status === "updated" ? "[REMOVED]" : "[SKIP]";
    console.log(`${icon} ${label}: ${hostUninstalled.message ?? hostUninstalled.status}`);
  }

  // 2. Legacy sweep for anything not host-scoped (workspace MCP entries,
  //    Trae user Skills, project-level rules, stray managed blocks).
  const mcpResults = uninstallMcpFromDetectedAgents({ workspaceRoot });
  for (const result of mcpResults) {
    const icon = result.removed ? "[REMOVED]" : "[SKIP]";
    const scope = result.scope ? ` (${result.scope})` : "";
    console.log(`${icon} MCP ${result.agentName}${scope}: ${result.message}`);
  }

  const skillResults = uninstallAllSkillsAndRules(workspaceRoot);
  let skillRemoved = 0;
  for (const result of skillResults) {
    if (!result.removed) continue;
    skillRemoved += 1;
    console.log(`[REMOVED] ${result.target}: ${result.path}`);
  }
  console.log(`[INFO] Skills/Rules removed: ${skillRemoved}/${skillResults.length} targets`);

  console.log("[FINISH] Uninstall complete.");
  console.log("[HINT] If you also installed the Agent Plugin, remove it in Cursor Customize / Plugins,");
  console.log("       and delete any local symlink under ~/.cursor/plugins/local/graphflow.");
}

export interface UninstallReport {
  command: "uninstall";
  mcp: McpRemoveResult[];
  skills: SkillUninstallResult[];
  hooks?: { status: string; message?: string };
  ok: boolean;
}

export type DoctorCheckStatus = "installed" | "missing" | "n/a";
export type DoctorCheckCategory = "mcp" | "config" | "skill" | "instruction" | "project" | "hooks";

export interface DoctorCheckItem {
  category: DoctorCheckCategory;
  agent: string;
  path: string;
  scope?: "user" | "workspace" | "global";
  status: DoctorCheckStatus;
  detected?: boolean;
}

export interface DoctorReport {
  command: "doctor";
  detectedAgents: Array<{ id: string; name: string }>;
  checks: DoctorCheckItem[];
  summary: {
    total: number;
    installed: number;
    missing: number;
    na: number;
  };
  /** True when no check is missing (n/a allowed). */
  ok: boolean;
  /** Next steps when missing items exist; empty when ok. */
  remediation: string[];
  /** Team shared-memory config (mcp-http). Live reachability is filled by `graphflow diagnose`. */
  team?: TeamDiagnosis;
}

function toDoctorStatus(installed: boolean, detected = true): DoctorCheckStatus {
  if (installed) return "installed";
  return detected ? "missing" : "n/a";
}

function pushHostAdapterDoctorChecks(checks: DoctorCheckItem[], hostId: string): void {
  const status = getHostAdapterInstallStatus(hostId);
  if (!status?.detected) return;

  const mcpTargets = status.mcpTargets ?? [];
  if (mcpTargets.length > 0) {
    for (const target of mcpTargets) {
      checks.push({
        category: "mcp",
        agent: target.agentName ?? status.agent,
        path: target.path,
        scope: target.scope ?? "user",
        status: toDoctorStatus(target.installed, true),
        detected: true,
      });
    }
  } else if (status.mcpPath) {
    checks.push({
      category: "mcp",
      agent: status.agent,
      path: status.mcpPath,
      scope: "user",
      status: toDoctorStatus(status.mcpInstalled ?? status.installed, true),
      detected: true,
    });
  } else if (status.patchPath) {
    checks.push({
      category: "mcp",
      agent: status.agent,
      path: status.patchPath,
      scope: "user",
      status: toDoctorStatus(status.installed, true),
      detected: true,
    });
  }

  if (status.skillPath && hostId !== DSH_HOST_ADAPTER_ID) {
    checks.push({
      category: "skill",
      agent: `${status.agent} skill`,
      path: status.skillPath,
      status: toDoctorStatus(status.skillInstalled ?? false, true),
      detected: true,
    });
  }

  const hooksPath = status.hooksPath ?? status.settingsPath;
  if (
    (hostId === CLAUDE_CODE_HOST_ADAPTER_ID ||
      hostId === CURSOR_HOST_ADAPTER_ID ||
      hostId === OPENCODE_HOST_ADAPTER_ID ||
      hostId === GEMINI_HOST_ADAPTER_ID ||
      hostId === CODEX_HOST_ADAPTER_ID) &&
    hooksPath
  ) {
    checks.push({
      category: "hooks",
      agent: `${status.agent} hooks`,
      path: hooksPath,
      scope: "user",
      status: toDoctorStatus(status.hooksInstalled ?? false, true),
      detected: true,
    });
  }

  if (status.rulesPath && (hostId === KIMI_CODE_HOST_ADAPTER_ID || isProfileHost(hostId))) {
    checks.push({
      category: "instruction",
      agent: `${status.agent} instructions`,
      path: status.rulesPath,
      scope: "user",
      status: toDoctorStatus(status.rulesInstalled ?? false, true),
      detected: true,
    });
  }

  if (hostId === DSH_HOST_ADAPTER_ID && status.patchPath) {
    checks.push({
      category: "hooks",
      agent: "DeepSeek Harness glue",
      path: `${status.patchPath}#${DSH_GLUE_ROW_ID}`,
      scope: "user",
      status: toDoctorStatus(status.glueInstalled ?? false, true),
      detected: true,
    });
  }
}

export function buildDoctorReport(workspaceRoot: string = process.cwd()): DoctorReport {
  const agents = detectInstalledAgents();
  const checks: DoctorCheckItem[] = [];

  for (const status of getMcpInstallStatus()) {
    if (HOST_ADAPTER_MCP_IDS.has(status.agentId)) continue;
    checks.push({
      category: "mcp",
      agent: status.agentName,
      path: status.configPath,
      scope: status.scope,
      status: toDoctorStatus(status.installed, status.detected),
      detected: status.detected,
    });
  }

  const globalConfigPath = join(homedir(), ".graphflow.config.json");
  checks.push({
    category: "config",
    agent: "GraphFlow",
    path: globalConfigPath,
    scope: "global",
    status: existsSync(globalConfigPath) ? "installed" : "missing",
    detected: true,
  });

  for (const status of getTraeInstallStatus(workspaceRoot)) {
    checks.push({
      category: "project",
      agent: status.agent,
      path: status.configPath,
      status: toDoctorStatus(status.installed, status.detected),
      detected: status.detected,
    });
  }

  for (const status of getAntigravityInstallStatus(workspaceRoot)) {
    checks.push({
      category: "project",
      agent: status.agent,
      path: status.configPath,
      status: toDoctorStatus(status.installed, status.detected),
      detected: status.detected,
    });
  }

  for (const status of getCopilotInstallStatus(workspaceRoot)) {
    checks.push({
      category: "instruction",
      agent: status.agent,
      path: status.configPath,
      status: toDoctorStatus(status.installed, true),
      detected: true,
    });
  }

  for (const status of getAgentSkillStatus()) {
    if (!status.detected) continue;
    if (HOST_ADAPTER_SKILL_AGENTS.has(status.agent)) continue;
    checks.push({
      category: "skill",
      agent: status.agent,
      path: status.configPath,
      status: toDoctorStatus(status.installed, status.detected),
      detected: status.detected,
    });
  }

  for (const status of getAgentInstructionStatus()) {
    if (!status.detected) continue;
    if (HOST_ADAPTER_INSTRUCTION_AGENTS.has(status.agent)) continue;
    checks.push({
      category: "instruction",
      agent: status.agent,
      path: status.configPath,
      status: toDoctorStatus(status.installed, status.detected),
      detected: status.detected,
    });
  }

  for (const hostId of HOST_ADAPTER_MIGRATED_IDS) {
    pushHostAdapterDoctorChecks(checks, hostId);
  }

  const installed = checks.filter((c) => c.status === "installed").length;
  const missing = checks.filter((c) => c.status === "missing").length;
  const na = checks.filter((c) => c.status === "n/a").length;
  const ok = missing === 0;
  const remediation = ok
    ? []
    : [
        "Run `graphflow install` to register MCP + Skills (+ Claude Code hooks / DeepSeek Harness overlay+glue when detected). Primary dsh path: `dsh plugin --profile web add @roarpeng/graphflow`.",
        "Re-run `graphflow doctor --json` and fix any remaining missing items.",
        "Ensure target agent directories exist (e.g. ~/.cursor / ~/.claude / ~/.kimi-code / ~/.dsh) so installers can detect them.",
      ];

  let team: TeamDiagnosis | undefined;
  try {
    team = diagnoseTeamConfig(resolveConfig());
  } catch {
    team = undefined;
  }

  return {
    command: "doctor",
    detectedAgents: agents.map((a) => ({ id: a.id, name: a.name })),
    checks,
    summary: {
      total: checks.length,
      installed,
      missing,
      na,
    },
    ok,
    remediation,
    ...(team ? { team } : {}),
  };
}

export function formatDoctorLegacyText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("[DOCTOR] GraphFlow self-diagnosis...");
  lines.push(
    `Detected agents: ${report.detectedAgents.map((a) => a.name).join(", ") || "none"}`
  );
  if (report.team) {
    lines.push(
      `Team: enabled=${report.team.enabled} transport=${report.team.transport}` +
        `${report.team.endpoint ? ` endpoint=${report.team.endpoint}` : ""}` +
        ` tenant=${report.team.tenant ?? "default"} auth=${report.team.authMode}` +
        ` rbac=${report.team.rbacExpected ? "expected" : "local"}` +
        `${report.team.reachable === undefined ? "" : ` reachable=${report.team.reachable}`}` +
        `${report.team.degradedToLocal ? " degraded=local" : ""}`
    );
  }

  for (const check of report.checks) {
    const icon =
      check.status === "installed"
        ? "[INSTALLED]"
        : check.status === "missing"
          ? "[MISSING]"
          : "[N/A]";
    const scope = check.scope ? ` (${check.scope})` : "";
    lines.push(`${icon} ${check.agent}${scope}: ${check.path}`);
  }

  lines.push(
    `summary: installed=${report.summary.installed} missing=${report.summary.missing} n/a=${report.summary.na} ok=${report.ok}`
  );

  if (report.remediation.length > 0) {
    lines.push("");
    lines.push("Remediation:");
    for (const step of report.remediation) {
      lines.push(`- ${step}`);
    }
  }

  lines.push("");
  lines.push(formatModelConfigGuide());
  return lines.join("\n");
}

export function runDoctor() {
  const report = buildDoctorReport(process.cwd());
  console.log(formatDoctorLegacyText(report));
  if (!report.ok) {
    process.exitCode = 1;
  }
  return report;
}

export function runMcpRemove(agentId?: string) {
  console.log(`[START] Removing GraphFlow MCP${agentId ? ` from ${agentId}` : " from all agents"}...`);
  const results = uninstallMcpFromDetectedAgents(agentId ? { agentId } : undefined);
  for (const result of results) {
    const icon = result.removed ? "[REMOVED]" : "[SKIP]";
    console.log(`${icon} ${result.agentName}: ${result.message}`);
  }
  console.log("[FINISH] MCP removal complete.");
}

async function bootstrapGraphIndex(workspaceRoot: string): Promise<void> {
  const { indexGraph } = await import("./runtime.js");
  const result = await indexGraph(workspaceRoot);
  console.log(
    `[INDEX] Bootstrap complete: indexedFiles=${result.indexedFiles}; indexedSymbols=${result.indexedSymbols}`
  );
}

if (require.main === module) {
  runInit();
}
