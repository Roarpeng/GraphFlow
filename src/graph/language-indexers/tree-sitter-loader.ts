const Parser = require("web-tree-sitter");
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const requireFn = createRequire(__filename);

let initPromise: Promise<void> | null = null;

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
export type TreeSitterLanguage =
  | "python"
  | "go"
  | "rust"
  | "c"
  | "cpp"
  | "java"
  | "ruby"
  | "kotlin"
  | "swift";

const WASM_CACHE_DIR = join(process.cwd(), ".graphflow-cache", "wasm");

function wasmFileName(language: TreeSitterLanguage): string {
  return `tree-sitter-${language}.wasm`;
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const candidate of paths) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    resolved.push(candidate);
  }
  return resolved;
}

/**
 * Resolve a bundled WASM grammar path inside the installed GraphFlow package.
 * No network access — grammars must ship in wasm/ or tree-sitter-wasms dependency.
 */
export function resolveBundledWasmPath(language: TreeSitterLanguage): string | null {
  const fileName = wasmFileName(language);
  const candidates = uniquePaths([
    join(__dirname, "..", "..", "..", "wasm", fileName),
    resolvePackageWasmPath(fileName),
    resolveTreeSitterWasmsPath(fileName),
    join(WASM_CACHE_DIR, fileName),
  ]);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolvePackageWasmPath(fileName: string): string | null {
  const packageNames = ["@roarpeng/graphflow", "graphflow"];
  for (const packageName of packageNames) {
    try {
      const pkgJson = requireFn.resolve(`${packageName}/package.json`);
      return join(dirname(pkgJson), "wasm", fileName);
    } catch {
      // try next package name
    }
  }
  return null;
}

function resolveTreeSitterWasmsPath(fileName: string): string | null {
  try {
    return requireFn.resolve(`tree-sitter-wasms/out/${fileName}`);
  } catch {
    return null;
  }
}

export async function getTreeSitterParser(
  language: TreeSitterLanguage
): Promise<TreeSitterParser> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  await initPromise;

  const wasmPath = resolveBundledWasmPath(language);
  if (!wasmPath) {
    throw new Error(
      `Bundled tree-sitter grammar not found for "${language}". ` +
        "Reinstall @roarpeng/graphflow or run `npm run wasm:bundle` in the GraphFlow source tree."
    );
  }

  const parser = new Parser();
  const lang = await Parser.Language.load(wasmPath);
  parser.setLanguage(lang);
  return parser as TreeSitterParser;
}
