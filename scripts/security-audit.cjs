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

// npm audit exits 1 for *any* finding and can exit non-zero for reasons that are
// not findings at all — a registry that does not implement the audit endpoint
// (npm mirrors commonly 404 it), for instance. This script was observed exiting 1
// with completely empty stdout, and a CI log that says only "exit code 1" forces
// the reader into the artifact to learn anything. Report the reason here.
if (result.status !== 0) {
  const report = (() => {
    try {
      return JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
  })();
  const counts = report?.metadata?.vulnerabilities;
  if (counts && (counts.total ?? 0) > 0) {
    const found = Object.entries(report.vulnerabilities ?? {}).map(
      ([name, v]) => `${name}@${v.severity}`
    );
    process.stderr.write(
      `security-audit: ${counts.total} vulnerabilities (${counts.critical ?? 0} critical, ` +
        `${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low): ${found.join(", ")}\n`
    );
  } else if (report?.message) {
    // Not a finding: the registry could not answer.
    process.stderr.write(`security-audit: npm audit did not run: ${report.message}\n`);
  } else if (result.stderr?.trim()) {
    process.stderr.write(`security-audit: ${result.stderr.trim().split("\n").slice(-3).join("\n")}\n`);
  } else {
    process.stderr.write("security-audit: npm audit failed with no output\n");
  }
}
process.exitCode = result.status ?? 1;
