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

// Run the gate through node + tsx directly: spawning the "npx" shim is not
// portable (Windows refuses .cmd shims without a shell, EINVAL on Node >= 18).
const tsxCli = join(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");
const result = spawnSync(process.execPath, [tsxCli, ...args.slice(1)], {
  stdio: "inherit",
  cwd: join(__dirname, ".."),
  env: process.env,
});
process.exitCode = result.status ?? 1;
