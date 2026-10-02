import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

/**
 * Node >= 20.12 refuses to spawn `.cmd`/`.bat` files without a shell
 * (CVE-2024-27980), and npm installs every CLI (npx, npm, claude, gemini …)
 * as such a shim on Windows. Shims therefore run through `cmd.exe /d /s /c`
 * with every argument quoted; plain executables spawn directly.
 *
 * Arguments reaching cmd.exe come from trusted configuration (validation
 * commands, executor flags). Task text must travel over stdin instead.
 */
export interface ResolvedSpawn {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  /** True when the command runs through cmd.exe. */
  viaCmdShim: boolean;
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
      const upper = join(dir, command + ext);
      if (existsSync(upper)) return upper;
    }
  }
  return undefined;
}

function quoteForCmd(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

export function resolveSpawn(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): ResolvedSpawn {
  if (platform !== "win32") {
    return { command, args, viaCmdShim: false };
  }
  let resolved = command;
  const ext = extname(command).toLowerCase();
  if (!ext && !isAbsolute(command) && !command.includes("/") && !command.includes("\\")) {
    resolved = findOnPath(command, env) ?? command;
  }
  const resolvedExt = extname(resolved).toLowerCase();
  if (resolvedExt === ".cmd" || resolvedExt === ".bat") {
    const line = [resolved, ...args].map(quoteForCmd).join(" ");
    return {
      command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      windowsVerbatimArguments: true,
      viaCmdShim: true,
    };
  }
  return { command: resolved, args, viaCmdShim: false };
}

/**
 * Kill a child and everything it started. On Windows `child.kill()` ends only
 * the direct child — for a `.cmd` shim that is cmd.exe, while the real CLI
 * keeps running and holds the stdio pipes open, so `close` never fires.
 * `taskkill /T /F` takes the whole tree. Never throws.
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  platform: NodeJS.Platform = process.platform
): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const fallback = (): void => {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  };
  if (platform !== "win32") {
    fallback();
    return;
  }
  try {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", fallback);
    killer.unref();
  } catch {
    fallback();
  }
}
