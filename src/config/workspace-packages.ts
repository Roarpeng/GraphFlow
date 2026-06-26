import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function readWorkspacesPatterns(rootDir: string): string[] {
  const pkgPath = join(rootDir, "package.json");
  if (!existsSync(pkgPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const workspaces = parsed.workspaces;
    if (Array.isArray(workspaces)) {
      return workspaces.filter((entry): entry is string => typeof entry === "string");
    }
    if (workspaces && typeof workspaces === "object" && Array.isArray(workspaces.packages)) {
      return workspaces.packages.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    // ignore invalid package.json
  }
  return [];
}

function resolveWorkspacePattern(rootDir: string, pattern: string): string[] {
  const normalized = normalizeRelPath(pattern);
  if (normalized.endsWith("/*")) {
    const parentRel = normalized.slice(0, -2);
    const parentAbs = join(rootDir, parentRel);
    if (!existsSync(parentAbs)) {
      return [];
    }
    const found: string[] = [];
    for (const entry of readdirSync(parentAbs)) {
      const subAbs = join(parentAbs, entry);
      if (existsSync(join(subAbs, "package.json"))) {
        found.push(normalizeRelPath(relative(rootDir, subAbs)));
      }
    }
    return found.sort();
  }

  const abs = join(rootDir, normalized);
  if (existsSync(join(abs, "package.json"))) {
    return [normalized];
  }
  return [];
}

/** Workspace package roots relative to rootDir; always includes "." for the root package. */
export function discoverWorkspacePackages(rootDir: string): string[] {
  const resolved = resolve(rootDir);
  const patterns = readWorkspacesPatterns(resolved);
  const packages = new Set<string>(["."]);

  for (const pattern of patterns) {
    for (const pkgRoot of resolveWorkspacePattern(resolved, pattern)) {
      packages.add(pkgRoot === "" ? "." : pkgRoot);
    }
  }

  return Array.from(packages).sort((a, b) => {
    if (a === ".") {
      return -1;
    }
    if (b === ".") {
      return 1;
    }
    return a.localeCompare(b);
  });
}

function readPackageName(packageJsonPath: string): string | undefined {
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
    return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function toRelativePath(rootDir: string, filePath: string): string {
  const resolvedRoot = resolve(rootDir);
  const resolvedPath = resolve(filePath);
  if (resolvedPath.startsWith(resolvedRoot + "/") || resolvedPath === resolvedRoot) {
    const rel = normalizeRelPath(relative(resolvedRoot, resolvedPath));
    return rel.length === 0 ? "." : rel;
  }
  return normalizeRelPath(filePath);
}

/** Innermost workspace package root containing relPath, or undefined when not under a listed package. */
export function findWorkspacePackageRoot(
  relPath: string,
  packageRoots: string[]
): string | undefined {
  const normalized = normalizeRelPath(relPath);
  if (normalized === "." || normalized === "") {
    return packageRoots.includes(".") ? "." : undefined;
  }

  let best: string | undefined;
  let bestLen = -1;
  for (const root of packageRoots) {
    if (root === ".") {
      continue;
    }
    const rootNorm = normalizeRelPath(root);
    if (normalized === rootNorm || normalized.startsWith(`${rootNorm}/`)) {
      if (rootNorm.length > bestLen) {
        best = rootNorm;
        bestLen = rootNorm.length;
      }
    }
  }

  if (best) {
    return best;
  }

  if (!normalized.includes("/") && packageRoots.includes(".")) {
    return ".";
  }

  return undefined;
}

/** Workspace package name from package.json, or the package folder name. */
export function packageLabelForPath(rootDir: string, filePath: string): string {
  const rel = toRelativePath(rootDir, filePath);
  const packageRoots = discoverWorkspacePackages(rootDir);
  const pkgRoot = findWorkspacePackageRoot(rel, packageRoots);

  if (pkgRoot && pkgRoot !== ".") {
    const name = readPackageName(join(rootDir, pkgRoot, "package.json"));
    if (name) {
      return name;
    }
    return basename(pkgRoot);
  }

  const rootName = readPackageName(join(rootDir, "package.json"));
  if (rootName) {
    return rootName;
  }

  const parts = rel.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return ".";
  }
  return parts[0] ?? ".";
}

export function workspacePackageForPath(
  rootDir: string,
  relPath: string,
  packageRoots?: string[]
): string | undefined {
  const roots = packageRoots ?? discoverWorkspacePackages(rootDir);
  const pkgRoot = findWorkspacePackageRoot(normalizeRelPath(relPath), roots);
  if (!pkgRoot) {
    return undefined;
  }
  if (pkgRoot === ".") {
    return readPackageName(join(rootDir, "package.json")) ?? ".";
  }
  return readPackageName(join(rootDir, pkgRoot, "package.json")) ?? basename(pkgRoot);
}
