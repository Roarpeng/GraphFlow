import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index.js";
import { getTreeSitterParser, walkTreeSitterAst, type TreeSitterSyntaxNode } from "./tree-sitter-loader.js";

function kotlinSymbolName(node: TreeSitterSyntaxNode): string | undefined {
  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    return nameNode.text;
  }

  const typeId = node.namedChildren.find((c) => c.type === "type_identifier");
  if (typeId) {
    return typeId.text;
  }

  const simpleId = node.namedChildren.find((c) => c.type === "simple_identifier");
  if (simpleId) {
    return simpleId.text;
  }

  const varDecl = node.namedChildren.find((c) => c.type === "variable_declaration");
  if (varDecl) {
    const id = varDecl.namedChildren.find((c) => c.type === "simple_identifier");
    if (id) {
      return id.text;
    }
  }

  return undefined;
}

function kotlinImportModule(node: TreeSitterSyntaxNode): string | undefined {
  const identifier = node.namedChildren.find((c) => c.type === "identifier");
  if (identifier) {
    return identifier.text.replace(/\./g, "/");
  }
  return undefined;
}

/**
 * Kotlin indexer using tree-sitter AST.
 *
 * Extracts: classes, functions, objects, properties, imports.
 */
export const kotlinIndexer: LanguageIndexer = {
  language: "kotlin",
  extensions: [".kt", ".kts"],
  async extract(filePath: string, content: string): Promise<ExtractionResult> {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];

    let tree;
    try {
      const parser = await getTreeSitterParser("kotlin");
      tree = parser.parse(content);
    } catch {
      return kotlinRegexFallback(filePath, content);
    }

    walkTreeSitterAst(tree.rootNode, (node) => {
      const lineNo = node.startPosition.row + 1;

      switch (node.type) {
        case "class_declaration": {
          const name = kotlinSymbolName(node);
          if (name) {
            symbols.push({
              name,
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
          const name = kotlinSymbolName(node);
          if (name) {
            let paramsCount = 0;
            const paramsNode = node.namedChildren.find((c) => c.type === "function_value_parameters");
            if (paramsNode) {
              paramsCount = paramsNode.namedChildren.filter(
                (c) => c.type === "parameter" || c.type === "parameter_with_optional_type"
              ).length;
            }
            symbols.push({
              name,
              kind: "function",
              exported: true,
              line: lineNo,
              file: filePath,
              visibility: "public",
              paramsCount,
              signature: `fun ${name}(${paramsCount} params)`,
            });
          }
          break;
        }
        case "object_declaration": {
          const name = kotlinSymbolName(node);
          if (name) {
            symbols.push({
              name,
              kind: "object",
              exported: true,
              line: lineNo,
              file: filePath,
              visibility: "public",
            });
          }
          break;
        }
        case "property_declaration": {
          const name = kotlinSymbolName(node);
          if (name) {
            symbols.push({
              name,
              kind: "property",
              exported: true,
              line: lineNo,
              file: filePath,
              visibility: "public",
            });
          }
          break;
        }
        case "import_header":
        case "import": {
          const module = kotlinImportModule(node);
          if (module) {
            imports.push({ module, raw: node.text });
          }
          break;
        }
      }
    });

    return { symbols, imports };
  },
};

function kotlinRegexFallback(filePath: string, content: string): ExtractionResult {
  const symbols: DeclaredSymbol[] = [];
  const imports: ImportTarget[] = [];
  const lines = content.split(/\r?\n/);

  const RE_IMPORT = /^\s*import\s+([\w.*]+)/;
  const RE_CLASS = /^\s*(?:data\s+|sealed\s+|open\s+|abstract\s+|inner\s+)*class\s+(\w+)/;
  const RE_OBJECT = /^\s*object\s+(\w+)/;
  const RE_FUN = /^\s*(?:private\s+|public\s+|internal\s+|protected\s+)?fun\s+(?:<[^>]+>\s+)?(\w+)\s*\(/;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const lineNo = idx + 1;

    const importMatch = RE_IMPORT.exec(line);
    if (importMatch) {
      imports.push({
        module: importMatch[1]!.replace(/\./g, "/").replace(/\*.*$/, ""),
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

    const objectMatch = RE_OBJECT.exec(line);
    if (objectMatch) {
      symbols.push({
        name: objectMatch[1]!,
        kind: "object",
        exported: true,
        line: lineNo,
        file: filePath,
        visibility: "public",
      });
      continue;
    }

    const funMatch = RE_FUN.exec(line);
    if (funMatch) {
      symbols.push({
        name: funMatch[1]!,
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
