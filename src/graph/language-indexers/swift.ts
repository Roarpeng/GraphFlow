import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index.js";
import { getTreeSitterParser, type TreeSitterSyntaxNode } from "./tree-sitter-loader.js";

function swiftImportModule(node: TreeSitterSyntaxNode): string | undefined {
  const identifier = node.namedChildren.find((c) => c.type === "identifier");
  if (identifier) {
    return identifier.text.replace(/\./g, "/");
  }
  return undefined;
}

/**
 * Swift indexer using tree-sitter AST.
 *
 * Extracts: classes, functions, protocols, imports.
 */
export const swiftIndexer: LanguageIndexer = {
  language: "swift",
  extensions: [".swift"],
  async extract(filePath: string, content: string): Promise<ExtractionResult> {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];

    let tree;
    try {
      const parser = await getTreeSitterParser("swift");
      tree = parser.parse(content);
    } catch {
      return swiftRegexFallback(filePath, content);
    }

    const traverse = (node: TreeSitterSyntaxNode) => {
      const lineNo = node.startPosition.row + 1;

      switch (node.type) {
        case "class_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "class",
              exported: true,
              line: lineNo,
              file: filePath,
              visibility: "public",
            });
          }
          break;
        }
        case "function_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            let paramsCount = 0;
            const paramsNode = node.childForFieldName("parameters");
            if (paramsNode) {
              paramsCount = paramsNode.namedChildren.filter(
                (c) => c.type === "parameter" || c.type === "lambda_parameter"
              ).length;
            }
            symbols.push({
              name: nameNode.text,
              kind: "function",
              exported: true,
              line: lineNo,
              file: filePath,
              visibility: "public",
              paramsCount,
              signature: `func ${nameNode.text}(${paramsCount} params)`,
            });
          }
          break;
        }
        case "protocol_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "protocol",
              exported: true,
              line: lineNo,
              file: filePath,
              visibility: "public",
            });
          }
          break;
        }
        case "import_declaration": {
          const module = swiftImportModule(node);
          if (module) {
            imports.push({ module, raw: node.text });
          }
          break;
        }
      }

      for (const child of node.children ?? node.namedChildren) {
        traverse(child);
      }
    };

    traverse(tree.rootNode);
    return { symbols, imports };
  },
};

function swiftRegexFallback(filePath: string, content: string): ExtractionResult {
  const symbols: DeclaredSymbol[] = [];
  const imports: ImportTarget[] = [];
  const lines = content.split(/\r?\n/);

  const RE_IMPORT = /^\s*import\s+(?:struct|class|enum|protocol|typealias\s+)?([\w.]+)/;
  const RE_CLASS = /^\s*(?:public\s+|private\s+|internal\s+|open\s+|final\s+)*class\s+(\w+)/;
  const RE_PROTOCOL = /^\s*(?:public\s+|private\s+|internal\s+)?protocol\s+(\w+)/;
  const RE_FUNC = /^\s*(?:public\s+|private\s+|internal\s+|open\s+|static\s+|class\s+)*func\s+(\w+)\s*\(/;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const lineNo = idx + 1;

    const importMatch = RE_IMPORT.exec(line);
    if (importMatch) {
      imports.push({
        module: importMatch[1]!.replace(/\./g, "/"),
        raw: line.trim(),
      });
      continue;
    }

    const classMatch = RE_CLASS.exec(line);
    if (classMatch) {
      symbols.push({
        name: classMatch[1]!,
        kind: "class",
        exported: true,
        line: lineNo,
        file: filePath,
        visibility: "public",
      });
      continue;
    }

    const protocolMatch = RE_PROTOCOL.exec(line);
    if (protocolMatch) {
      symbols.push({
        name: protocolMatch[1]!,
        kind: "protocol",
        exported: true,
        line: lineNo,
        file: filePath,
        visibility: "public",
      });
      continue;
    }

    const funcMatch = RE_FUNC.exec(line);
    if (funcMatch) {
      symbols.push({
        name: funcMatch[1]!,
        kind: "function",
        exported: true,
        line: lineNo,
        file: filePath,
        visibility: "public",
      });
    }
  }

  return { symbols, imports };
}
