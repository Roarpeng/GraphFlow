const Parser = require("web-tree-sitter");
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

export async function getTreeSitterParser(language: "python" | "go"): Promise<TreeSitterParser> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }

  const cacheDir = join(process.cwd(), ".graphflow-cache", "wasm");
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  const wasmFileName = `tree-sitter-${language}.wasm`;
  const wasmPath = join(cacheDir, wasmFileName);

  if (!existsSync(wasmPath)) {
    // Attempt to download from unpkg tree-sitter-wasms package
    const url = `https://unpkg.com/tree-sitter-wasms@0.1.11/out/tree-sitter-${language}.wasm`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download ${wasmFileName} from ${url}: ${res.statusText}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(wasmPath, buffer);
  }

  const parser = new Parser();
  const lang = await Parser.Language.load(wasmPath);
  parser.setLanguage(lang);
  return parser as TreeSitterParser;
}
