const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

if (process.env.GRAPHFLOW_SKIP_POSTINSTALL === "1" || process.env.CI === "true") {
  process.exit(0);
}

const initPath = "dist/surfaces/cli/init.js";
if (!existsSync(initPath)) {
  process.exit(0);
}

const result = spawnSync(process.execPath, [initPath], { stdio: "inherit" });
process.exit(result.status ?? 1);
