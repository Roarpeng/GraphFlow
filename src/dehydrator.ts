/**
 * GraphFlow 3.0 — Pillar 3: Deterministic Tool Execution, Stdout Dehydrator &
 * Multi-Language Diff-to-Test Impact Router (`dehydrator.ts`)
 */

import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveRelativeImportPath } from "./ast-engine.js";
import { formatNumberedLines, getWorkspaceAstIndex } from "./slicer.js";

const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

const SALIENT_ERROR_LINE_RE =
  /\b(FAIL|FAILED|Error|TypeError|SyntaxError|ReferenceError|AssertionError|ERR_|Exception|Traceback|panic:|error\[E\d+\]|CS\d{4}:|expected|received|actual)\b|^\s*[✕×✗●]|^\s*[-+]{1,3}\s|\(\d+,\d+\):\s*error\s+TS\d+/i;

const WORKSPACE_FILE_LINE_RE =
  /(?:^|[\s("'])((?:src|tests|packages|scripts|dsh|opencode|web|include|cmd|pkg|internal|crates)\/[a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|c|h|cc|cpp|hpp|cxx|cs)):(\d+)(?::(\d+))?/;

const PYTHON_TRACEBACK_FILE_LINE_RE =
  /File\s+"([^"]+\.py)",\s+line\s+(\d+)/;

const FAST_IMPORT_SPEC_RE =
  /(?:from|import|require\(|#\s*include\s+|use\s+)\s*["'<]?([a-zA-Z0-9_./:-]+)[">']?/g;

/** Dynamic `import("./x")` / `require("./x")` with a quoted literal. */
const DYNAMIC_IMPORT_SPEC_RE = /\b(?:import|require)\s*\(\s*["'`]([^"'`\r\n]+)["'`]\s*\)/g;

/**
 * Quoted static specifiers (`from "@/alias"`, side-effect `import "..."`).
 * Kept separate from FAST_IMPORT_SPEC_RE so aliases (`@/`, `~/`, `#/`) and
 * scoped packages are captured by their quotes instead of the identifier charset.
 */
const QUOTED_IMPORT_SPEC_RE = /\b(?:from|import)\s*["'`]([^"'`\r\n]+)["'`]/g;

/** Go `import ( "pkg/a" ... )` blocks; quoted literals are extracted separately. */
const GO_IMPORT_BLOCK_RE = /\bimport\s*\(([\s\S]*?)\)/g;

const QUOTED_LITERAL_RE = /["'`]([^"'`\r\n]+)["'`]/g;

/** C# `using Foo.Bar;` / `using static Foo.Bar;` namespace imports. */
const CSHARP_USING_RE =
  /\busing\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*;/g;

const JS_FAMILY_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

const IMPORT_RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] as const;

/** Source extensions the workspace AST index does not scan; found by a local walk. */
const EXTRA_ROUTING_EXTS = new Set([".mts", ".cts"]);

interface FailureSourceLocation {
  file: string;
  line: number;
}

/** Stack frames that live outside the workspace are never useful as failure source. */
function isIgnoredStackLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    (trimmed.startsWith("at ") && trimmed.includes("node_modules/")) ||
    trimmed.includes("/site-packages/") ||
    trimmed.includes("/rustc/")
  );
}

/**
 * Parse a workspace-relative `path:line` location or a Python
 * `File "...", line N` traceback frame. Returns undefined when the line carries
 * no resolvable workspace location.
 */
const STACK_EXT = "ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|c|h|cc|cpp|hpp|cxx|cs";
/** Any absolute path (`C:/…`, `/…`, `file:///…`) ending in `:line[:col]`. */
const ABSOLUTE_FILE_LINE_RE = new RegExp(
  `((?:[A-Za-z]:)?/[^\\s:()"']+\\.(?:${STACK_EXT})):(\\d+)(?::(\\d+))?`
);
/** Any workspace-relative path with at least one directory separator. */
const RELATIVE_FILE_LINE_RE = new RegExp(
  `((?:[\\w.@+-]+/)+[\\w.@+-]+\\.(?:${STACK_EXT})):(\\d+)(?::(\\d+))?`
);

/**
 * Normalizes a stack-frame path into a workspace-relative one. Windows traces
 * arrive as `C:\repo\src\x.ts` or `file:///C:/repo/src/x.ts`, which the
 * workspace-relative matcher cannot see; without this the failure source window
 * silently attaches nothing.
 */
function toWorkspaceRelative(candidate: string, rootDir: string): string {
  let file = candidate.replace(/^file:\/\//, "").replace(/\\/g, "/");
  try {
    file = decodeURIComponent(file);
  } catch {
    // keep the raw form when the path is not percent-encoded
  }
  const root = rootDir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    file = file.slice(root.length + 1);
  }
  return file.replace(/^\.\//, "").replace(/^\/+/, "");
}

function parseFailureSourceLocation(
  line: string,
  rootDir?: string
): FailureSourceLocation | undefined {
  const normalized = line.replace(/\\/g, "/").replace(/file:\/\//g, "");
  const locMatch =
    normalized.match(WORKSPACE_FILE_LINE_RE) ??
    line.match(PYTHON_TRACEBACK_FILE_LINE_RE) ??
    normalized.match(ABSOLUTE_FILE_LINE_RE) ??
    normalized.match(RELATIVE_FILE_LINE_RE);
  if (!locMatch) return undefined;
  const raw = locMatch[1]!.replace(/^\.\//, "");
  const file = rootDir ? toWorkspaceRelative(raw, rootDir) : raw;
  const lineNumber = Number.parseInt(locMatch[2]!, 10);
  if (!Number.isFinite(lineNumber) || lineNumber <= 0) return undefined;
  return { file, line: lineNumber };
}

export interface DehydratedExecResult {
  ok: boolean;
  exitCode: number;
  durationMs: number;
  command: string;
  rawBytes: number;
  rawEstimatedTokens: number;
  dehydratedTokens: number;
  handle?: string;
  text: string;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "").replace(/\r\n/g, "\n");
}

function archiveRawOutput(rootDir: string, rawText: string): string | undefined {
  if (rawText.length < 400) return undefined;
  try {
    const sha = createHash("sha256").update(rawText, "utf8").digest("hex").slice(0, 12);
    const dir = join(rootDir, ".graphflow", "observations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sha}.log`), rawText, "utf8");
    return `gfo:${sha}`;
  } catch {
    return undefined;
  }
}

export function recallArchivedOutput(
  rootDir: string,
  handle: string,
  startLine = 1,
  endLine = 120
): string {
  const sha = handle.replace(/^gfo:/, "").replace(/[^a-f0-9]/gi, "");
  const filePath = join(rootDir, ".graphflow", "observations", `${sha}.log`);
  if (!existsSync(filePath)) {
    return `ERR [handle-not-found] ${handle}`;
  }
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  return (
    `# Observation ${handle} (lines ${startLine}-${Math.min(lines.length, endLine)} of ${lines.length})\n` +
    formatNumberedLines(lines, startLine, endLine)
  );
}

export function dehydrateCommandOutput(params: {
  rootDir: string;
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}): DehydratedExecResult {
  const combinedRaw = stripAnsi(
    [params.stdout.trim(), params.stderr.trim()].filter(Boolean).join("\n")
  );
  const rawBytes = Buffer.byteLength(combinedRaw, "utf8");
  const rawEstimatedTokens = Math.max(1, Math.ceil(combinedRaw.length / 4));
  const handle = archiveRawOutput(params.rootDir, combinedRaw);

  if (params.exitCode === 0) {
    // A short passing output is already cheap. Collapsing it to a status line
    // costs correctness: a runner that prints its own `PASS ...` line makes the
    // summary regex drop the actual result (the local-task runner did exactly
    // that). Keep the raw text when there is nothing meaningful to save.
    if (combinedRaw.length > 0 && combinedRaw.length <= 240) {
      const shortText = `PASS [exit=0, ${params.durationMs}ms]\n${combinedRaw}`;
      return {
        ok: true,
        exitCode: 0,
        durationMs: params.durationMs,
        command: params.command,
        rawBytes,
        rawEstimatedTokens,
        dehydratedTokens: Math.max(1, Math.ceil(shortText.length / 4)),
        text: shortText,
      };
    }
    const lines = combinedRaw.split("\n").filter((l) => l.trim().length > 0);
    const summaryHits = lines.filter((l) =>
      /\b(Tests\s+\d+\s+passed|\d+\s+passing|\d+\s+passed|test result:\s*ok|PASS|built in|Successfully compiled|ok\s+\d+)\b/i.test(l)
    );
    const tailSummary =
      summaryHits.length > 0
        ? summaryHits.slice(-2).map((s) => s.trim()).join(" | ")
        : lines.length <= 3
          ? lines.join(" | ")
          : `${lines.length} lines (${lines[lines.length - 1]?.trim().slice(0, 100) ?? "done"})`;

    const handleNote = handle ? ` [raw ${rawBytes}B -> ${handle}]` : "";
    const text = `PASS [exit=0, ${params.durationMs}ms] ${tailSummary}${handleNote}`;
    return {
      ok: true,
      exitCode: 0,
      durationMs: params.durationMs,
      command: params.command,
      rawBytes,
      rawEstimatedTokens,
      dehydratedTokens: Math.max(1, Math.ceil(text.length / 4)),
      ...(handle ? { handle } : {}),
      text,
    };
  }

  const allLines = combinedRaw.split("\n");
  const salientLines: string[] = [];
  const referencedLocations: Array<{ file: string; line: number }> = [];
  const seenLocations = new Set<string>();

  const recordLocation = (location: FailureSourceLocation): void => {
    const key = `${location.file}:${location.line}`;
    if (!seenLocations.has(key) && referencedLocations.length < 3) {
      seenLocations.add(key);
      referencedLocations.push(location);
    }
  };

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (isIgnoredStackLine(line)) {
      continue;
    }

    const location = parseFailureSourceLocation(line, params.rootDir);
    if (location) {
      recordLocation(location);
      salientLines.push(line);
      continue;
    }

    if (SALIENT_ERROR_LINE_RE.test(line)) {
      salientLines.push(line);
      // The next line is usually the stack frame that carries the failure
      // location. Consume it, but still parse it for source context (the old
      // code skipped it, so `Error:` + `at run (tests/fail.js:3:9)` attached
      // nothing).
      const nextLine = allLines[i + 1];
      if (nextLine !== undefined && nextLine.trim() && !isIgnoredStackLine(nextLine)) {
        salientLines.push(nextLine);
        const nextLocation = parseFailureSourceLocation(nextLine, params.rootDir);
        if (nextLocation) recordLocation(nextLocation);
        i += 1;
      }
    }
  }

  const keptErrorLines =
    salientLines.length > 0
      ? salientLines.slice(0, 35)
      : [
          ...allLines.slice(0, 8),
          ...(allLines.length > 20 ? ["..."] : []),
          ...allLines.slice(-12),
        ];

  const outSections: string[] = [
    `FAIL [exit=${params.exitCode}, ${params.durationMs}ms] cmd: ${params.command}${handle ? ` (full log: ${handle})` : ""}`,
    keptErrorLines.join("\n"),
  ];

  if (referencedLocations.length > 0) {
    const snipBlocks: string[] = ["# Auto-Attached Failure Source Context:"];
    for (const loc of referencedLocations) {
      const abs = isAbsolute(loc.file) ? loc.file : join(params.rootDir, loc.file);
      if (existsSync(abs)) {
        try {
          const srcLines = readFileSync(abs, "utf8").split(/\r?\n/);
          snipBlocks.push(
            `// ${loc.file}:${loc.line}\n` +
              formatNumberedLines(srcLines, Math.max(1, loc.line - 2), Math.min(srcLines.length, loc.line + 2))
          );
        } catch {
          // ignore
        }
      }
    }
    if (snipBlocks.length > 1) {
      outSections.push(snipBlocks.join("\n"));
    }
  }

  const text = outSections.join("\n\n").trim();
  return {
    ok: false,
    exitCode: params.exitCode,
    durationMs: params.durationMs,
    command: params.command,
    rawBytes,
    rawEstimatedTokens,
    dehydratedTokens: Math.max(1, Math.ceil(text.length / 4)),
    ...(handle ? { handle } : {}),
    text,
  };
}

/**
 * Test-directory conventions honored in addition to filename conventions.
 * `test/` (singular) is as common as `tests/` — got and express both use it, and
 * omitting it made the router report "0 test files affected" for real changes.
 */
const TEST_DIR_RE = /(?:^|\/)(?:test|tests|__tests__|spec)\//;

function isTestFilePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  const base = basename(normalized);
  const ext = base.slice(base.lastIndexOf(".")).toLowerCase();
  // Support files inside a test tree are not tests: passing `conftest.py` or
  // `__init__.py` to pytest is a collection error, not a targeted run.
  if (base === "conftest.py" || base === "__init__.py") return false;
  // Python and Go have strict naming conventions; honouring them keeps helpers
  // (`utils.py`, `compat.py`) out of the affected-test list even under `tests/`.
  if (ext === ".py") return /^test_.*\.py$/.test(base) || /_test\.py$/.test(base);
  if (ext === ".go") return /_test\.go$/.test(base);
  if (ext === ".cs") return /Tests?\.cs$/.test(base);
  return (
    TEST_DIR_RE.test(normalized) ||
    normalized.includes(".test.") ||
    normalized.includes(".spec.") ||
    /_test\.(?:py|go|rs|c|cpp|cc|mts|cts)$/.test(base) ||
    /Tests?\.cs$/.test(base)
  );
}

function stemsForPath(relPath: string): string[] {
  const base = basename(relPath)
    .replace(
      /(?:\.(?:test|spec))?\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|c|h|cc|cpp|hpp|cxx|cs)$/,
      ""
    )
    .replace(/^test_/, "")
    .replace(/_test$/, "")
    .replace(/Tests?$/, "");
  if (base === "index" || base === "__init__" || base === "mod") {
    const parent = basename(dirname(relPath));
    return parent && parent !== "." ? [base, parent] : [base];
  }
  return [base];
}

/**
 * Extract import specifiers from source text: static `import`/`from`,
 * side-effect `import "..."`, `require(...)`, dynamic `import(...)`, Go import
 * blocks, Rust `use ...`, C/C++ `#include`, Python `from .x`, and C# `using`.
 */
function extractImportSpecs(content: string): string[] {
  const specs = new Set<string>();
  const addSpec = (spec: string | undefined): void => {
    const trimmed = spec?.trim();
    if (trimmed && trimmed.length > 0) specs.add(trimmed);
  };
  for (const m of content.matchAll(FAST_IMPORT_SPEC_RE)) addSpec(m[1]);
  for (const m of content.matchAll(QUOTED_IMPORT_SPEC_RE)) addSpec(m[1]);
  for (const m of content.matchAll(DYNAMIC_IMPORT_SPEC_RE)) addSpec(m[1]);
  for (const m of content.matchAll(GO_IMPORT_BLOCK_RE)) {
    const block = m[1] ?? "";
    for (const quoted of block.matchAll(QUOTED_LITERAL_RE)) addSpec(quoted[1]);
  }
  for (const m of content.matchAll(CSHARP_USING_RE)) addSpec(m[1]);
  return Array.from(specs);
}

function normalizeRoutingPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized === "." ? "" : normalized;
}

function isJsFamilyPath(relPath: string): boolean {
  return JS_FAMILY_EXTS.has(extname(relPath).toLowerCase());
}

interface TsPathAliasPattern {
  prefix: string;
  suffix: string;
  wildcard: boolean;
  /** Workspace-relative target paths (may contain `*`). */
  targets: string[];
}

interface EffectiveTsPathAliasConfig {
  /** Workspace-relative directory used for bare `baseUrl` resolution, if any. */
  baseUrl: string | undefined;
  patterns: TsPathAliasPattern[];
  hasPaths: boolean;
}

interface RawTsConfig {
  compilerOptions?: unknown;
  extends?: unknown;
  references?: unknown;
}

const rawTsConfigByPath = new Map<string, RawTsConfig | null>();
const effectiveTsConfigByKey = new Map<string, EffectiveTsPathAliasConfig | null>();
const nearestConfigByDir = new Map<string, string | null>();
const referencedConfigsByRoot = new Map<string, string[]>();

/** Strip `//` / block comments and trailing commas so tsconfig JSONC can be parsed. */
function stripJsonComments(text: string): string {
  const source = text.replace(/^\uFEFF/, "");
  let out = "";
  let i = 0;
  let inString = false;
  let quote = '"';
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function isWithinRoot(rootAbs: string, absolutePath: string): boolean {
  const rel = relative(rootAbs, absolutePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Convert an absolute path to a workspace-relative one; undefined when outside the workspace. */
function toWorkspaceRelPath(rootAbs: string, absolutePath: string): string | undefined {
  if (!isWithinRoot(rootAbs, absolutePath)) return undefined;
  return normalizeRoutingPath(relative(rootAbs, absolutePath).replace(/\\/g, "/"));
}

/** Read and cache a tsconfig/jsconfig file as raw JSONC (no extends merge). */
function readRawTsConfig(configPath: string): RawTsConfig | null {
  const configAbs = resolve(configPath);
  const cached = rawTsConfigByPath.get(configAbs);
  if (cached !== undefined) return cached;
  let parsed: RawTsConfig | null = null;
  try {
    if (existsSync(configAbs)) {
      const value = JSON.parse(stripJsonComments(readFileSync(configAbs, "utf8"))) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as RawTsConfig;
    }
  } catch {
    parsed = null;
  }
  rawTsConfigByPath.set(configAbs, parsed);
  return parsed;
}

function findConfigInDir(absDir: string): string | null {
  for (const fileName of ["tsconfig.json", "jsconfig.json"]) {
    const candidate = join(absDir, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Nearest tsconfig/jsconfig walking upward from the importing file's directory
 * to the workspace root (the root config is the last candidate). Cached per dir.
 */
function findNearestConfig(rootDir: string, fromRelPath: string): string | null {
  const rootAbs = resolve(rootDir);
  let dir = resolve(rootAbs, dirname(fromRelPath));
  if (!isWithinRoot(rootAbs, dir)) dir = rootAbs;
  while (true) {
    const cached = nearestConfigByDir.get(dir);
    if (cached !== undefined) {
      // A cached `null` only means "no config in this directory"; keep walking
      // upward, otherwise the first lookup would poison later ones.
      if (cached) return cached;
    } else {
      const found = findConfigInDir(dir);
      nearestConfigByDir.set(dir, found);
      if (found) return found;
    }
    if (dir === rootAbs) return null;
    const parent = dirname(dir);
    if (parent === dir || !isWithinRoot(rootAbs, parent)) return null;
    dir = parent;
  }
}

/** Discover `<root>/tsconfig.json` `references[].path` project configs (best effort, cached). */
function getReferencedConfigPaths(rootDir: string): string[] {
  const rootAbs = resolve(rootDir);
  const cached = referencedConfigsByRoot.get(rootAbs);
  if (cached) return cached;

  const results: string[] = [];
  const raw = readRawTsConfig(join(rootAbs, "tsconfig.json"));
  if (raw && Array.isArray(raw.references)) {
    for (const reference of raw.references) {
      if (!reference || typeof reference !== "object") continue;
      const refPath = (reference as { path?: unknown }).path;
      if (typeof refPath !== "string" || refPath.trim().length === 0) continue;
      const target = isAbsolute(refPath) ? resolve(refPath) : resolve(rootAbs, refPath);
      const candidates = [
        target,
        `${target}.json`,
        join(target, "tsconfig.json"),
        join(target, "jsconfig.json"),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate) && readRawTsConfig(candidate)) {
          results.push(candidate);
          break;
        }
      }
    }
  }
  referencedConfigsByRoot.set(rootAbs, results);
  return results;
}

function normalizeExtendsList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Resolve one `extends` entry: relative paths (with optional `.json`) and
 * node_modules package specifiers (`package.json` `tsconfig` field, then
 * `<pkg>/tsconfig.json`), walking node_modules up to the workspace root.
 */
function resolveExtendsValue(
  spec: string,
  fromConfigPath: string,
  rootAbs: string
): string | null {
  const tryCandidates = (candidates: string[]): string | null => {
    for (const candidate of candidates) {
      if (existsSync(candidate) && readRawTsConfig(candidate)) return candidate;
    }
    return null;
  };

  if (spec.startsWith(".") || isAbsolute(spec)) {
    const base = isAbsolute(spec) ? resolve(spec) : resolve(dirname(fromConfigPath), spec);
    return tryCandidates([
      base,
      `${base}.json`,
      join(base, "tsconfig.json"),
      join(base, "jsconfig.json"),
    ]);
  }

  const isScoped = spec.startsWith("@");
  const parts = spec.split("/");
  const subPath = parts.slice(isScoped ? 2 : 1).join("/");
  let dir = dirname(fromConfigPath);
  while (true) {
    const nodeModules = join(dir, "node_modules");
    if (existsSync(nodeModules)) {
      const direct = join(nodeModules, spec);
      if (subPath) {
        const hit = tryCandidates([
          direct,
          `${direct}.json`,
          join(direct, "tsconfig.json"),
          join(direct, "jsconfig.json"),
        ]);
        if (hit) return hit;
      } else {
        const candidates: string[] = [];
        const packageJsonPath = join(direct, "package.json");
        if (existsSync(packageJsonPath)) {
          try {
            const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { tsconfig?: unknown };
            if (typeof pkg.tsconfig === "string" && pkg.tsconfig.trim()) {
              candidates.push(
                isAbsolute(pkg.tsconfig) ? pkg.tsconfig : join(direct, pkg.tsconfig)
              );
            }
          } catch {
            // Malformed package.json: fall through to tsconfig.json.
          }
        }
        candidates.push(join(direct, "tsconfig.json"), join(direct, "jsconfig.json"));
        const hit = tryCandidates(candidates);
        if (hit) return hit;
      }
    }
    if (dir === rootAbs) break;
    const parent = dirname(dir);
    if (parent === dir || !isWithinRoot(rootAbs, parent)) break;
    dir = parent;
  }
  return null;
}

/** Build alias patterns whose targets are already resolved to workspace-relative paths. */
function buildTsPathAliasPatterns(
  paths: Record<string, unknown>,
  rootAbs: string,
  resolutionBaseAbs: string
): TsPathAliasPattern[] {
  const patterns: TsPathAliasPattern[] = [];
  for (const [patternText, targetValue] of Object.entries(paths)) {
    if (!Array.isArray(targetValue)) continue;
    const targets: string[] = [];
    for (const value of targetValue) {
      if (typeof value !== "string" || value.trim().length === 0) continue;
      const trimmed = value.trim();
      const targetAbs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(resolutionBaseAbs, trimmed);
      const relTarget = toWorkspaceRelPath(rootAbs, targetAbs);
      if (relTarget !== undefined) targets.push(relTarget);
    }
    if (targets.length === 0) continue;
    const star = patternText.indexOf("*");
    patterns.push(
      star >= 0
        ? {
            wildcard: true,
            prefix: patternText.slice(0, star),
            suffix: patternText.slice(star + 1),
            targets,
          }
        : { wildcard: false, prefix: patternText, suffix: "", targets }
    );
  }
  // Longest prefix first so the most specific alias wins.
  patterns.sort((a, b) => b.prefix.length - a.prefix.length);
  return patterns;
}

/**
 * Load a config's effective `baseUrl`/`paths`, merging its `extends` chain
 * (child overrides parent, later array entries override earlier ones, cycles
 * are cut). Cached per root + resolved config path.
 */
function loadEffectiveTsConfig(
  rootDir: string,
  configPath: string,
  chain: ReadonlySet<string> = new Set<string>()
): EffectiveTsPathAliasConfig | null {
  const rootAbs = resolve(rootDir);
  const configAbs = resolve(configPath);
  const cacheKey = `${rootAbs}::${configAbs}`;
  const cached = effectiveTsConfigByKey.get(cacheKey);
  if (cached !== undefined) return cached;
  if (chain.has(configAbs)) return null;

  const raw = readRawTsConfig(configAbs);
  if (!raw) {
    effectiveTsConfigByKey.set(cacheKey, null);
    return null;
  }

  const nextChain = new Set(chain);
  nextChain.add(configAbs);

  let baseUrl: string | undefined;
  let patterns: TsPathAliasPattern[] = [];
  let hasPaths = false;

  for (const spec of normalizeExtendsList(raw.extends)) {
    const parentPath = resolveExtendsValue(spec, configAbs, rootAbs);
    if (!parentPath) continue;
    const parent = loadEffectiveTsConfig(rootAbs, parentPath, nextChain);
    if (!parent) continue;
    if (parent.baseUrl !== undefined) baseUrl = parent.baseUrl;
    if (parent.hasPaths) {
      patterns = parent.patterns;
      hasPaths = true;
    }
  }

  const compilerOptions = raw.compilerOptions;
  const opts =
    compilerOptions && typeof compilerOptions === "object" && !Array.isArray(compilerOptions)
      ? (compilerOptions as { baseUrl?: unknown; paths?: unknown })
      : {};
  const configDirAbs = dirname(configAbs);

  let explicitBaseAbs: string | undefined;
  if (typeof opts.baseUrl === "string") {
    explicitBaseAbs = isAbsolute(opts.baseUrl)
      ? resolve(opts.baseUrl)
      : resolve(configDirAbs, opts.baseUrl);
    baseUrl = toWorkspaceRelPath(rootAbs, explicitBaseAbs);
  }
  if (opts.paths && typeof opts.paths === "object" && !Array.isArray(opts.paths)) {
    const resolutionBaseAbs =
      explicitBaseAbs ?? (baseUrl !== undefined ? resolve(rootAbs, baseUrl) : configDirAbs);
    patterns = buildTsPathAliasPatterns(
      opts.paths as Record<string, unknown>,
      rootAbs,
      resolutionBaseAbs
    );
    hasPaths = true;
  }

  const effective: EffectiveTsPathAliasConfig = { baseUrl, patterns, hasPaths };
  effectiveTsConfigByKey.set(cacheKey, effective);
  return effective;
}

/** Try a workspace-relative candidate path with the usual source extension/index fallbacks. */
function resolveImportCandidate(
  relCandidate: string,
  knownFiles: ReadonlySet<string>
): string | undefined {
  const normalized = normalizeRoutingPath(relCandidate);
  if (!normalized || normalized.startsWith("../")) return undefined;

  const ext = extname(normalized).toLowerCase();
  const candidates: string[] = [normalized];
  if ((IMPORT_RESOLVE_EXTS as readonly string[]).includes(ext)) {
    // `import "./x.js"` in a TS project also resolves to `./x.ts`.
    const stripped = normalized.slice(0, -ext.length);
    for (const candidateExt of IMPORT_RESOLVE_EXTS) candidates.push(`${stripped}${candidateExt}`);
  } else {
    for (const candidateExt of IMPORT_RESOLVE_EXTS) candidates.push(`${normalized}${candidateExt}`);
    for (const candidateExt of IMPORT_RESOLVE_EXTS) {
      candidates.push(`${normalized}/index${candidateExt}`);
    }
  }

  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return undefined;
}

/** Match one effective config's `paths`/`baseUrl` against a specifier. */
function matchTsPathAliasImport(
  config: EffectiveTsPathAliasConfig,
  moduleSpec: string,
  knownFiles: ReadonlySet<string>
): string | undefined {
  for (const pattern of config.patterns) {
    let captured: string | undefined;
    if (pattern.wildcard) {
      if (
        moduleSpec.length >= pattern.prefix.length + pattern.suffix.length &&
        moduleSpec.startsWith(pattern.prefix) &&
        moduleSpec.endsWith(pattern.suffix)
      ) {
        captured = moduleSpec.slice(pattern.prefix.length, moduleSpec.length - pattern.suffix.length);
      }
    } else if (moduleSpec === pattern.prefix) {
      captured = "";
    }
    if (captured === undefined) continue;

    for (const target of pattern.targets) {
      const substituted = target.includes("*") ? target.split("*").join(captured) : target;
      const resolvedFile = resolveImportCandidate(substituted, knownFiles);
      if (resolvedFile) return resolvedFile;
    }
  }

  if (config.baseUrl !== undefined) {
    // TypeScript's `baseUrl` alone resolves bare specifiers as root-relative paths.
    const candidate = config.baseUrl ? `${config.baseUrl}/${moduleSpec}` : moduleSpec;
    return resolveImportCandidate(candidate, knownFiles);
  }
  return undefined;
}

/**
 * Resolve a tsconfig/jsconfig `paths` alias (or bare `baseUrl`) to a known
 * workspace file. Uses the nearest config upward from the importing file, then
 * project-reference configs discovered from the workspace root config.
 */
function resolveTsPathAliasImport(
  rootDir: string,
  fromRelPath: string,
  moduleSpec: string,
  knownFiles: ReadonlySet<string>
): string | undefined {
  const configPaths: string[] = [];
  const nearest = findNearestConfig(rootDir, fromRelPath);
  if (nearest) configPaths.push(nearest);
  for (const referenced of getReferencedConfigPaths(rootDir)) configPaths.push(referenced);

  const visited = new Set<string>();
  for (const configPath of configPaths) {
    const configAbs = resolve(configPath);
    if (visited.has(configAbs)) continue;
    visited.add(configAbs);
    const effective = loadEffectiveTsConfig(rootDir, configAbs);
    if (!effective) continue;
    const resolved = matchTsPathAliasImport(effective, moduleSpec, knownFiles);
    if (resolved) return resolved;
  }
  return undefined;
}

/** Resolve a `.`-relative specifier with the wider extension/index fallback set. */
function resolveRelativeImportCandidate(
  fromRelPath: string,
  moduleSpec: string,
  knownFiles: ReadonlySet<string>
): string | undefined {
  if (!moduleSpec.startsWith(".")) return undefined;
  const fromDir = dirname(fromRelPath);
  const joined = fromDir === "." ? moduleSpec : `${fromDir}/${moduleSpec}`;
  return resolveImportCandidate(joined, knownFiles);
}

function resolveImportSpecifier(
  rootDir: string,
  fromRelPath: string,
  moduleSpec: string,
  knownFiles: ReadonlySet<string>
): string | undefined {
  const resolved = resolveRelativeImportPath(rootDir, fromRelPath, moduleSpec, knownFiles);
  if (resolved) return resolved;
  if (!isJsFamilyPath(fromRelPath)) return undefined;
  // The shared resolver predates `.mts`/`.cts`/`index.*` fallbacks; fill the gap locally.
  const relativeFallback = resolveRelativeImportCandidate(fromRelPath, moduleSpec, knownFiles);
  if (relativeFallback) return relativeFallback;
  return resolveTsPathAliasImport(rootDir, fromRelPath, moduleSpec, knownFiles);
}

const ROUTING_IGNORED_DIRS = new Set([
  "vendor", "third_party", ".turbo", ".nuxt", ".svelte-kit", ".cache", "cmake-build-debug",
  "node_modules", ".git", "dist", "build", "coverage", ".graphflow", ".graphflow-cache",
  "graphflow-out", "wasm", ".next", "out", "__pycache__", ".venv", "venv", "target", "bin", "obj",
]);

const ROUTING_EXTRA_MAX_FILES = 5_000;
const ROUTING_EXTRA_MAX_DEPTH = 8;
const ROUTING_FILES_CACHE_TTL_MS = 5_000;

interface RoutingFilesCacheEntry {
  at: number;
  files: string[];
  fileSet: ReadonlySet<string>;
}

const routingFilesByRoot = new Map<string, RoutingFilesCacheEntry>();

/** Locate source files the shared AST index skips (currently `.mts`/`.cts`). */
function collectExtraRoutingFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > ROUTING_EXTRA_MAX_DEPTH || out.length >= ROUTING_EXTRA_MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= ROUTING_EXTRA_MAX_FILES) break;
      if (entry.name.startsWith(".") && entry.name !== ".trae") continue;
      if (ROUTING_IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && EXTRA_ROUTING_EXTS.has(extname(entry.name).toLowerCase())) {
        out.push(relative(rootDir, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(rootDir, 0);
  return out;
}

/** AST-index files plus locally-discovered extra source files, cached briefly per root. */
function getRoutingFiles(
  rootDir: string,
  indexedFiles: string[]
): { files: string[]; fileSet: ReadonlySet<string> } {
  const cacheKey = resolve(rootDir);
  const now = Date.now();
  const cached = routingFilesByRoot.get(cacheKey);
  if (cached && now - cached.at < ROUTING_FILES_CACHE_TTL_MS) {
    return { files: cached.files, fileSet: cached.fileSet };
  }
  const merged = new Set(indexedFiles);
  for (const extra of collectExtraRoutingFiles(rootDir)) merged.add(extra);
  const files = Array.from(merged).sort();
  const fileSet: ReadonlySet<string> = new Set(files);
  routingFilesByRoot.set(cacheKey, { at: now, files, fileSet });
  return { files, fileSet };
}

/**
 * Parses `git status --porcelain -z` output.
 *
 * `-z` is required, not cosmetic: without it git honours `core.quotepath` and
 * emits any path outside ASCII as a double-quoted string with octal escapes
 * (`?? "\344\270\255\346\226\207.ts"`), so the changed file never matches the
 * workspace index and its tests are reported as unaffected. With `-z` paths are
 * raw and NUL-terminated, and a rename/copy entry contributes its original path
 * as an extra token that belongs to the previous entry.
 */
function parsePorcelainZ(raw: string): string[] {
  const tokens = raw.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i] ?? "";
    if (entry.length < 4) continue; // trailing empty token, or a truncated line
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if ((status.includes("R") || status.includes("C")) && i + 1 < tokens.length) {
      i += 1; // keep only the post-rename path; skip the original one
    }
  }
  return paths;
}

/**
 * Ultra-fast Multi-Language Diff-to-Test Impact Router (<15ms across 400+ files):
 * Supports TypeScript/JS, Python, Go, Rust, C/C++, and C# test conventions.
 */
export function resolveAffectedTests(rootDir: string, explicitChangedFiles?: string[]): {
  changedFiles: string[];
  affectedTests: string[];
} {
  let changed = explicitChangedFiles ?? [];
  if (changed.length === 0) {
    try {
      const raw = execSync("git status --porcelain -z", {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 16 * 1024 * 1024,
        timeout: 5_000,
      });
      changed = parsePorcelainZ(raw).filter((f) =>
        /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|c|h|cc|cpp|hpp|cxx|cs)$/.test(f)
      );
    } catch {
      changed = [];
    }
  }

  const normalizedChanged = changed.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""));
  if (normalizedChanged.length === 0) {
    return { changedFiles: [], affectedTests: [] };
  }

  const index = getWorkspaceAstIndex(rootDir);
  const { files: allFiles, fileSet } = getRoutingFiles(rootDir, index.getFiles());
  const affectedTests = new Set<string>();

  for (const f of normalizedChanged) {
    if (isTestFilePath(f)) {
      if (existsSync(join(rootDir, f))) affectedTests.add(f);
    }
  }

  const taintedSourceFiles = new Set<string>(normalizedChanged);
  const taintedStems = new Set<string>(normalizedChanged.flatMap((f) => stemsForPath(f)));

  // Follow the import graph to a fixed point instead of exactly two hops: a
  // test entry can sit three or four modules above the changed file (got:
  // test → source/index → create → core/index → options). Each hop is a cheap
  // regex scan over cached specifiers, and the loop stops as soon as nothing
  // new is tainted.
  const specCache = new Map<string, string[]>();
  const MAX_ROUTING_HOPS = 6;
  for (let hop = 0; hop < MAX_ROUTING_HOPS; hop++) {
    let grew = false;
    for (const relPath of allFiles) {
      if (affectedTests.has(relPath)) continue;
      const isTest = isTestFilePath(relPath);

      const raw = index.getRawFile(relPath);
      if (!raw) continue;

      let specs = specCache.get(relPath);
      if (!specs) {
        specs = extractImportSpecs(raw.content);
        specCache.set(relPath, specs);
      }
      let importsTainted = false;
      for (const spec of specs) {
        const resolved = resolveImportSpecifier(rootDir, relPath, spec, fileSet);
        if (resolved) {
          // A resolved import is authoritative: do not also apply the loose
          // stem heuristic, or an alias/import of `model` would link every
          // changed `*model*` file through the raw specifier text.
          if (taintedSourceFiles.has(resolved)) {
            importsTainted = true;
            break;
          }
          continue;
        }
        for (const stem of taintedStems) {
          if (
            stem.length >= 3 &&
            (spec.endsWith(`/${stem}`) ||
              spec.endsWith(`.${stem}`) ||
              spec.endsWith(`::${stem}`) ||
              spec === stem)
          ) {
            importsTainted = true;
            break;
          }
        }
        if (importsTainted) break;
      }

      // Same-directory Go `*_test.go` or stem-matched test files (`foo.py` -> `test_foo.py`)
      if (!importsTainted && isTest) {
        const testStems = stemsForPath(relPath);
        if (testStems.some((s) => taintedStems.has(s))) {
          importsTainted = true;
        }
      }

      if (importsTainted) {
        if (isTest) {
          affectedTests.add(relPath);
          grew = true;
        } else if (!taintedSourceFiles.has(relPath)) {
          taintedSourceFiles.add(relPath);
          for (const s of stemsForPath(relPath)) taintedStems.add(s);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }

  // Go tests live in the same package and import nothing, so the import graph never
  // reaches them. A `_test.go` file that names an exported symbol declared in a
  // tainted file is affected all the same.
  const wordBoundary = (name: string): RegExp =>
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  for (const relPath of allFiles) {
    if (affectedTests.has(relPath) || !relPath.endsWith("_test.go")) continue;
    const raw = index.getRawFile(relPath);
    if (!raw) continue;
    for (const tainted of taintedSourceFiles) {
      if (!tainted.endsWith(".go") || tainted === relPath) continue;
      const data = index.getFileAnalysis(tainted);
      if (!data) continue;
      const hit = data.ast.symbols.some(
        (sym) => sym.exported && sym.name.length >= 4 && wordBoundary(sym.name).test(raw.content)
      );
      if (hit) {
        affectedTests.add(relPath);
        break;
      }
    }
  }

  return {
    changedFiles: normalizedChanged,
    affectedTests: Array.from(affectedTests).sort(),
  };
}

export function execAndDehydrate(params: {
  rootDir: string;
  command: string;
  timeoutMs?: number;
}): DehydratedExecResult {
  const start = Date.now();
  const proc = spawnSync(params.command, {
    cwd: params.rootDir,
    shell: true,
    encoding: "utf8",
    timeout: params.timeoutMs ?? 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const durationMs = Date.now() - start;
  const exitCode = proc.status ?? (proc.error ? 1 : 0);
  const stdout = proc.stdout ?? "";
  const stderr = (proc.stderr ?? "") + (proc.error ? `\n${proc.error.message}` : "");

  return dehydrateCommandOutput({
    rootDir: params.rootDir,
    command: params.command,
    exitCode,
    durationMs,
    stdout,
    stderr,
  });
}


/**
 * Resolve the TS/JS test command from the project's package.json when available:
 * 1. `scripts.test` already mentions one of the affected test files -> `npm test` (script covers them).
 * 2. vitest detected in `scripts.test` or devDependencies -> `npx vitest run <files>` (existing heuristic).
 * 3. Custom runner (tsx / node --test / jest / mocha ...) -> `npm test` (full run beats a wrong runner).
 * Falls back to the vitest heuristic when rootDir is absent, package.json is missing/unparseable,
 * or `scripts.test` is missing.
 */
function resolveTsJsTestCommand(tsJsTests: string[], rootDir?: string): string {
  const vitestCmd = `npx vitest run ${tsJsTests.join(" ")}`;
  if (!rootDir) return vitestCmd;
  let pkg: { scripts?: { test?: unknown }; devDependencies?: Record<string, string> };
  try {
    const pkgPath = join(rootDir, "package.json");
    if (!existsSync(pkgPath)) return vitestCmd;
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as typeof pkg;
  } catch {
    return vitestCmd;
  }
  const testScript = typeof pkg.scripts?.test === "string" ? pkg.scripts.test : "";
  if (!testScript) return vitestCmd;
  if (tsJsTests.some((f) => testScript.includes(f))) return "npm test";
  if (testScript.includes("vitest") || pkg.devDependencies?.["vitest"]) return vitestCmd;
  return "npm test";
}

/**
 * Build a ready-to-run multi-language test command for the discovered affected test files.
 */
export function buildAffectedTestCommand(affectedTests: string[], rootDir?: string): string {
  if (affectedTests.length === 0) return "";
  const pyTests = affectedTests.filter((f) => f.endsWith(".py"));
  const goTests = affectedTests.filter((f) => f.endsWith(".go"));
  const rsTests = affectedTests.filter((f) => f.endsWith(".rs"));
  const csTests = affectedTests.filter((f) => f.endsWith(".cs"));
  const cppTests = affectedTests.filter((f) => /\.(c|cc|cpp|cxx)$/.test(f));
  const tsJsTests = affectedTests.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(f));

  const cmds: string[] = [];
  if (tsJsTests.length > 0) cmds.push(resolveTsJsTestCommand(tsJsTests, rootDir));
  if (pyTests.length > 0) cmds.push(`pytest ${pyTests.join(" ")}`);
  if (goTests.length > 0) {
    const pkgs = Array.from(new Set(goTests.map((f) => {
      const dir = dirname(f).replace(/\\/g, "/");
      return dir === "." ? "./..." : `./${dir}`;
    })));
    cmds.push(`go test ${pkgs.join(" ")}`);
  }
  if (rsTests.length > 0) cmds.push(`cargo test`);
  if (csTests.length > 0) cmds.push(`dotnet test`);
  if (cppTests.length > 0) cmds.push(`ctest --output-on-failure`);
  return cmds.join(" && ");
}
