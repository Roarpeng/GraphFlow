/**
 * GraphFlow 3.0 — Pillar 3: Deterministic Tool Execution, Stdout Dehydrator &
 * Multi-Language Diff-to-Test Impact Router (`dehydrator.ts`)
 */

import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (
      (trimmed.startsWith("at ") && trimmed.includes("node_modules/")) ||
      trimmed.includes("/site-packages/") ||
      trimmed.includes("/rustc/")
    ) {
      continue;
    }

    const locMatch = line.match(WORKSPACE_FILE_LINE_RE) ?? line.match(PYTHON_TRACEBACK_FILE_LINE_RE);
    if (locMatch) {
      const file = locMatch[1]!.replace(/^\.\//, "");
      const ln = Number.parseInt(locMatch[2]!, 10);
      const key = `${file}:${ln}`;
      if (!seenLocations.has(key) && referencedLocations.length < 3) {
        seenLocations.add(key);
        referencedLocations.push({ file, line: ln });
      }
      salientLines.push(line);
      continue;
    }

    if (SALIENT_ERROR_LINE_RE.test(line)) {
      salientLines.push(line);
      if (i + 1 < allLines.length && allLines[i + 1]!.trim() && !allLines[i + 1]!.includes("node_modules/")) {
        salientLines.push(allLines[i + 1]!);
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
      const abs = join(params.rootDir, loc.file);
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

function isTestFilePath(relPath: string): boolean {
  const base = basename(relPath);
  return (
    relPath.startsWith("tests/") ||
    relPath.includes(".test.") ||
    relPath.includes(".spec.") ||
    /^test_.*\.py$/.test(base) ||
    /_test\.(py|go|rs|cpp|cc|c)$/.test(base) ||
    /Tests?\.cs$/.test(base)
  );
}

function stemsForPath(relPath: string): string[] {
  const base = basename(relPath)
    .replace(/\.(test|spec)?\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|c|h|cc|cpp|hpp|cxx|cs)$/, "")
    .replace(/^test_/, "")
    .replace(/_test$/, "")
    .replace(/Tests?$/, "");
  if (base === "index" || base === "__init__" || base === "mod") {
    const parent = basename(dirname(relPath));
    return parent && parent !== "." ? [base, parent] : [base];
  }
  return [base];
}

function extractFastImportSpecs(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(FAST_IMPORT_SPEC_RE)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
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
      const raw = execSync("git status --porcelain", {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      changed = raw
        .split(/\r?\n/)
        .map((line) => line.slice(3).trim().replace(/^.* -> /, ""))
        .filter(
          (f) =>
            f.length > 0 &&
            /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|c|h|cc|cpp|hpp|cxx|cs)$/.test(f)
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
  const allFiles = index.getFiles();
  const affectedTests = new Set<string>();

  for (const f of normalizedChanged) {
    if (isTestFilePath(f)) {
      if (existsSync(join(rootDir, f))) affectedTests.add(f);
    }
  }

  const taintedSourceFiles = new Set<string>(normalizedChanged);
  const taintedStems = new Set<string>(normalizedChanged.flatMap((f) => stemsForPath(f)));

  for (let hop = 0; hop < 2; hop++) {
    for (const relPath of allFiles) {
      if (affectedTests.has(relPath)) continue;
      const isTest = isTestFilePath(relPath);
      if (hop === 1 && !isTest) continue;

      const raw = index.getRawFile(relPath);
      if (!raw) continue;

      const specs = extractFastImportSpecs(raw.content);
      let importsTainted = false;
      for (const spec of specs) {
        const resolved = resolveRelativeImportPath(rootDir, relPath, spec, index.getFileSet());
        if (resolved && taintedSourceFiles.has(resolved)) {
          importsTainted = true;
          break;
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
        } else if (!taintedSourceFiles.has(relPath)) {
          taintedSourceFiles.add(relPath);
          for (const s of stemsForPath(relPath)) taintedStems.add(s);
        }
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
 * Build a ready-to-run multi-language test command for the discovered affected test files.
 */
export function buildAffectedTestCommand(affectedTests: string[]): string {
  if (affectedTests.length === 0) return "";
  const pyTests = affectedTests.filter((f) => f.endsWith(".py"));
  const goTests = affectedTests.filter((f) => f.endsWith(".go"));
  const rsTests = affectedTests.filter((f) => f.endsWith(".rs"));
  const csTests = affectedTests.filter((f) => f.endsWith(".cs"));
  const cppTests = affectedTests.filter((f) => /\.(c|cc|cpp|cxx)$/.test(f));
  const tsJsTests = affectedTests.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));

  const cmds: string[] = [];
  if (tsJsTests.length > 0) cmds.push(`npx vitest run ${tsJsTests.join(" ")}`);
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
