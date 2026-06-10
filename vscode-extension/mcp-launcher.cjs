"use strict";

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

process.env.GRAPHFLOW_MCP_STDIO = "1";
process.env.GRAPHFLOW_LOG_JSON = "1";

const extensionRoot = __dirname;
const runtimeRoot = path.join(extensionRoot, "vendor", "graphflow");
const serverPath = path.join(runtimeRoot, "dist", "surfaces", "mcp", "server.js");

if (!existsSync(serverPath)) {
  console.error(`[GraphFlow MCP launcher] server not found: ${serverPath}`);
  process.exit(1);
}

function resolveNodeCommand() {
  if (process.env.GRAPHFLOW_NODE?.trim()) {
    return process.env.GRAPHFLOW_NODE.trim();
  }

  // When Cursor spawns `node mcp-launcher.cjs`, execPath is already node.exe.
  const execBase = path.basename(process.execPath).toLowerCase();
  if (execBase === "node.exe" || execBase === "node") {
    return process.execPath;
  }

  if (process.env.ELECTRON_RUN_AS_NODE === "1") {
    return process.execPath;
  }

  return "node";
}

const nodeCommand = resolveNodeCommand();
const env = {
  ...process.env,
  GRAPHFLOW_MCP_STDIO: "1",
  GRAPHFLOW_LOG_JSON: "1",
};

if (nodeCommand === process.execPath && process.env.ELECTRON_RUN_AS_NODE !== "1") {
  const execBase = path.basename(process.execPath).toLowerCase();
  if (execBase.includes("cursor") || execBase.includes("code")) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
}

const child = spawn(nodeCommand, [serverPath], {
  cwd: runtimeRoot,
  stdio: "inherit",
  env,
  windowsHide: true,
});

child.on("error", (error) => {
  console.error("[GraphFlow MCP launcher] spawn failed:", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
