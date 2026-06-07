import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(scriptDir, "..");
const repoRoot = join(extensionRoot, "..");
const sourceDist = join(repoRoot, "dist");
const vendorRoot = join(extensionRoot, "vendor", "graphflow");
const vendorDist = join(vendorRoot, "dist");
const vendorNodeModules = join(vendorRoot, "node_modules");

if (!existsSync(sourceDist)) {
  throw new Error("GraphFlow core dist folder not found. Run root build first.");
}

function packageDir(name, modulesRoot) {
  if (name.startsWith("@")) {
    const [scope, pkg] = name.split("/");
    return join(modulesRoot, scope, pkg);
  }
  return join(modulesRoot, name);
}

function readPackage(name, modulesRoot) {
  const pkgPath = join(packageDir(name, modulesRoot), "package.json");
  if (!existsSync(pkgPath)) {
    return null;
  }
  return JSON.parse(readFileSync(pkgPath, "utf8"));
}

function bundlePackage(name, modulesRoot, vendorModules, visited) {
  if (visited.has(name)) {
    return;
  }
  visited.add(name);

  const src = packageDir(name, modulesRoot);
  if (!existsSync(src)) {
    console.warn(`[sync-runtime] skip ${name}: ${src} does not exist`);
    return;
  }

  const dst = packageDir(name, vendorModules);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });

  const pkg = readPackage(name, modulesRoot);
  if (!pkg) {
    return;
  }

  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
  for (const dep of Object.keys(deps)) {
    bundlePackage(dep, modulesRoot, vendorModules, visited);
  }
}

rmSync(vendorDist, { recursive: true, force: true });
mkdirSync(vendorRoot, { recursive: true });
cpSync(sourceDist, vendorDist, { recursive: true });

rmSync(vendorNodeModules, { recursive: true, force: true });
mkdirSync(vendorNodeModules, { recursive: true });

const runtimeRoots = [
  "typescript",
  "gpt-tokenizer",
  "web-tree-sitter",
  "pino",
  "@xenova/transformers",
];

const visited = new Set();
for (const dep of runtimeRoots) {
  bundlePackage(dep, join(repoRoot, "node_modules"), vendorNodeModules, visited);
}

console.log(`Bundled ${visited.size} runtime packages into ${vendorNodeModules}`);
console.log(`Synced runtime: ${sourceDist} -> ${vendorDist}`);
