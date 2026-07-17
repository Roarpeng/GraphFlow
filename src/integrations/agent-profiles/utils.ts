import { homedir, release } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function isWsl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const rel = release() ?? "";
    if (rel.toLowerCase().includes("microsoft") || rel.toLowerCase().includes("wsl")) {
      return true;
    }
  } catch {
    // ignore
  }
  try {
    if (existsSync("/proc/version")) {
      const content = readFileSync("/proc/version", "utf8").toLowerCase();
      if (content.includes("microsoft") || content.includes("wsl")) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

export function getWindowsHomeFromWsl(): string | undefined {
  try {
    const cmd = "wslpath -w ~";
    const result = readFileSync("/proc/version", "utf8").toLowerCase();
    if (result.includes("microsoft")) {
      const wslHome = require("child_process").execSync(cmd, { encoding: "utf8" }).trim();
      if (wslHome.startsWith("/mnt/")) {
        const winPath = wslHome.replace("/mnt/", "").replace(/\//g, "\\");
        if (winPath.length > 1 && winPath[1] === ":") {
          return winPath;
        }
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function resolveHomePaths(): {
  home: string;
  appData: string;
  localAppData: string;
  wslWindowsHome: string | undefined;
} {
  const home = homedir();
  const wslWindowsHome = isWsl() ? getWindowsHomeFromWsl() : undefined;
  let appData: string;
  let localAppData: string;

  if (isWindows()) {
    appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  } else {
    appData = join(home, ".config");
    localAppData = join(home, ".local", "share");
  }

  return { home, appData, localAppData, wslWindowsHome };
}

export { join };
