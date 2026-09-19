#!/usr/bin/env node
/**
 * CI release-quality gate: assert the package version is consistent across
 * package.json and the latest CHANGELOG.md heading, and that READMEs are
 * version-less by design (dynamic npm badge, no hardcoded version strings)
 * so a release never requires doc edits.
 *
 * Plain Node, zero dependencies, regex-based extraction so it can run without
 * `npm install`. Exits non-zero on any mismatch.
 */
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");

function fail(message) {
  console.error(`[ci-version-check] FAIL: ${message}`);
  process.exitCode = 1;
}

function readFile(relativePath) {
  const fullPath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    fail(`missing file: ${relativePath}`);
    return null;
  }
  return fs.readFileSync(fullPath, "utf8");
}

// --- package.json version ---------------------------------------------------

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const pkgVersion = pkg.version;
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(pkgVersion))) {
  fail(`package.json "version" is not a valid semver string: ${pkgVersion}`);
}

// --- CHANGELOG.md latest heading version ------------------------------------

const changelog = readFile("CHANGELOG.md");
let changelogVersion = null;
if (changelog !== null) {
  const match = changelog.match(/^## \[(\d[^\]]*)\]/m);
  if (match) {
    changelogVersion = match[1].trim();
  } else {
    fail("no version heading of the form '## [X.Y.Z]' found in CHANGELOG.md");
  }
}

// --- README badges are dynamic, never hardcoded ------------------------------

const readme = readFile("README.md");
if (readme !== null) {
  if (!/img\.shields\.io\/npm\/v\/@roarpeng%2Fgraphflow|img\.shields\.io\/npm\/v\/@roarpeng\/graphflow/.test(readme)) {
    fail("README.md must use the dynamic npm badge (img.shields.io/npm/v/@roarpeng/graphflow)");
  }
  if (/badge\/npm-\d/.test(readme)) {
    fail("README.md still hardcodes a static npm version badge — releases must not require doc edits");
  }
  if (readme.includes(pkgVersion)) {
    fail(`README.md hardcodes the current version ${pkgVersion} — remove it so releases never touch docs`);
  }
}

// --- compare ----------------------------------------------------------------

const problems = [];
if (changelogVersion !== null && changelogVersion !== pkgVersion) {
  problems.push(
    `CHANGELOG.md latest heading is [${changelogVersion}] but package.json is ${pkgVersion}`,
  );
}

for (const problem of problems) {
  fail(problem);
}

if (process.exitCode) {
  console.error(`[ci-version-check] FAIL: package.json=${pkgVersion} CHANGELOG=${changelogVersion ?? "n/a"} (README must stay version-less)`);
} else {
  console.log(`[ci-version-check] OK: package.json / CHANGELOG.md at ${pkgVersion}; README.md is version-less (dynamic badge)`);
}
