/**
 * R9 closing audit — dependency checker (npm + pip), stateful.
 *
 * Compares the dependency manifests a project declares (package.json,
 * requirements.txt) against the lockfiles that must mirror them
 * (package-lock.json, poetry.lock / Pipfile.lock). Observables only: a
 * missing or unparseable manifest/lockfile proves nothing, so the checker
 * fails open and reports nothing for that ecosystem.
 *
 * Lock formats:
 * - npm lockfileVersion 2/3: `packages["node_modules/<name>"]`, plus nested /
 *   duplicated copies under `<parent>/node_modules/<name>`. The root entry
 *   `packages[""]` records what the lock believes the manifest declares.
 * - npm lockfileVersion 1: flat top-level `dependencies` map (the reverse
 *   check is skipped there — a v1 lock lists every transitive package, so
 *   "in lock but not in manifest" would be pure noise).
 * - pip: no standard lock; only checked when a poetry.lock / Pipfile.lock
 *   sits next to requirements.txt, otherwise skipped — no guessing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditChecker, AuditContext, AuditFinding } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read + JSON.parse; undefined on any failure (missing file, bad JSON). */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Own keys of a possibly-absent JSON record. */
function keysOf(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

/** v3 lock presence: the direct entry, or a nested/duplicated copy. */
function lockV3HasPackage(packages: Record<string, unknown>, name: string): boolean {
  if (Object.prototype.hasOwnProperty.call(packages, `node_modules/${name}`)) return true;
  const nested = `/node_modules/${name}`;
  return Object.keys(packages).some((key) => key.length > nested.length && key.endsWith(nested));
}

function auditNpm(root: string): AuditFinding[] {
  const manifest = readJson(join(root, "package.json"));
  const lock = readJson(join(root, "package-lock.json"));
  if (!isRecord(manifest) || !isRecord(lock)) return [];

  const packages = isRecord(lock.packages) ? lock.packages : undefined;
  const v1Deps = isRecord(lock.dependencies) ? lock.dependencies : undefined;
  if (!packages && !v1Deps) return []; // unknown lock shape — fail open

  // Direct declarations only: dependencies + devDependencies (optional and
  // peer dependencies live in the lock without being direct manifest deps).
  const declared = new Map<string, string>();
  for (const section of ["dependencies", "devDependencies"] as const) {
    const deps = manifest[section];
    if (!isRecord(deps)) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (!declared.has(name)) declared.set(name, typeof range === "string" ? range : "*");
    }
  }

  const findings: AuditFinding[] = [];

  // (a) manifest → lock: every declared dependency must exist in the lock.
  for (const [name, range] of declared) {
    const present = packages
      ? lockV3HasPackage(packages, name)
      : v1Deps !== undefined && Object.prototype.hasOwnProperty.call(v1Deps, name);
    if (!present) {
      findings.push({
        id: `dependency-lock-missing:${name}`,
        kind: "dependency",
        severity: "error",
        message: `依赖 ${name} 已加入 package.json 但 lock 未更新——忘跑 npm install 了吗？`,
        evidence: {
          files: ["package.json", "package-lock.json"],
          detail: `package.json 声明 ${name}@${range}，lock 中无对应条目`,
        },
        remediation: "在项目根目录运行 npm install，让 package-lock.json 记录该依赖。",
      });
    }
  }

  // (b) lock root entry → manifest (v3 only). Extra entries are warnings:
  // optional peers land in the lock without being direct dependencies.
  if (packages) {
    const rootEntry = isRecord(packages[""]) ? packages[""] : undefined;
    const lockDeclared = [
      ...keysOf(rootEntry?.dependencies),
      ...keysOf(rootEntry?.devDependencies),
    ];
    for (const name of lockDeclared) {
      if (!declared.has(name)) {
        findings.push({
          id: `dependency-lock-extra:${name}`,
          kind: "dependency",
          severity: "warning",
          message: `lock 仍声明 ${name} 但 package.json 已不含它——optional peer，还是忘了重新生成 lock？`,
          evidence: {
            files: ["package-lock.json", "package.json"],
            detail: `packages[""] 记录了 ${name}，package.json 的 dependencies/devDependencies 中没有`,
          },
          remediation: "运行 npm install 重新同步 package-lock.json；若为 optional peer 依赖可忽略。",
        });
      }
    }
  }

  return findings;
}

/** "pkg==ver" pinned line → pkg name; comments/options/editables → undefined. */
function pinnedRequirementName(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) return undefined;
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*==/.exec(trimmed);
  return match?.[1];
}

function auditPip(root: string): AuditFinding[] {
  const reqPath = join(root, "requirements.txt");
  if (!existsSync(reqPath)) return [];
  let reqText: string;
  try {
    reqText = readFileSync(reqPath, "utf8");
  } catch {
    return [];
  }
  // pip has no standard lock: only check when poetry.lock / Pipfile.lock
  // exists next to requirements.txt — otherwise skip entirely.
  const lockName = ["poetry.lock", "Pipfile.lock"].find((name) => existsSync(join(root, name)));
  if (!lockName) return [];
  let lockText: string;
  try {
    lockText = readFileSync(join(root, lockName), "utf8");
  } catch {
    return [];
  }

  // Both poetry.lock (`name = "flask"`) and Pipfile.lock (`"flask": {...}`)
  // quote package names — a quoted, case-insensitive containment check keeps
  // flask from matching flask-cors without guessing at normalization rules.
  const lockLower = lockText.toLowerCase();
  const findings: AuditFinding[] = [];
  for (const rawLine of reqText.split(/\r?\n/)) {
    const name = pinnedRequirementName(rawLine);
    if (!name) continue;
    const needle = `"${name}"`.toLowerCase();
    if (!lockLower.includes(needle)) {
      findings.push({
        id: `dependency-lock-missing:${name}`,
        kind: "dependency",
        severity: "error",
        message: `依赖 ${name} 已写入 requirements.txt 但 ${lockName} 未收录——忘更新锁文件了吗？`,
        evidence: {
          files: ["requirements.txt", lockName],
          detail: `requirements.txt 固定了 ${name}，${lockName} 中未找到该包名`,
        },
        remediation:
          lockName === "poetry.lock"
            ? `运行 poetry add ${name}（或 poetry lock）让 poetry.lock 收录该依赖。`
            : `运行 pipenv install ${name} 让 Pipfile.lock 收录该依赖。`,
      });
    }
  }
  return findings;
}

/**
 * Stateful dependency checker: runs even without a changed-file baseline.
 * npm and pip are audited independently — one ecosystem failing open never
 * hides the other's findings, and the checker never throws.
 */
export function createDependencyChecker(): AuditChecker {
  return {
    name: "dependency",
    async run(
      _changedFiles: string[],
      root: string,
      _context: AuditContext
    ): Promise<AuditFinding[]> {
      const findings: AuditFinding[] = [];
      try {
        findings.push(...auditNpm(root));
      } catch {
        // fail open — an audit checker must never throw
      }
      try {
        findings.push(...auditPip(root));
      } catch {
        // fail open
      }
      return findings;
    },
  };
}
