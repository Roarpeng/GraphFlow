const TreeSitterMod = require("web-tree-sitter");
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const requireFn = createRequire(__filename);

/** web-tree-sitter >=0.25 exports { Parser, Language }; older versions export Parser directly. */
const Parser: {
  init(moduleOptions?: unknown): Promise<void>;
  new (): TreeSitterParser & { setLanguage(lang: unknown): void };
} = TreeSitterMod.Parser ?? TreeSitterMod;

const Language: {
  load(input: string | Uint8Array): Promise<unknown>;
} = TreeSitterMod.Language ?? TreeSitterMod.Parser?.Language ?? TreeSitterMod;

let initPromise: Promise<void> | null = null;

export interface TreeSitterSyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column?: number };
  parent?: TreeSitterSyntaxNode;
  namedChildren: TreeSitterSyntaxNode[];
  children?: TreeSitterSyntaxNode[];
  childForFieldName(name: string): TreeSitterSyntaxNode | null;
}

export interface TreeSitterPoint {
  row: number;
  column: number;
}

export interface TreeSitterEdit {
  startIndex: number;
  oldEndIndex: number;
  newEndIndex: number;
  startPosition: TreeSitterPoint;
  oldEndPosition: TreeSitterPoint;
  newEndPosition: TreeSitterPoint;
}

export interface TreeSitterTree {
  rootNode: TreeSitterSyntaxNode;
  edit?(edit: TreeSitterEdit): void;
  delete?(): void;
}

export interface TreeSitterParser {
  parse(content: string, oldTree?: unknown): TreeSitterTree;
}

/**
 * Iterative DFS over a tree-sitter AST.
 *
 * Language indexers previously used recursive `traverse(child)` which blows
 * the V8 call stack on large C/C++ translation units (deep templates, nested
 * macros, generated headers) with "Maximum call stack size exceeded".
 *
 * Prefer `namedChildren` (default) — unnamed punctuation tokens are irrelevant
 * for symbol extraction and inflate both depth and breadth.
 */
export function walkTreeSitterAst(
  root: TreeSitterSyntaxNode,
  visit: (node: TreeSitterSyntaxNode) => void,
  options?: { namedOnly?: boolean }
): void {
  walkTreeSitterAstWithState(root, undefined, (node) => {
    visit(node);
    return undefined;
  }, options);
}

/**
 * Iterative DFS that threads per-frame state (e.g. current caller name for call edges).
 * `visit` returns the state to pass to children; returning the same reference is fine.
 */
export function walkTreeSitterAstWithState<T>(
  root: TreeSitterSyntaxNode,
  initialState: T,
  visit: (node: TreeSitterSyntaxNode, state: T) => T,
  options?: { namedOnly?: boolean }
): void {
  const namedOnly = options?.namedOnly !== false;
  const stack: Array<{ node: TreeSitterSyntaxNode; state: T }> = [
    { node: root, state: initialState },
  ];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const childState = visit(frame.node, frame.state);
    const children = namedOnly
      ? frame.node.namedChildren
      : (frame.node.children ?? frame.node.namedChildren);
    // Reverse push so left-to-right child order is preserved.
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) {
        stack.push({ node: child, state: childState });
      }
    }
  }
}

/**
 * Supported tree-sitter languages.
 * Previously only python/go used tree-sitter; rust/c-cpp used regex.
 * Now all four use tree-sitter for consistent AST-level extraction.
 * Phase 2: added java/ruby to broaden language coverage (toward codebase-memory-mcp's 158 languages).
 * Phase 3: kotlin/swift; Phase 4: dart (requires web-tree-sitter >=0.25 for ABI 15).
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
  | "swift"
  | "dart";

const WASM_CACHE_DIR = join(process.cwd(), ".graphflow-cache", "wasm");
const languageLoadPromises = new Map<TreeSitterLanguage, Promise<unknown>>();
const parserPool = new Map<TreeSitterLanguage, Promise<TreeSitterParser>>();

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
  const pooledParser = parserPool.get(language);
  if (pooledParser) {
    return pooledParser;
  }

  const parserPromise = createTreeSitterParser(language);
  parserPool.set(language, parserPromise);
  return parserPromise;
}

async function createTreeSitterParser(language: TreeSitterLanguage): Promise<TreeSitterParser> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  await initPromise;

  const parser = new Parser();
  const lang = await loadTreeSitterLanguage(language);
  parser.setLanguage(lang);
  return parser as TreeSitterParser;
}

async function loadTreeSitterLanguage(language: TreeSitterLanguage): Promise<unknown> {
  const cachedLanguage = languageLoadPromises.get(language);
  if (cachedLanguage) {
    return cachedLanguage;
  }

  const wasmPath = resolveBundledWasmPath(language);
  if (!wasmPath) {
    throw new Error(
      `Bundled tree-sitter grammar not found for "${language}". ` +
        "Reinstall @roarpeng/graphflow or run `npm run wasm:bundle` in the GraphFlow source tree."
    );
  }

  const languagePromise = Language.load(wasmPath) as Promise<unknown>;
  languageLoadPromises.set(language, languagePromise);
  return languagePromise;
}
