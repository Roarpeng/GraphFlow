const Parser = require("web-tree-sitter");
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const requireFn = createRequire(__filename);

let initialized = false;

export interface TreeSitterSyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number };
  parent?: TreeSitterSyntaxNode;
  namedChildren: TreeSitterSyntaxNode[];
  children?: TreeSitterSyntaxNode[];
  childForFieldName(name: string): TreeSitterSyntaxNode | null;
}

export interface TreeSitterParser {
  parse(content: string): { rootNode: TreeSitterSyntaxNode };
}

/**
 * Supported tree-sitter languages.
 * Previously only python/go used tree-sitter; rust/c-cpp used regex.
 * Now all four use tree-sitter for consistent AST-level extraction.
 * Phase 2: added java/ruby to broaden language coverage (toward codebase-memory-mcp's 158 languages).
 */
export type TreeSitterLanguage = "python" | "go" | "rust" | "c" | "java" | "ruby";

const WASM_CACHE_DIR = join(process.cwd(), ".graphflow-cache", "wasm");

/**
 * Try to load a WASM grammar from the bundled location inside the npm package.
 * This avoids downloading from unpkg at runtime, enabling offline use.
 *
 * Lookup order:
 *   1. dist/wasm/ (bundled with @roarpeng/graphflow)
 *   2. node_modules/tree-sitter-wasms/out/ (if installed separately)
 *   3. .graphflow-cache/wasm/ (previously downloaded copy)
 *   4. Download from unpkg (last resort, online-only)
 */
function resolveBundledWasmPath(language: TreeSitterLanguage): string | null {
  const wasmFileName = `tree-sitter-${language}.wasm`;

  // 1. dist/wasm/ — bundled with the package
  try {
    const distWasmDir = join(__dirname, "..", "..", "..", "wasm");
    const distPath = join(distWasmDir, wasmFileName);
    if (existsSync(distPath)) return distPath;
  } catch {
    // ignore
  }

  // 2. node_modules/tree-sitter-wasms/out/
  try {
    const pkgPath = requireFn.resolve("tree-sitter-wasms/package.json");
    const pkgDir = dirname(pkgPath);
    const nmPath = join(pkgDir, "out", wasmFileName);
    if (existsSync(nmPath)) return nmPath;
  } catch {
    // tree-sitter-wasms not installed as dependency
  }

  // 3. .graphflow-cache/wasm/ (previously downloaded)
  const cachePath = join(WASM_CACHE_DIR, wasmFileName);
  if (existsSync(cachePath)) return cachePath;

  return null;
}

/**
 * Download a WASM grammar from unpkg as a last resort.
 * Caches to .graphflow-cache/wasm/ for subsequent offline use.
 */
async function downloadWasmGrammar(
  language: TreeSitterLanguage,
  targetPath: string
): Promise<void> {
  const url = `https://unpkg.com/tree-sitter-wasms@0.1.11/out/tree-sitter-${language}.wasm`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download tree-sitter-${language}.wasm from ${url}: ${res.statusText}`
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, buffer);
}

export async function getTreeSitterParser(
  language: TreeSitterLanguage
): Promise<TreeSitterParser> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }

  const wasmFileName = `tree-sitter-${language}.wasm`;
  const cachePath = join(WASM_CACHE_DIR, wasmFileName);

  // Try bundled / cached locations first (offline-capable)
  let wasmPath = resolveBundledWasmPath(language);

  // Last resort: download from unpkg (online-only)
  if (!wasmPath) {
    if (!existsSync(cachePath)) {
      await downloadWasmGrammar(language, cachePath);
    }
    wasmPath = cachePath;
  }

  const parser = new Parser();
  const lang = await Parser.Language.load(wasmPath);
  parser.setLanguage(lang);
  return parser as TreeSitterParser;
}
