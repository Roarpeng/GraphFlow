"use strict";

const { spawnSync } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, isAbsolute, join } = require("node:path");

const json = process.argv.includes("--json");
const args = ["audit", "--omit=dev", "--registry=https://registry.npmjs.org"];
if (json) args.push("--json");
const root = join(__dirname, "..");
const result = spawnSync("npm", args, {
  cwd: root,
  encoding: "utf8",
  env: process.env,
  // Node ≥ 18 refuses .cmd shims (npm.cmd) without a shell (EINVAL / exit 1).
  shell: process.platform === "win32",
});
if (json && result.stdout) {
  const outputPath = process.env.GRAPHFLOW_SECURITY_REPORT ?? "graphflow-out/security-audit.json";
  const resolved = isAbsolute(outputPath) ? outputPath : join(root, outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, result.stdout, "utf8");
}
process.exitCode = result.status ?? 1;
