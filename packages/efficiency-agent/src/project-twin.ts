/**
 * Project Twin (2.x plan §10) — a pure, deterministic, JSON-serializable
 * answer to "where is the project, which modules exist, which files matter,
 * how do I build and test it". v0 derives everything from facts the host
 * collected (package.json fields, a file→symbols map, recent commits); it
 * performs no I/O and invents nothing beyond the stated heuristics.
 * `knownIssues` and `preferredTools` are honestly empty in v0 — tool
 * intelligence (§9) fills the latter later.
 *
 * 项目孪生（§10）：纯函数、确定性、可 JSON 序列化的项目摘要。v0 仅从
 * host 采集的 facts 推导（package.json、文件→符号映射、近期提交），
 * 不做任何 I/O；knownIssues / preferredTools 诚实留空，后者由 §9 的
 * 工具智能填充。相同 facts 必然产出深度相等的 twin。
 *
 * Determinism contract: every derived array is either copied-as-given,
 * sliced, or sorted with a total comparator — same facts in, deep-equal
 * twin out, safe to cache by fingerprint (P3).
 */

/** The subset of package.json the twin cares about. */
export interface ProjectTwinPackageJsonFacts {
  name?: string;
  main?: string;
  scripts: Record<string, string>;
  dependencies: string[];
}

/** One mapped file and the symbols it defines/exports. */
export interface ProjectTwinFileFacts {
  path: string;
  symbols: string[];
}

/** Raw host-collected facts; `buildProjectTwin` never mutates them. */
export interface ProjectTwinFacts {
  root: string;
  packageJson?: ProjectTwinPackageJsonFacts;
  fileMap: ProjectTwinFileFacts[];
  recentCommits: string[];
}

/** The derived twin (2.x plan §10 field set). */
export interface ProjectTwin {
  /** package.json name when present, else the root basename. */
  project: string;
  root: string;
  /** Distinct top-level source dirs (path depth capped at 2), sorted. */
  modules: string[];
  /** main plus start-like script commands, filtered, deduped, sorted. */
  entrypoints: string[];
  /** Symbols appearing in >= 2 mapped files — top 20 by (file count desc, name asc). */
  importantSymbols: string[];
  dependencies: string[];
  /** Script NAMES matching /build|compile/i, sorted. */
  build: string[];
  /** Script NAMES matching /test|spec/i, sorted. */
  tests: string[];
  /** Detected convention tags ("node", "npm-workspace", "typescript", "vitest"). */
  conventions: string[];
  /** recentCommits capped at 10, recency order preserved. */
  recentChanges: string[];
  /** v0: honest empty — filled by later reflection cycles. */
  knownIssues: string[];
  /** v0: empty — populated by tool intelligence (§9). */
  preferredTools: string[];
}

/** Script names treated as "start-like" for entrypoint detection. */
const START_LIKE_SCRIPTS: readonly string[] = ["start", "dev"];
/** Maximum number of recent commits kept in the twin. */
const RECENT_CHANGES_LIMIT = 10;
/** Maximum number of important symbols kept in the twin. */
const IMPORTANT_SYMBOLS_LIMIT = 20;
/** Minimum number of distinct files for a symbol to count as important. */
const CROSS_FILE_THRESHOLD = 2;
/** Script-name pattern that marks a build entry. */
const BUILD_SCRIPT_PATTERN = /build|compile/i;
/** Script-name pattern that marks a test entry. */
const TEST_SCRIPT_PATTERN = /test|spec/i;

/** UTF-16 code-unit order — environment-independent, unlike localeCompare. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Basename of a POSIX-or-Windows path, ignoring trailing separators. */
function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const last = parts.length > 0 ? parts[parts.length - 1] : undefined;
  return last ?? path;
}

/**
 * Directory prefix of a mapped file, capped at depth 2:
 * "src/a.ts" → "src", "src/x/y.ts" → "src/x", "src/a/b/c.ts" → "src/a".
 * Root-level files ("README.md") map to no module.
 */
function moduleOfPath(path: string): string | undefined {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return undefined;
  }
  const directories = segments.slice(0, -1);
  return directories.slice(0, 2).join("/");
}

function deriveProject(facts: ProjectTwinFacts): string {
  const name = facts.packageJson?.name;
  return name !== undefined && name.length > 0 ? name : basename(facts.root);
}

function deriveModules(facts: ProjectTwinFacts): string[] {
  const modules = new Set<string>();
  for (const entry of facts.fileMap) {
    const module = moduleOfPath(entry.path);
    if (module !== undefined) {
      modules.add(module);
    }
  }
  return [...modules].sort(compareText);
}

function deriveEntrypoints(facts: ProjectTwinFacts): string[] {
  const entrypoints = new Set<string>();
  const main = facts.packageJson?.main;
  if (main !== undefined && main.length > 0) {
    entrypoints.add(main);
  }
  const scripts = facts.packageJson?.scripts ?? {};
  for (const scriptName of START_LIKE_SCRIPTS) {
    const command = scripts[scriptName];
    if (command !== undefined && command.length > 0) {
      entrypoints.add(command);
    }
  }
  return [...entrypoints].sort(compareText);
}

/**
 * Symbols ranked by how many distinct files mention them (a symbol listed
 * twice inside one file's array still counts that file once), then by name.
 */
function deriveImportantSymbols(facts: ProjectTwinFacts): string[] {
  const filesBySymbol = new Map<string, Set<string>>();
  for (const entry of facts.fileMap) {
    for (const symbol of new Set(entry.symbols)) {
      const files = filesBySymbol.get(symbol);
      if (files !== undefined) {
        files.add(entry.path);
      } else {
        filesBySymbol.set(symbol, new Set([entry.path]));
      }
    }
  }
  return [...filesBySymbol.entries()]
    .filter(([, files]) => files.size >= CROSS_FILE_THRESHOLD)
    .sort((a, b) => b[1].size - a[1].size || compareText(a[0], b[0]))
    .slice(0, IMPORTANT_SYMBOLS_LIMIT)
    .map(([symbol]) => symbol);
}

function deriveScriptNames(facts: ProjectTwinFacts, pattern: RegExp): string[] {
  const scripts = facts.packageJson?.scripts ?? {};
  return Object.keys(scripts)
    .filter((name) => pattern.test(name))
    .sort(compareText);
}

function deriveConventions(facts: ProjectTwinFacts, testScripts: string[]): string[] {
  const conventions = new Set<string>(["node"]);
  const paths = facts.fileMap.map((entry) => entry.path);
  const hasLockfile = paths.some((path) => basename(path) === "package-lock.json");
  const hasTypeScript = paths.some((path) => path.endsWith(".ts"));
  if (hasLockfile) {
    conventions.add("npm-workspace");
  }
  if (hasTypeScript) {
    conventions.add("typescript");
  }
  if (testScripts.length > 0) {
    conventions.add("vitest");
  }
  return [...conventions].sort(compareText);
}

/** Pure derivation: same facts → deep-equal twin, caller's facts untouched. */
export function buildProjectTwin(facts: ProjectTwinFacts): ProjectTwin {
  const testScripts = deriveScriptNames(facts, TEST_SCRIPT_PATTERN);
  return {
    project: deriveProject(facts),
    root: facts.root,
    modules: deriveModules(facts),
    entrypoints: deriveEntrypoints(facts),
    importantSymbols: deriveImportantSymbols(facts),
    dependencies: [...(facts.packageJson?.dependencies ?? [])].sort(compareText),
    build: deriveScriptNames(facts, BUILD_SCRIPT_PATTERN),
    tests: testScripts,
    conventions: deriveConventions(facts, testScripts),
    recentChanges: [...facts.recentCommits].slice(0, RECENT_CHANGES_LIMIT),
    knownIssues: [],
    preferredTools: [],
  };
}
