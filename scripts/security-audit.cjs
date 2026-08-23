"use strict";

const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const json = process.argv.includes("--json");
const args = ["audit", "--omit=dev", "--registry=https://registry.npmjs.org"];
if (json) args.push("--json");
const result = spawnSync("npm", args, {
  cwd: join(__dirname, ".."),
  encoding: "utf8",
  env: process.env,
});
if (json && result.stdout) {
  const outputPath = process.env.GRAPHFLOW_SECURITY_REPORT ?? "graphflow-out/security-audit.json";
  writeFileSync(outputPath, result.stdout, "utf8");
}
process.exitCode = result.status ?? 1;
