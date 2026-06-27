/**
 * skill-installer.ts — 共享的 Skill / Rules 安装模块
 *
 * 封装 Trae Skill、Cursor Rules、Claude Code CLAUDE.md 的安装逻辑，
 * 可被 CLI init 和 VS Code 扩展共用。所有安装失败静默处理（log warn）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 类型定义 ──────────────────────────────────────────────────────────

export interface SkillInstallResult {
  /** 安装目标名称（如 "Trae"、"Cursor"） */
  target: string;
  /** 安装结果状态 */
  status: "created" | "updated" | "skipped" | "error";
  /** 可选的附加信息 */
  message?: string | undefined;
}

export interface SkillInstallSummary {
  traeSkills: SkillInstallResult[];
  cursorRules: SkillInstallResult[];
  claudeMd: SkillInstallResult[];
}

// ── 平台检测 ──────────────────────────────────────────────────────────

const isWindows = process.platform === "win32";

function resolveHomePaths(): { home: string; appData: string; localAppData: string } {
  const home = homedir();
  const appData = process.env.APPDATA ?? (isWindows ? join(home, "AppData", "Roaming") : "");
  const localAppData =
    process.env.LOCALAPPDATA ?? (isWindows ? join(home, "AppData", "Local") : "");
  return { home, appData, localAppData };
}

// ── Trae Skill 安装 ──────────────────────────────────────────────────

function getTraeUserDirs(): Array<{ name: string; skillsDir: string }> {
  const { home, appData } = resolveHomePaths();
  const dirs: Array<{ name: string; skillsDir: string }> = [];

  if (isWindows) {
    if (existsSync(join(appData, "Trae"))) {
      dirs.push({
        name: "Trae",
        skillsDir: join(appData, "Trae", "User", "skills"),
      });
    }
    if (existsSync(join(appData, "Trae CN"))) {
      dirs.push({
        name: "Trae CN",
        skillsDir: join(appData, "Trae CN", "User", "skills"),
      });
    }
    if (existsSync(join(appData, "TRAE SOLO CN"))) {
      dirs.push({
        name: "TRAE SOLO CN",
        skillsDir: join(appData, "TRAE SOLO CN", "User", "skills"),
      });
    }
  } else {
    if (existsSync(join(home, ".config", "Trae"))) {
      dirs.push({
        name: "Trae",
        skillsDir: join(home, ".config", "Trae", "User", "skills"),
      });
    }
    if (existsSync(join(home, ".config", "Trae CN"))) {
      dirs.push({
        name: "Trae CN",
        skillsDir: join(home, ".config", "Trae CN", "User", "skills"),
      });
    }
    if (existsSync(join(home, ".config", "TRAE SOLO CN"))) {
      dirs.push({
        name: "TRAE SOLO CN",
        skillsDir: join(home, ".config", "TRAE SOLO CN", "User", "skills"),
      });
    }
  }

  return dirs;
}

// ── Cursor Rules 安装 ─────────────────────────────────────────────────

function getCursorRulesDirs(): Array<{ name: string; rulesDir: string }> {
  const { home, appData } = resolveHomePaths();
  const dirs: Array<{ name: string; rulesDir: string }> = [];

  // 用户级 Cursor rules 目录
  if (existsSync(join(home, ".cursor"))) {
    dirs.push({
      name: "Cursor (user)",
      rulesDir: join(home, ".cursor", "rules"),
    });
  }

  // AppData 位置（某些 Cursor 版本）
  if (isWindows && existsSync(join(appData, "Cursor"))) {
    dirs.push({
      name: "Cursor (AppData)",
      rulesDir: join(appData, "Cursor", "User", "rules"),
    });
  }

  return dirs;
}

// ── Claude Code CLAUDE.md 安装 ────────────────────────────────────────

function getClaudeCodeDirs(): Array<{ name: string; claudeDir: string }> {
  const { home, appData } = resolveHomePaths();
  const dirs: Array<{ name: string; claudeDir: string }> = [];

  if (existsSync(join(home, ".claude"))) {
    dirs.push({
      name: "Claude Code",
      claudeDir: join(home, ".claude"),
    });
  }

  if (isWindows && existsSync(join(appData, "Claude Code"))) {
    dirs.push({
      name: "Claude Code (AppData)",
      claudeDir: join(appData, "Claude Code"),
    });
  }

  return dirs;
}

// ── 路径解析（支持多种候选路径） ────────────────────────────────────────

/**
 * 解析 Trae Skill 源文件路径。
 * 支持以下候选路径（按优先级排序）：
 * 1. vendorRuntimeRoot（VS Code 扩展打包后 vendor/graphflow 路径）
 * 2. 标准的 dist/surfaces/ 路径
 * 3. src/surfaces/ 源码路径
 */
export function resolveSkillSourcePath(vendorRuntimeRoot?: string): string | undefined {
  const candidates: string[] = [
    // VS Code 扩展 vendor 路径（打包后）
    ...(vendorRuntimeRoot
      ? [
          join(vendorRuntimeRoot, "src", "surfaces", "trae-skill", "graphflow"),
          join(vendorRuntimeRoot, "dist", "surfaces", "trae-skill", "graphflow"),
        ]
      : []),
    // 标准构建产物路径
    join(__dirname, "..", "..", "surfaces", "trae-skill", "graphflow"),
    join(__dirname, "..", "..", "..", "src", "surfaces", "trae-skill", "graphflow"),
    join(process.cwd(), "src", "surfaces", "trae-skill", "graphflow"),
    join(process.cwd(), "dist", "surfaces", "trae-skill", "graphflow"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "SKILL.md"))) {
      return dir;
    }
  }
  return undefined;
}

/**
 * 解析 Cursor Rules 源文件路径。
 */
export function resolveCursorRulesSourcePath(vendorRuntimeRoot?: string): string | undefined {
  const candidates: string[] = [
    // VS Code 扩展 vendor 路径（打包后）
    ...(vendorRuntimeRoot
      ? [
          join(vendorRuntimeRoot, "src", "surfaces", "cursor-rules"),
          join(vendorRuntimeRoot, "dist", "surfaces", "cursor-rules"),
        ]
      : []),
    // 标准构建产物路径
    join(__dirname, "..", "..", "surfaces", "cursor-rules"),
    join(__dirname, "..", "..", "..", "src", "surfaces", "cursor-rules"),
    join(process.cwd(), "src", "surfaces", "cursor-rules"),
    join(process.cwd(), "dist", "surfaces", "cursor-rules"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "graphflow.mdc"))) {
      return dir;
    }
  }
  return undefined;
}

/**
 * 解析 Claude Code CLAUDE.md 源文件路径。
 */
export function resolveClaudeMdSourcePath(vendorRuntimeRoot?: string): string | undefined {
  const candidates: string[] = [
    // VS Code 扩展 vendor 路径（打包后）
    ...(vendorRuntimeRoot
      ? [
          join(vendorRuntimeRoot, "CLAUDE.md"),
        ]
      : []),
    // 标准路径
    join(__dirname, "..", "..", "CLAUDE.md"),
    join(__dirname, "..", "..", "..", "CLAUDE.md"),
    join(process.cwd(), "CLAUDE.md"),
  ];
  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      return filePath;
    }
  }
  return undefined;
}

// ── 文件安装辅助 ────────────────────────────────────────────────────

/**
 * 通用文件安装：将源文件复制到目标位置，若已存在且内容相同则跳过。
 */
function installFile(
  sourcePath: string,
  destDir: string,
  destFileName: string
): { status: "created" | "updated" | "skipped"; message?: string } {
  const destFile = join(destDir, destFileName);
  const existed = existsSync(destFile);

  if (existed) {
    const existingContent = readFileSync(destFile, "utf8");
    const newContent = readFileSync(sourcePath, "utf8");
    if (existingContent === newContent) {
      return { status: "skipped", message: "already up to date" };
    }
  }

  mkdirSync(destDir, { recursive: true });
  copyFileSync(sourcePath, destFile);
  return { status: existed ? "updated" : "created" };
}

// ── 单项安装函数 ──────────────────────────────────────────────────────

/**
 * 安装 Trae Skill（SKILL.md）到所有检测到的 Trae 用户目录。
 */
export function installTraeSkills(vendorRuntimeRoot?: string): SkillInstallResult[] {
  const results: SkillInstallResult[] = [];
  const skillSourceDir = resolveSkillSourcePath(vendorRuntimeRoot);

  if (!skillSourceDir) {
    results.push({
      target: "Trae",
      status: "skipped",
      message: "Skill source (SKILL.md) not found",
    });
    return results;
  }

  const traeDirs = getTraeUserDirs();
  if (traeDirs.length === 0) {
    results.push({
      target: "Trae",
      status: "skipped",
      message: "No Trae installation detected",
    });
    return results;
  }

  const sourceSkillFile = join(skillSourceDir, "SKILL.md");

  for (const trae of traeDirs) {
    try {
      const destDir = join(trae.skillsDir, "graphflow");
      const result = installFile(sourceSkillFile, destDir, "SKILL.md");
      results.push({ target: trae.name, status: result.status, message: result.message });
    } catch (error) {
      results.push({
        target: trae.name,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/**
 * 安装 Cursor Rules（graphflow.mdc）到所有检测到的 Cursor 用户目录。
 */
export function installCursorRules(vendorRuntimeRoot?: string): SkillInstallResult[] {
  const results: SkillInstallResult[] = [];
  const rulesSourceDir = resolveCursorRulesSourcePath(vendorRuntimeRoot);

  if (!rulesSourceDir) {
    results.push({
      target: "Cursor",
      status: "skipped",
      message: "Cursor rules source (graphflow.mdc) not found",
    });
    return results;
  }

  const cursorDirs = getCursorRulesDirs();
  if (cursorDirs.length === 0) {
    results.push({
      target: "Cursor",
      status: "skipped",
      message: "No Cursor installation detected",
    });
    return results;
  }

  const sourceRulesFile = join(rulesSourceDir, "graphflow.mdc");

  for (const cursor of cursorDirs) {
    try {
      const result = installFile(sourceRulesFile, cursor.rulesDir, "graphflow.mdc");
      results.push({ target: cursor.name, status: result.status, message: result.message });
    } catch (error) {
      results.push({
        target: cursor.name,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/**
 * 安装 Claude Code CLAUDE.md 到检测到的 Claude Code 用户目录。
 */
export function installClaudeCodeMd(vendorRuntimeRoot?: string): SkillInstallResult[] {
  const results: SkillInstallResult[] = [];
  const sourcePath = resolveClaudeMdSourcePath(vendorRuntimeRoot);

  if (!sourcePath) {
    results.push({
      target: "Claude Code",
      status: "skipped",
      message: "CLAUDE.md source not found",
    });
    return results;
  }

  const claudeDirs = getClaudeCodeDirs();
  if (claudeDirs.length === 0) {
    results.push({
      target: "Claude Code",
      status: "skipped",
      message: "No Claude Code installation detected",
    });
    return results;
  }

  for (const claude of claudeDirs) {
    try {
      const result = installFile(sourcePath, claude.claudeDir, "CLAUDE.md");
      results.push({ target: claude.name, status: result.status, message: result.message });
    } catch (error) {
      results.push({
        target: claude.name,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

// ── 一站式安装函数 ────────────────────────────────────────────────────

/**
 * 一键安装所有 Skill / Rules / CLAUDE.md。
 * 所有失败静默处理（catch + 返回 error 状态），不会抛出异常。
 *
 * @param vendorRuntimeRoot 可选的 vendor 运行时根目录（VS Code 扩展中使用）
 * @param log 可选的日志回调，用于输出安装信息
 */
export function installAllSkills(
  vendorRuntimeRoot?: string,
  log?: (message: string) => void
): SkillInstallSummary {
  const logFn = log ?? ((msg: string) => console.log(msg));

  const traeSkills = installTraeSkills(vendorRuntimeRoot);
  for (const result of traeSkills) {
    if (result.status === "error") {
      logFn(`[WARN] Trae Skill ${result.target}: ${result.message}`);
      continue;
    }
    if (result.status === "skipped") {
      logFn(`[SKIP] Trae Skill ${result.target}: ${result.message ?? "skipped"}`);
      continue;
    }
    logFn(`[OK] ${result.status === "created" ? "Created" : "Updated"} Trae Skill for ${result.target}`);
  }

  const cursorRules = installCursorRules(vendorRuntimeRoot);
  for (const result of cursorRules) {
    if (result.status === "error") {
      logFn(`[WARN] Cursor Rules ${result.target}: ${result.message}`);
      continue;
    }
    if (result.status === "skipped") {
      logFn(`[SKIP] Cursor Rules ${result.target}: ${result.message ?? "skipped"}`);
      continue;
    }
    logFn(`[OK] ${result.status === "created" ? "Created" : "Updated"} Cursor Rules for ${result.target}`);
  }

  const claudeMd = installClaudeCodeMd(vendorRuntimeRoot);
  for (const result of claudeMd) {
    if (result.status === "error") {
      logFn(`[WARN] Claude Code CLAUDE.md ${result.target}: ${result.message}`);
      continue;
    }
    if (result.status === "skipped") {
      logFn(`[SKIP] Claude Code CLAUDE.md ${result.target}: ${result.message ?? "skipped"}`);
      continue;
    }
    logFn(`[OK] ${result.status === "created" ? "Created" : "Updated"} Claude Code CLAUDE.md for ${result.target}`);
  }

  return { traeSkills, cursorRules, claudeMd };
}
