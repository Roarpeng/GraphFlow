#!/usr/bin/env node
/**
 * Bundle tree-sitter WASM grammars into wasm/ for offline distribution.
 *
 * Priority:
 *   1. Copy from node_modules/tree-sitter-wasms/out/ (no network)
 *   2. Download from unpkg (CI fallback when devDependency missing)
 *
 * Output: wasm/tree-sitter-<language>.wasm
 */
const { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createRequire } = require("node:module");

const requireFn = createRequire(__filename);
const GRAMMARS = ["python", "go", "rust", "c", "cpp", "java", "ruby", "kotlin", "swift", "dart"];
const VERSION = "0.1.13";
const OUTPUT_DIR = join(__dirname, "..", "wasm");

function resolveTreeSitterWasmsOutDir() {
  try {
    const pkgPath = requireFn.resolve("tree-sitter-wasms/package.json");
    return join(pkgPath, "..", "out");
  } catch {
    return null;
  }
}

function copyFromPackage(outDir, lang, outputPath) {
  const sourcePath = join(outDir, `tree-sitter-${lang}.wasm`);
  if (!existsSync(sourcePath)) {
    return false;
  }
  copyFileSync(sourcePath, outputPath);
  const sizeKb = (statSync(outputPath).size / 1024).toFixed(1);
  console.log(`[copy] tree-sitter-${lang}.wasm (${sizeKb} KB)`);
  return true;
}

async function downloadFromUnpkg(lang, outputPath) {
  const fileName = `tree-sitter-${lang}.wasm`;
  const url = `https://unpkg.com/tree-sitter-wasms@${VERSION}/out/${fileName}`;
  console.log(`[download] ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(outputPath, buffer);
  console.log(`[ok] ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const wasmsOutDir = resolveTreeSitterWasmsOutDir();
  let failures = 0;

  for (const lang of GRAMMARS) {
    const fileName = `tree-sitter-${lang}.wasm`;
    const outputPath = join(OUTPUT_DIR, fileName);

    if (existsSync(outputPath)) {
      console.log(`[skip] ${fileName} already exists`);
      continue;
    }

    try {
      if (wasmsOutDir && copyFromPackage(wasmsOutDir, lang, outputPath)) {
        continue;
      }
      await downloadFromUnpkg(lang, outputPath);
    } catch (err) {
      failures += 1;
      console.error(`[fail] ${fileName}: ${err.message}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} grammar(s) failed to bundle.`);
    process.exitCode = 1;
    return;
  }

  console.log("\nAll tree-sitter grammars bundled into wasm/.");
}

main();
