#!/usr/bin/env node
/**
 * Download tree-sitter WASM grammars into the wasm/ directory for offline bundling.
 *
 * Run during development or CI before `npm publish` to ensure the npm package
 * contains all required grammars (no runtime download needed by end users).
 *
 * Usage:
 *   node scripts/download-wasm-grammars.cjs
 *
 * Grammars are sourced from the tree-sitter-wasms@0.1.11 package on unpkg.
 * Output: wasm/tree-sitter-<language>.wasm
 */
const { mkdirSync, existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const GRAMMARS = ["python", "go", "rust", "c", "java", "ruby"];
const VERSION = "0.1.11";
const OUTPUT_DIR = join(__dirname, "..", "wasm");

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const lang of GRAMMARS) {
    const fileName = `tree-sitter-${lang}.wasm`;
    const outputPath = join(OUTPUT_DIR, fileName);

    if (existsSync(outputPath)) {
      console.log(`[skip] ${fileName} already exists`);
      continue;
    }

    const url = `https://unpkg.com/tree-sitter-wasms@${VERSION}/out/${fileName}`;
    console.log(`[download] ${url}`);

    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      writeFileSync(outputPath, buffer);
      console.log(`[ok] ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      console.error(`[fail] ${fileName}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  if (process.exitCode === 1) {
    console.error("\nSome grammars failed to download. The package will still work");
    console.error("but will fall back to runtime download or regex-based indexing.");
  } else {
    console.log("\nAll tree-sitter grammars bundled successfully.");
  }
}

main();
