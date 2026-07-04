import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureGlobalGraphFlowConfig } from "../../config/scaffold";
import { installAllSkills } from "../../integrations/skill-installer";
import {
  detectInstalledAgents,
  formatModelConfigGuide,
  getMcpInstallStatus,
  installMcpToDetectedAgents,
  uninstallMcpFromDetectedAgents,
} from "../../integrations/agent-mcp-installer";

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

export function runInstall() {
  const workspaceRoot = process.cwd();
  console.log("[START] Installing GraphFlow — global config + skills/rules + MCP...");

  // 1. Create global config
  const globalConfig = ensureGlobalGraphFlowConfig();
  if (globalConfig.status === "created") {
    console.log(`[CREATED] Global config: ${globalConfig.path}`);
  } else {
    console.log(`[SKIP] Global config already exists: ${globalConfig.path}`);
  }

  // 2. Install all skills/rules via skill-installer
  installAllSkills(undefined, (message: string) => console.log(message), workspaceRoot);

  // 3. Install MCP to detected agents
  const mcpResults = installMcpToDetectedAgents({
    strategy: "npx",
    installScope: "user",
    workspaceRoot,
  });
  for (const result of mcpResults) {
    const icon = result.status === "error" ? "[ERROR]" : result.status === "skipped" ? "[SKIP]" : "[OK]";
    console.log(
      `${icon} MCP ${result.agentName} (${result.scope}): ${result.status} -> ${result.configPath}${result.message ? ` (${result.message})` : ""}`
    );
  }

  // 4. Bootstrap graph index
  void bootstrapGraphIndex(workspaceRoot).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[WARN] Bootstrap graph index skipped: ${message}`);
  });

  console.log(`[FINISH] Installation complete! Global config: ${join(homedir(), ".graphflow.config.json")}`);
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

export function runUninstall() {
  console.log("[START] Uninstalling GraphFlow...");

  // 1. Remove MCP configs from detected agents
  const mcpResults = uninstallMcpFromDetectedAgents();
  for (const result of mcpResults) {
    const icon = result.removed ? "[REMOVED]" : "[SKIP]";
    console.log(`${icon} MCP ${result.agentName}: ${result.message}`);
  }

  console.log("[FINISH] Uninstall complete.");
}

export function runDoctor() {
  console.log("[DOCTOR] GraphFlow self-diagnosis...");

  // 1. Detect agents
  const agents = detectInstalledAgents();
  console.log(`Detected agents: ${agents.map((a) => a.name).join(", ") || "none"}`);

  // 2. MCP install status
  const mcpStatus = getMcpInstallStatus();
  for (const status of mcpStatus) {
    const icon = status.installed ? "[INSTALLED]" : "[MISSING]";
    console.log(`${icon} ${status.agentName} (${status.scope}): ${status.configPath}`);
  }

  // 3. Config status
  const globalConfigPath = join(homedir(), ".graphflow.config.json");
  console.log(`Global config: ${existsSync(globalConfigPath) ? "exists" : "missing"} at ${globalConfigPath}`);

  // 4. Model config guide
  console.log("\n" + formatModelConfigGuide());
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
