#!/usr/bin/env node
/**
 * Bundle tree-sitter WASM grammars into wasm/ for offline distribution.
 *
 * Priority:
 *   1. Copy from node_modules/tree-sitter-wasms/out/ (no network)
 *   2. Download from unpkg (CI fallback when devDependency missing)
 *
 * Output: wasm/tree-sitter-<language>.wasm
 *
 * 版本标记：bundled 成功后写入 wasm/.grammar-version（内容为 VERSION）。
 * 标记缺失或与 VERSION 不一致时强制重打，避免升级 tree-sitter-wasms 后沿用旧语法文件。
 */
const { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createRequire } = require("node:module");

const requireFn = createRequire(__filename);
const GRAMMARS = ["python", "go", "rust", "c", "cpp", "java", "ruby", "kotlin", "swift", "dart"];
const VERSION = "0.1.13";
const OUTPUT_DIR = join(__dirname, "..", "wasm");
const MARKER_FILE = ".grammar-version";

function resolveTreeSitterWasmsOutDir() {
  try {
    const pkgPath = requireFn.resolve("tree-sitter-wasms/package.json");
    return join(pkgPath, "..", "out");
  } catch {
    return null;
  }
}

/** 读取已打包语法版本标记；缺失或不可读时返回 null。 */
function readBundledVersion(outputDir) {
  try {
    return readFileSync(join(outputDir, MARKER_FILE), "utf8").trim();
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

async function downloadFromUnpkg(lang, outputPath, version = VERSION) {
  const fileName = `tree-sitter-${lang}.wasm`;
  const url = `https://unpkg.com/tree-sitter-wasms@${version}/out/${fileName}`;
  console.log(`[download] ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(outputPath, buffer);
  console.log(`[ok] ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
}

async function main(options = {}) {
  const outputDir = options.outputDir ?? OUTPUT_DIR;
  const version = options.version ?? VERSION;
  const wasmsOutDir = options.wasmsOutDir !== undefined ? options.wasmsOutDir : resolveTreeSitterWasmsOutDir();
  const download = options.download ?? downloadFromUnpkg;
  mkdirSync(outputDir, { recursive: true });

  // 版本标记匹配时才走 skip 快路径；否则视为过期，全部重打
  const bundledVersion = readBundledVersion(outputDir);
  const forceRebundle = bundledVersion !== version;
  if (forceRebundle && bundledVersion !== null) {
    console.log(`[rebundle] grammar version changed: ${bundledVersion} -> ${version}`);
  }

  let failures = 0;

  for (const lang of GRAMMARS) {
    const fileName = `tree-sitter-${lang}.wasm`;
    const outputPath = join(outputDir, fileName);

    if (!forceRebundle && existsSync(outputPath)) {
      console.log(`[skip] ${fileName} already exists`);
      continue;
    }

    try {
      if (wasmsOutDir && copyFromPackage(wasmsOutDir, lang, outputPath)) {
        continue;
      }
      await download(lang, outputPath, version);
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

  writeFileSync(join(outputDir, MARKER_FILE), `${version}\n`);
  console.log("\nAll tree-sitter grammars bundled into wasm/.");
}

if (require.main === module) {
  main();
}

module.exports = { GRAMMARS, VERSION, MARKER_FILE, readBundledVersion, main };
