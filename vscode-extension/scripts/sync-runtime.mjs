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

const SKIP_VENDOR_PACKAGES = new Set([
  // Platform-specific native binaries must not be copied from the build OS into the VSIX.
  "onnxruntime-node",
  // sharp is native / platform-specific; text embeddings do not require it.
  "sharp",
]);

// NOTE: `@xenova/transformers` (+ onnxruntime-web) is intentionally NOT in
// runtimeRoots — it adds ~100MB+ to the VSIX. The core runtime falls back to
// FNV-1a hash embeddings when the package cannot be resolved from vendor.
// Users who install transformers separately can pre-seed the model cache and
// point GRAPHFLOW_EMBEDDING_CACHE_DIR / embeddingPolicy.modelCacheDir at it.

function bundlePackage(name, modulesRoot, vendorModules, visited) {
  if (visited.has(name) || SKIP_VENDOR_PACKAGES.has(name)) {
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
cpSync(join(repoRoot, "package.json"), join(vendorRoot, "package.json"));

const wasmSrc = join(repoRoot, "wasm");
const wasmDest = join(vendorRoot, "wasm");
if (existsSync(wasmSrc)) {
  cpSync(wasmSrc, wasmDest, { recursive: true });
  console.log(`Synced wasm grammars: ${wasmSrc} -> ${wasmDest}`);
} else {
  console.warn("[sync-runtime] wasm/ not found — run root npm run build first");
}

// 同步 Skill / Rules / CLAUDE.md 源文件到 vendor 中，
// 确保 VS Code 扩展激活时能找到这些文件进行安装。
const skillAssets = [
  {
    src: join(repoRoot, "src", "surfaces", "trae-skill"),
    dst: join(vendorRoot, "src", "surfaces", "trae-skill"),
    name: "Trae Skill",
  },
  {
    src: join(repoRoot, "src", "surfaces", "trae-rules"),
    dst: join(vendorRoot, "src", "surfaces", "trae-rules"),
    name: "Trae Rules",
  },
  {
    src: join(repoRoot, "src", "surfaces", "cursor-rules"),
    dst: join(vendorRoot, "src", "surfaces", "cursor-rules"),
    name: "Cursor Rules",
  },
  {
    src: join(repoRoot, "src", "surfaces", "antigravity-rules"),
    dst: join(vendorRoot, "src", "surfaces", "antigravity-rules"),
    name: "Antigravity Rules",
  },
  {
    src: join(repoRoot, "src", "surfaces", "copilot-instructions"),
    dst: join(vendorRoot, "src", "surfaces", "copilot-instructions"),
    name: "Copilot Instructions",
  },
];

for (const asset of skillAssets) {
  if (existsSync(asset.src)) {
    // 先清理旧文件，再复制新文件
    rmSync(asset.dst, { recursive: true, force: true });
    mkdirSync(dirname(asset.dst), { recursive: true });
    cpSync(asset.src, asset.dst, { recursive: true });
    console.log(`Synced ${asset.name}: ${asset.src} -> ${asset.dst}`);
  } else {
    console.warn(`[sync-runtime] ${asset.name} source not found: ${asset.src}`);
  }
}

// 同步 CLAUDE.md 到 vendor 根目录
const claudeMdSrc = join(repoRoot, "CLAUDE.md");
const claudeMdDst = join(vendorRoot, "CLAUDE.md");
if (existsSync(claudeMdSrc)) {
  cpSync(claudeMdSrc, claudeMdDst);
  console.log(`Synced CLAUDE.md: ${claudeMdSrc} -> ${claudeMdDst}`);
} else {
  console.warn("[sync-runtime] CLAUDE.md not found in repo root");
}

rmSync(vendorNodeModules, { recursive: true, force: true });
mkdirSync(vendorNodeModules, { recursive: true });

const runtimeRoots = [
  "typescript",
  "gpt-tokenizer",
  "web-tree-sitter",
  "pino",
  // Installer surface is frozen; do not add more IDE-specific runtime targets
  // or @xenova/transformers here (see note above).
];

const visited = new Set();
for (const dep of runtimeRoots) {
  bundlePackage(dep, join(repoRoot, "node_modules"), vendorNodeModules, visited);
}

console.log(`Bundled ${visited.size} runtime packages into ${vendorNodeModules}`);
console.log(`Synced runtime: ${sourceDist} -> ${vendorDist}`);
