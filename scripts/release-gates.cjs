"use strict";

const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const configPath = process.env.GRAPHFLOW_CONFIG_PATH;
const args = [
  "tsx",
  join("src", "surfaces", "cli", "index.ts"),
  "governance",
  "release-gate",
  "--min-proven-skills",
  process.env.GRAPHFLOW_RELEASE_MIN_PROVEN_SKILLS ?? "1",
  "--min-fidelity-samples",
  process.env.GRAPHFLOW_RELEASE_MIN_FIDELITY_SAMPLES ?? "1",
  "--max-pending-ratio",
  process.env.GRAPHFLOW_RELEASE_MAX_PENDING_RATIO ?? "0.5",
];
if (configPath) args.push("--config", configPath);

const result = spawnSync("npx", args, {
  stdio: "inherit",
  cwd: join(__dirname, ".."),
  env: process.env,
});
process.exitCode = result.status ?? 1;
