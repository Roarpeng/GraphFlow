"use strict";

const { spawn, execFileSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.GRAPHFLOW_MCP_STDIO = "1";
process.env.GRAPHFLOW_LOG_JSON = "1";

const extensionRoot = __dirname;
const runtimeRoot = path.join(extensionRoot, "vendor", "graphflow");
const serverPath = path.join(runtimeRoot, "dist", "surfaces", "mcp", "server.js");

if (!existsSync(serverPath)) {
  console.error(`[GraphFlow MCP launcher] server not found: ${serverPath}`);
  process.exit(1);
}

function isWsl() {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const release = os.release() || "";
    if (release.toLowerCase().includes("microsoft") || release.toLowerCase().includes("wsl")) {
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

function resolveSystemNode() {
  try {
    const lookup = process.platform === "win32" ? "where.exe" : "which";
    const target = process.platform === "win32" ? "node.exe" : "node";
    const output = execFileSync(lookup, [target], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (line && existsSync(line)) {
        return line;
      }
    }
  } catch {
    // fall through
  }
  if (process.platform !== "win32") {
    const candidates = ["/usr/local/bin/node", "/usr/bin/node"];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function resolveNodeCommand() {
  if (process.env.GRAPHFLOW_NODE?.trim()) {
    return process.env.GRAPHFLOW_NODE.trim();
  }

  const execBase = path.basename(process.execPath).toLowerCase();
  if (execBase === "node.exe" || execBase === "node") {
    return process.execPath;
  }

  if (process.env.ELECTRON_RUN_AS_NODE === "1") {
    return process.execPath;
  }

  const systemNode = resolveSystemNode();
  if (systemNode) {
    return systemNode;
  }

  if (isWsl()) {
    try {
      const winNode = execFileSync("cmd.exe", ["/c", "where", "node"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }).trim();
      const lines = winNode.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length > 0) {
        console.warn("[GraphFlow MCP launcher] WSL: using Windows node.exe as fallback");
        return lines[0];
      }
    } catch {
      // ignore
    }
  }

  return "node";
}

function isUnsafeWorkspacePath(dir) {
  const normalized = path.resolve(dir).replace(/\\/g, "/").toLowerCase();
  const home = os.homedir().replace(/\\/g, "/").toLowerCase();
  if (normalized === home) {
    return true;
  }
  const localAppData = process.env.LOCALAPPDATA?.replace(/\\/g, "/").toLowerCase();
  if (localAppData && normalized === localAppData) {
    return true;
  }
  const roamingAppData = process.env.APPDATA?.replace(/\\/g, "/").toLowerCase();
  if (roamingAppData && normalized === roamingAppData) {
    return true;
  }
  return false;
}

/**
 * Resolve a safe workspace root for the MCP child.
 * Returns undefined when no safe project root is available — never home/AppData.
 */
function resolveChildWorkspaceRoot() {
  const explicit = process.env.GRAPHFLOW_WORKSPACE_ROOT?.trim();
  if (explicit && explicit !== "${workspaceFolder}") {
    const resolved = path.resolve(explicit);
    if (!isUnsafeWorkspacePath(resolved)) {
      return resolved;
    }
    delete process.env.GRAPHFLOW_WORKSPACE_ROOT;
  }

  try {
    const { ensureMcpWorkspaceEnv, isUnsafeWorkspaceFallback } = require(path.join(
      runtimeRoot,
      "dist",
      "config",
      "discover-workspace.js"
    ));
    const discovered = ensureMcpWorkspaceEnv(process.cwd());
    if (discovered && !isUnsafeWorkspaceFallback(discovered)) {
      return discovered;
    }
  } catch {
    // Fall through when bundled runtime is unavailable during development.
  }

  const cwd = process.cwd();
  const normalized = cwd.replace(/\\/g, "/").toLowerCase();
  const isRuntime =
    normalized.includes("/vendor/graphflow") ||
    normalized.includes("node_modules/@roarpeng/graphflow") ||
    normalized.includes("graphflow-vscode-") ||
    normalized.includes("/.cursor/extensions/");

  if (isRuntime || isUnsafeWorkspacePath(cwd)) {
    return undefined;
  }
  return cwd;
}

const nodeCommand = resolveNodeCommand();
const workspaceRoot = resolveChildWorkspaceRoot();
// Always give the child a writable cwd; prefer the discovered project, else vendor runtime.
const childCwd = workspaceRoot ?? runtimeRoot;
const env = {
  ...process.env,
  GRAPHFLOW_MCP_STDIO: "1",
  GRAPHFLOW_LOG_JSON: "1",
};
if (workspaceRoot) {
  env.GRAPHFLOW_WORKSPACE_ROOT = workspaceRoot;
} else {
  delete env.GRAPHFLOW_WORKSPACE_ROOT;
}

if (nodeCommand === process.execPath && process.env.ELECTRON_RUN_AS_NODE !== "1") {
  const execBase = path.basename(process.execPath).toLowerCase();
  if (execBase.includes("cursor") || execBase.includes("code")) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
}

if (process.env.GRAPHFLOW_LAUNCHER_DEBUG === "1") {
  console.error(`[GraphFlow MCP launcher] nodeCommand: ${nodeCommand}`);
  console.error(`[GraphFlow MCP launcher] serverPath: ${serverPath}`);
  console.error(`[GraphFlow MCP launcher] childCwd: ${childCwd}`);
  console.error(`[GraphFlow MCP launcher] workspaceRoot: ${workspaceRoot ?? "(unset)"}`);
  console.error(`[GraphFlow MCP launcher] isWsl: ${isWsl()}`);
  console.error(`[GraphFlow MCP launcher] platform: ${process.platform}`);
}

let child;
try {
  child = spawn(nodeCommand, [serverPath], {
    cwd: childCwd,
    stdio: "inherit",
    env,
    windowsHide: true,
  });
} catch (spawnError) {
  console.error("[GraphFlow MCP launcher] Failed to spawn node process:", spawnError.message || String(spawnError));
  console.error(`[GraphFlow MCP launcher] Tried command: ${nodeCommand} ${serverPath}`);
  console.error("[GraphFlow MCP launcher] Troubleshooting:");
  console.error("[GraphFlow MCP launcher]   1. Ensure Node.js 20+ is installed and in PATH");
  console.error("[GraphFlow MCP launcher]   2. On WSL, install node in the Linux environment: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs");
  console.error("[GraphFlow MCP launcher]   3. Set GRAPHFLOW_NODE environment variable to a specific node path");
  console.error("[GraphFlow MCP launcher]   4. Set GRAPHFLOW_LAUNCHER_DEBUG=1 for more details");
  process.exit(1);
}

child.on("error", (error) => {
  console.error("[GraphFlow MCP launcher] spawn error:", error);
  console.error(`[GraphFlow MCP launcher] command: ${nodeCommand}`);
  console.error(`[GraphFlow MCP launcher] cwd: ${childCwd}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  if (code !== 0 && code !== undefined) {
    console.error(`[GraphFlow MCP launcher] child exited with code ${code}`);
  }
  process.exit(code ?? 1);
});
