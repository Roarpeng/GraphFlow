#!/usr/bin/env node
const { existsSync, mkdirSync, copyFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const { spawnSync } = require("node:child_process");

const isWindows = process.platform === "win32";

function resolveHomePaths() {
  const home = homedir();
  const appData = process.env.APPDATA || (isWindows ? join(home, "AppData", "Roaming") : "");
  const localAppData = process.env.LOCALAPPDATA || (isWindows ? join(home, "AppData", "Local") : "");
  return { home, appData, localAppData };
}

function detectTrae() {
  const { home, appData } = resolveHomePaths();
  const markers = [
    join(home, ".trae"),
    join(home, ".trae-cn"),
    join(appData, "Trae"),
    join(appData, "Trae CN"),
  ];
  return markers.some((m) => existsSync(m));
}

function getTraeUserDirs() {
  const { home, appData } = resolveHomePaths();
  const dirs = [];

  if (isWindows) {
    if (existsSync(join(appData, "Trae"))) {
      dirs.push({
        name: "Trae",
        userDir: join(appData, "Trae", "User"),
        skillsDir: join(appData, "Trae", "User", "skills"),
      });
    }
    if (existsSync(join(appData, "Trae CN"))) {
      dirs.push({
        name: "Trae CN",
        userDir: join(appData, "Trae CN", "User"),
        skillsDir: join(appData, "Trae CN", "User", "skills"),
      });
    }
  } else {
    if (existsSync(join(home, ".config", "Trae"))) {
      dirs.push({
        name: "Trae",
        userDir: join(home, ".config", "Trae", "User"),
        skillsDir: join(home, ".config", "Trae", "User", "skills"),
      });
    }
    if (existsSync(join(home, ".config", "Trae CN"))) {
      dirs.push({
        name: "Trae CN",
        userDir: join(home, ".config", "Trae CN", "User"),
        skillsDir: join(home, ".config", "Trae CN", "User", "skills"),
      });
    }
  }

  return dirs;
}

function installSkill(skillsDir, skillSourceDir) {
  const skillDestDir = join(skillsDir, "graphflow");
  const skillDestFile = join(skillDestDir, "SKILL.md");
  const skillSourceFile = join(skillSourceDir, "SKILL.md");

  if (!existsSync(skillSourceFile)) {
    return { status: "skipped", reason: "skill source not found" };
  }

  const existed = existsSync(skillDestFile);

  if (existed) {
    const existingContent = readFileSync(skillDestFile, "utf8");
    const newContent = readFileSync(skillSourceFile, "utf8");
    if (existingContent === newContent) {
      return { status: "skipped", reason: "already up to date" };
    }
  }

  mkdirSync(skillDestDir, { recursive: true });
  copyFileSync(skillSourceFile, skillDestFile);

  return { status: existed ? "updated" : "created" };
}

function getSkillSourceDir() {
  const candidates = [
    join(__dirname, "..", "dist", "surfaces", "trae-skill", "graphflow"),
    join(__dirname, "..", "src", "surfaces", "trae-skill", "graphflow"),
  ];

  for (const dir of candidates) {
    if (existsSync(join(dir, "SKILL.md"))) {
      return dir;
    }
  }
  return null;
}

function runMcpInstaller() {
  const installerPath = join(__dirname, "..", "dist", "integrations", "agent-mcp-installer.js");
  if (!existsSync(installerPath)) {
    return { status: "skipped", reason: "installer not built yet" };
  }

  try {
    const result = spawnSync(
      process.execPath,
      ["-e", `
        const { installMcpToDetectedAgents } = require(${JSON.stringify(installerPath)});
        const results = installMcpToDetectedAgents({ strategy: "npx" });
        console.log(JSON.stringify(results));
      `],
      { encoding: "utf8" }
    );
    if (result.status === 0 && result.stdout.trim()) {
      try {
        return { status: "installed", details: JSON.parse(result.stdout.trim()) };
      } catch {
        return { status: "unknown", output: result.stdout.trim() };
      }
    }
    return { status: "error", error: result.stderr || result.stdout };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

function isGlobalInstall() {
  if (process.env.npm_config_global === "true") {
    return true;
  }
  try {
    const pkgRoot = join(__dirname, "..");
    const globalPrefix = process.env.npm_config_prefix || "";
    if (globalPrefix && pkgRoot.startsWith(globalPrefix)) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function main() {
  if (process.env.GRAPHFLOW_SKIP_POSTINSTALL === "1" || process.env.CI === "true") {
    process.exit(0);
  }

  const globalInstall = isGlobalInstall();
  const explicitlyEnabled = process.env.GRAPHFLOW_ENABLE_POSTINSTALL === "1";

  if (!globalInstall && !explicitlyEnabled) {
    console.log("[GraphFlow] Local install detected. Auto-setup skipped to avoid modifying your global config.");
    console.log("[GraphFlow] To install GraphFlow MCP + Skill, run:");
    console.log("[GraphFlow]   npx @roarpeng/graphflow install");
    process.exit(0);
  }

  console.log(`[GraphFlow] Running post-install setup (${globalInstall ? "global install" : "explicitly enabled"})...`);

  const skillSourceDir = getSkillSourceDir();
  const traeDirs = getTraeUserDirs();

  const skillResults = [];
  if (skillSourceDir && traeDirs.length > 0) {
    for (const trae of traeDirs) {
      const result = installSkill(trae.skillsDir, skillSourceDir);
      skillResults.push({ agent: trae.name, ...result });
      console.log(`[GraphFlow] Skill for ${trae.name}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
    }
  }

  const mcpResult = runMcpInstaller();
  if (mcpResult.status === "installed" && Array.isArray(mcpResult.details)) {
    for (const item of mcpResult.details) {
      console.log(`[GraphFlow] MCP for ${item.agentName} (${item.scope}): ${item.status}`);
    }
  } else if (mcpResult.status === "skipped") {
    console.log(`[GraphFlow] MCP install skipped: ${mcpResult.reason}`);
  }

  console.log("[GraphFlow] Post-install complete.");
}

if (require.main === module) {
  main();
}

module.exports = { installSkill, detectTrae, getTraeUserDirs, getSkillSourceDir };
