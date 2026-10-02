#!/usr/bin/env node
// Secret scan for the efficiency-agent package (spec §19 security gate).
// Scans git-tracked files under packages/efficiency-agent and .github/workflows,
// reports file:line with the secret masked, and exits 1 on any finding.
//
// Usage: node packages/efficiency-agent/scripts/secret-scan.mjs [--json] [--include-untracked]

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "..", "..");
const SCAN_ROOTS = ["packages/efficiency-agent", ".github/workflows"];

const ALLOWLIST_FILES = [
  /^packages\/efficiency-agent\/security\/adversarial-v1\.jsonl$/,
  /^packages\/efficiency-agent\/tests\/security-[^/]*\.test\.ts$/,
];
const ALLOWLIST_MARKERS = /FAKE|EXAMPLE|test0000/i;

const RULES = [
  { id: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-project-key", re: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  // Covers OpenAI legacy keys and DeepSeek keys (sk- + 32 hex).
  { id: "sk-api-key", re: /\bsk-[A-Za-z0-9]{32,}\b/g },
  { id: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: "github-fine-grained-pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: "pem-private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  {
    id: "generic-api-key-assignment",
    re: /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']([A-Za-z0-9_\-+/=.]{24,})["']/gi,
  },
];

const MAX_BYTES = 2 * 1024 * 1024;

function listFiles(includeUntracked) {
  const args = ["ls-files", "-z"];
  if (includeUntracked) args.push("--cached", "--others", "--exclude-standard");
  args.push("--", ...SCAN_ROOTS);
  const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`git ls-files failed: ${(res.stderr || res.error?.message || "").trim()}`);
  }
  return [...new Set(res.stdout.split("\0").filter(Boolean))];
}

export function mask(value) {
  return `${value.slice(0, 4)}***`;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function scanText(text, file) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const secret = m[1] ?? m[0];
        if (ALLOWLIST_MARKERS.test(m[0])) continue;
        findings.push({ file, line: idx + 1, rule: rule.id, masked: mask(secret) });
      }
    }
  });
  return findings;
}

function main() {
  const json = process.argv.includes("--json");
  const includeUntracked = process.argv.includes("--include-untracked");
  let files;
  try {
    files = listFiles(includeUntracked);
  } catch (err) {
    process.stderr.write(`secret-scan: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  const findings = [];
  let scanned = 0;
  let allowlisted = 0;
  for (const rel of files) {
    if (ALLOWLIST_FILES.some((re) => re.test(rel))) {
      allowlisted++;
      continue;
    }
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const buf = readFileSync(abs);
    if (isBinary(buf)) continue;
    scanned++;
    findings.push(...scanText(buf.toString("utf8"), rel));
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ scanned, allowlisted, findings }, null, 2)}\n`);
  } else {
    for (const f of findings) process.stdout.write(`${f.file}:${f.line}  [${f.rule}]  ${f.masked}\n`);
    process.stdout.write(
      `secret-scan: ${scanned} files scanned, ${allowlisted} allowlisted, ${findings.length} finding(s)\n`,
    );
  }
  process.exitCode = findings.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
