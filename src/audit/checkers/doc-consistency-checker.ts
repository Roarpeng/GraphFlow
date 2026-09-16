/**
 * R9 closing audit — doc-consistency checker (baseline-driven + one stateful).
 *
 * - CLI entry changes (src/surfaces/cli/** or a package.json `bin` target)
 *   without any README/docs change suggest undocumented behavior drift →
 *   warning. Skipped when no baseline is derivable.
 * - A README npm version badge (badge/npm-vX.Y.Z) that lags package.json's
 *   version is a hard inconsistency → error. This check is stateful: it also
 *   runs when the baseline is empty, and runs on package.json changes.
 *
 * Missing badges / unreadable files skip the corresponding check — never
 * throw, never guess.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AuditChecker, AuditContext, AuditFinding } from "../types.js";
import { globMatches } from "../rules.js";

const CLI_ENTRY_GLOB = "src/surfaces/cli/**";
const DOC_DIR_GLOB = "docs/**";
/** shields-style literal badge, e.g. https://img.shields.io/badge/npm-v1.2.3-blue */
const NPM_BADGE_RE = /badge\/npm-v?(\d+(?:\.\d+){0,2})/;
const README_CANDIDATES = ["README.md", "README"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRel(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Files package.json `bin` points at (relative posix), best effort. */
function loadBinEntryFiles(root: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as unknown;
    if (!isRecord(raw)) return [];
    const bin = raw.bin;
    if (typeof bin === "string") return [normalizeRel(bin)];
    if (isRecord(bin)) {
      return Object.values(bin)
        .filter((value): value is string => typeof value === "string")
        .map(normalizeRel);
    }
    return [];
  } catch {
    return [];
  }
}

function isDocChange(path: string): boolean {
  return globMatches(DOC_DIR_GLOB, path) || /^readme/i.test(basename(path));
}

/** README badge version vs package.json version; quiet when either is absent. */
function checkVersionBadge(root: string): AuditFinding[] {
  let version: string | undefined;
  let readmeName: string | undefined;
  let readmeText: string | undefined;
  try {
    const raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as unknown;
    version = isRecord(raw) && typeof raw.version === "string" ? raw.version : undefined;
    if (!version) return [];
    for (const candidate of README_CANDIDATES) {
      try {
        readmeText = readFileSync(join(root, candidate), "utf8");
        readmeName = candidate;
        break;
      } catch {
        // try the next candidate — no README means no badge to compare
      }
    }
  } catch {
    return [];
  }
  if (readmeText === undefined || readmeName === undefined) return [];
  const found = NPM_BADGE_RE.exec(readmeText)?.[1];
  if (found === undefined || found === version) return [];
  return [
    {
      id: `doc-version-badge:${found}`,
      kind: "doc-consistency",
      severity: "error",
      message: `README 版本徽章 ${found} 与 package.json ${version} 不一致`,
      evidence: {
        files: [readmeName, "package.json"],
        detail: `README 徽章记录 npm ${found}，package.json 声明 version ${version}`,
      },
      remediation: `把 README 徽章中的 npm 版本从 ${found} 更新为 ${version}。`,
    },
  ];
}

export function createDocConsistencyChecker(): AuditChecker {
  return {
    name: "doc-consistency",
    async run(
      changedFiles: string[],
      root: string,
      _context: AuditContext
    ): Promise<AuditFinding[]> {
      const findings: AuditFinding[] = [];
      try {
        const changed = changedFiles.map(normalizeRel);

        // CLI-undocumented check needs a baseline; skip when it is empty.
        if (changed.length > 0) {
          const binEntries = loadBinEntryFiles(root);
          const cliChanged = changed.filter(
            (file) => globMatches(CLI_ENTRY_GLOB, file) || binEntries.includes(file)
          );
          const hasDocChange = changed.some(isDocChange);
          if (cliChanged.length > 0 && !hasDocChange) {
            findings.push({
              id: "doc-cli-undocumented",
              kind: "doc-consistency",
              severity: "warning",
              message: "CLI 有变更但文档未动——README/docs 需要更新吗？",
              evidence: {
                files: cliChanged.slice(0, 5),
                detail: "变更基线命中 CLI 入口，但没有任何 README*/docs/** 变更",
              },
              remediation: "确认 CLI 用法/参数是否变化，同步更新 README 或 docs/ 下的文档。",
            });
          }
        }

        // Badge consistency runs on package.json changes; with an empty
        // baseline (strategy "none") it is the remaining stateful check.
        if (changed.length === 0 || changed.includes("package.json")) {
          findings.push(...checkVersionBadge(root));
        }
      } catch {
        // fail open — an audit checker must never throw
      }
      return findings;
    },
  };
}
