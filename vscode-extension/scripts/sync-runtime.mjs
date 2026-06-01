import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
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

rmSync(vendorDist, { recursive: true, force: true });
mkdirSync(vendorRoot, { recursive: true });
cpSync(sourceDist, vendorDist, { recursive: true });

// Bundle runtime-only dependencies that the extension host cannot resolve from elsewhere.
// Native modules (e.g. better-sqlite3) are intentionally skipped — they degrade via fallback.
const runtimeDeps = ["typescript", "gpt-tokenizer"];
rmSync(vendorNodeModules, { recursive: true, force: true });
mkdirSync(vendorNodeModules, { recursive: true });
for (const dep of runtimeDeps) {
  const src = join(repoRoot, "node_modules", dep);
  const dst = join(vendorNodeModules, dep);
  if (!existsSync(src)) {
    console.warn(`[sync-runtime] skip ${dep}: ${src} does not exist`);
    continue;
  }
  cpSync(src, dst, { recursive: true });
  console.log(`Bundled runtime dep: ${dep}`);
}

console.log(`Synced runtime: ${sourceDist} -> ${vendorDist}`);
