import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(scriptDir, "..");
const repoRoot = join(extensionRoot, "..");
const sourceDist = join(repoRoot, "dist");
const vendorRoot = join(extensionRoot, "vendor", "graphflow");
const vendorDist = join(vendorRoot, "dist");

if (!existsSync(sourceDist)) {
  throw new Error("GraphFlow core dist folder not found. Run root build first.");
}

rmSync(vendorDist, { recursive: true, force: true });
mkdirSync(vendorRoot, { recursive: true });
cpSync(sourceDist, vendorDist, { recursive: true });

console.log(`Synced runtime: ${sourceDist} -> ${vendorDist}`);
