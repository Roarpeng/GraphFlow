#!/usr/bin/env node
/**
 * Build `tests/fixtures/zh-real-corpus.json` from real open-source repositories
 * that carry Chinese comments/docstrings next to English identifiers.
 *
 * The fixture is committed so the recall test stays offline and deterministic;
 * this script is the (network-dependent) regenerator.
 *
 *   node scripts/extract-zh-corpus.mjs --repo /tmp/go-admin --repo /tmp/easytrader
 *
 * Every entry keeps the verbatim comment and the verbatim declaration line, so
 * the test reconstructs real (comment, identifier) pairs rather than inventing
 * phrasing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

const CJK = /[\u4e00-\u9fff]/;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "docs",
  "doc",
  "testdata",
  "static",
  "assets",
  "third_party",
  "examples",
]);

/** Declaration kinds we can extract: how to find the comment above a symbol. */
const KINDS = {
  go: {
    ext: ".go",
    match: (line) => /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/.exec(line),
    lineComment: (line) => /^\s*\/\/(.*)$/.exec(line),
  },
  py: {
    ext: ".py",
    docstring: true,
    match: (line) => /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line),
    lineComment: (line) => /^\s*#(.*)$/.exec(line),
  },
  ts: {
    ext: ".ts",
    match: (line) => /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/.exec(line),
    lineComment: (line) => /^\s*\/\/(.*)$/.exec(line),
  },
};

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function repoArgs() {
  const out = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--repo") out.push(resolve(process.argv[i + 1]));
  }
  return out;
}

function walk(dir, ext, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries.sort()) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, ext, acc);
    else if (name.endsWith(ext)) acc.push(full);
  }
  return acc;
}

function cleanComment(text) {
  return text
    .replace(/^\s*\/\/\s?/, "")
    .replace(/^\s*#\s?/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Python `"""中文说明"""` that opens the body of a def. */
function docstringAfter(lines, declIndex) {
  for (let i = declIndex; i < Math.min(lines.length, declIndex + 10); i += 1) {
    const line = lines[i] ?? "";
    if (i > declIndex && !line.trim()) continue;
    const at = line.indexOf('"""');
    if (at < 0) continue;
    const rest = line.slice(at + 3);
    const close = rest.indexOf('"""');
    if (close >= 0) return cleanComment(rest.slice(0, close));
    const collected = [rest];
    for (let j = i + 1; j < lines.length && collected.length < 3; j += 1) {
      const next = lines[j] ?? "";
      const end = next.indexOf('"""');
      if (end >= 0) {
        collected.push(next.slice(0, end));
        break;
      }
      collected.push(next);
    }
    return cleanComment(collected.join(" "));
  }
  return "";
}

/** JSDoc/block comment written directly above a declaration. */
function blockCommentAbove(lines, declIndex) {
  const close = lines[declIndex - 1] ?? "";
  if (!/\*\/\s*$/.test(close)) return "";
  const collected = [];
  for (let i = declIndex - 1; i >= 0 && collected.length < 6; i -= 1) {
    const raw = (lines[i] ?? "").trim();
    if (i < declIndex - 1 && /^\/\*/.test(raw)) {
      collected.unshift(raw.replace(/^\/\*\*?/, "").replace(/\*\/$/, ""));
      break;
    }
    if (i < declIndex - 1) collected.unshift(raw.replace(/^\*\s?/, ""));
    if (i === declIndex - 1 && /^\/\*\*?.*\*\/$/.test(raw)) {
      collected.unshift(raw.replace(/^\/\*\*?/, "").replace(/\*\/$/, ""));
      break;
    }
  }
  return cleanComment(collected.join(" ").replace(/\*\/$/, ""));
}

/** Comment lines written directly above `declIndex`, contiguous, no blank line. */
function commentAbove(lines, declIndex, kind) {
  const collected = [];
  for (let i = declIndex - 1; i >= 0 && collected.length < 3; i -= 1) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "") break;
    const m = kind.lineComment(raw);
    if (!m) break;
    collected.unshift(cleanComment(raw));
  }
  return collected.join(" ").trim();
}

function usableComment(text) {
  if (!CJK.test(text)) return false;
  const cjkChars = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (cjkChars < 2) return false;
  // Copyright banners, generated file markers, pure URLs, lint directives.
  if (/copyright|license|generated|golangci|go:build|nolint|@file|SPDX/i.test(text)) return false;
  if (/^https?:\/\//.test(text)) return false;
  // Swagger/JSDoc tag soup is not natural language a human would type.
  if (/^@|@Router|@Summary|@Success|@Param\b/.test(text)) return false;
  return true;
}

function camelTokens(symbol) {
  return symbol
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_$]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 3);
}

/** Keep the answer out of the question: drop comments that name the symbol. */
function leaksSymbol(text, symbol) {
  const lower = text.toLowerCase();
  if (lower.includes(symbol.toLowerCase())) return true;
  return camelTokens(symbol).some((token) => lower.includes(token));
}

function gitInfo(root) {
  const run = (args) => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const licenseFile = readdirSync(root).find((name) => /^licen[cs]e/i.test(name));
  let license = "";
  if (licenseFile) {
    const head = readFileSync(join(root, licenseFile), "utf8").split(/\r?\n/).slice(0, 5).join(" ");
    license = /Apache/i.test(head) ? "Apache-2.0" : /MIT/i.test(head) ? "MIT" : head.slice(0, 40);
  }
  return {
    name: run(["config", "--get", "remote.origin.url"]).replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "") || basename(root),
    commit: run(["rev-parse", "HEAD"]),
    license: license || "unknown",
    url: `https://github.com/${run(["config", "--get", "remote.origin.url"]).replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "")}`,
  };
}

/** Query variants a human might type, derived only from the real comment. */
function queryVariants(comment) {
  const out = [comment];
  const firstClause = comment.split(/[，,。；;：:（(]/)[0]?.trim() ?? "";
  if (firstClause && firstClause !== comment && firstClause.length >= 2) out.push(firstClause);
  return out;
}

const entries = [];
for (const root of repoArgs()) {
  const info = gitInfo(root);
  for (const [lang, kind] of Object.entries(KINDS)) {
    for (const file of walk(root, kind.ext)) {
      let content;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!CJK.test(content)) continue;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const m = kind.match(lines[i] ?? "");
        if (!m) continue;
        const symbol = m[m.length - 1];
        const indent = m.length > 2 ? m[1] : "";
        if (indent && indent.trim() !== "") continue; // nested closures only
        let comment = commentAbove(lines, i, kind);
        let style = "line";
        if (!CJK.test(comment)) {
          const block = blockCommentAbove(lines, i);
          if (CJK.test(block)) {
            comment = block;
            style = "block";
          }
        }
        if (!CJK.test(comment) && kind.docstring) {
          const doc = docstringAfter(lines, i);
          if (CJK.test(doc)) {
            comment = doc;
            style = "docstring";
          }
        }
        if (!usableComment(comment)) continue;
        if (leaksSymbol(comment, symbol)) continue;
        entries.push({
          repo: info.name,
          commit: info.commit,
          license: info.license,
          lang,
          path: relative(root, file).split(sep).join("/"),
          symbol,
          comment,
          style,
          decl: (lines[i] ?? "").trim(),
          variants: queryVariants(comment),
        });
      }
    }
  }
}

// Distinct names are what P@1 is scored against, so several declarations that
// share a name collapse into one representative entry.
const byName = new Map();
for (const entry of entries) {
  if (!byName.has(entry.symbol)) byName.set(entry.symbol, []);
  byName.get(entry.symbol).push(entry);
}

// A comment that annotates two different symbols cannot be scored: drop it.
const namesByComment = new Map();
for (const entry of entries) {
  const set = namesByComment.get(entry.comment) ?? new Set();
  set.add(entry.symbol);
  namesByComment.set(entry.comment, set);
}

const unique = [];
for (const [name, group] of byName) {
  const entry = group[0];
  if ((namesByComment.get(entry.comment) ?? new Set()).size !== 1) continue;
  unique.push({ ...entry, sameNameCount: group.length });
}

// Deterministic stride sample, then stable sort by symbol for reviewable diffs.
const limit = Number(arg("--limit", "160"));
const stride = Math.max(1, Math.floor(unique.length / limit));
const sampled = unique.filter((_, i) => i % stride === 0).slice(0, limit);
sampled.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

const repoIndex = new Map();
for (const root of repoArgs()) {
  const info = gitInfo(root);
  repoIndex.set(info.name, info);
}

const payload = {
  note: "Verbatim (comment, declaration) pairs extracted from real MIT-licensed repositories. Comment text is unmodified; only the surrounding code is omitted.",
  generatedBy: "scripts/extract-zh-corpus.mjs",
  repos: [...repoIndex.values()],
  stats: { candidates: entries.length, unique: unique.length, sampled: sampled.length },
  pairs: sampled,
};

const outPath = arg("--out", resolve("tests/fixtures/zh-real-corpus.json"));
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(
  `[zh-corpus] candidates=${entries.length} unique=${unique.length} sampled=${sampled.length} -> ${outPath}`
);
for (const [name, info] of repoIndex) {
  console.log(`[zh-corpus] ${name} @ ${info.commit.slice(0, 8)} (${info.license})`);
}
if (!existsSync(outPath)) process.exitCode = 1;
