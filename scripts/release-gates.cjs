"use strict";

const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const root = join(__dirname, "..");
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
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const governance = spawnSync(process.execPath, [tsxCli, ...args.slice(1)], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
const governanceStatus = governance.status ?? 1;

// Efficiency Agent release gate (code/contract/security/cache/golden/chaos/perf/package).
let effStatus = 0;
if (process.env.GRAPHFLOW_RELEASE_SKIP_EFF === "1") {
  process.stderr.write("release-gates: efficiency-agent gate skipped (GRAPHFLOW_RELEASE_SKIP_EFF=1)\n");
} else {
  const eff = spawnSync(
    process.execPath,
    [join(root, "packages", "efficiency-agent", "scripts", "release-gate.mjs")],
    { stdio: "inherit", cwd: root, env: process.env }
  );
  effStatus = eff.status ?? 1;
}

if (governanceStatus !== 0 || effStatus !== 0) {
  process.stderr.write(
    `release-gates: governance=${governanceStatus === 0 ? "pass" : `fail(${governanceStatus})`} ` +
      `efficiency-agent=${effStatus === 0 ? "pass" : `fail(${effStatus})`}\n`
  );
}
process.exitCode = governanceStatus !== 0 ? governanceStatus : effStatus;
