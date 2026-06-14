const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

if (process.env.GRAPHFLOW_SKIP_POSTINSTALL === "1" || process.env.CI === "true") {
  process.exit(0);
}

// Only run init when explicitly opted in. Avoid mutating global MCP/config when
// GraphFlow is installed as a transitive dependency of another project.
if (process.env.GRAPHFLOW_ENABLE_POSTINSTALL !== "1") {
  process.exit(0);
}

const initPath = "dist/surfaces/cli/init.js";
if (!existsSync(initPath)) {
  process.exit(0);
}

const result = spawnSync(process.execPath, [initPath], { stdio: "inherit" });
process.exit(result.status ?? 1);
