import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index.js";
import { getTreeSitterParser, type TreeSitterSyntaxNode } from "./tree-sitter-loader.js";

function isPrivateName(name: string): boolean {
  return name.startsWith("_");
}

function dartVisibility(name: string): "public" | "private" {
  return isPrivateName(name) ? "private" : "public";
}

function firstIdentifier(node: TreeSitterSyntaxNode): string | undefined {
  const named = node.childForFieldName("name");
  if (named?.text) {
    return named.text;
  }
  for (const child of node.namedChildren) {
    if (child.type === "identifier" || child.type === "type_identifier") {
      return child.text;
    }
  }
  return undefined;
}

function normalizeDartImportUri(rawUri: string): string | undefined {
  const trimmed = rawUri.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) {
    return undefined;
  }

  let path = trimmed;
  if (path.startsWith("package:")) {
    path = path.slice("package:".length);
  } else if (path.startsWith("dart:")) {
    path = `dart/${path.slice("dart:".length)}`;
  }

  path = path.replace(/\.dart$/i, "");
  return path.replace(/\\/g, "/");
}

function extractImportModule(node: TreeSitterSyntaxNode): string | undefined {
  if (node.type === "configurable_uri" || node.type === "uri" || node.type === "string_literal") {
    return normalizeDartImportUri(node.text);
  }

  const direct =
    node.namedChildren.find((c) => c.type === "configurable_uri") ??
    node.namedChildren.find((c) => c.type === "uri") ??
    node.namedChildren.find((c) => c.type === "string_literal");
  if (direct) {
    return normalizeDartImportUri(direct.text);
  }

  for (const child of node.namedChildren) {
    const nested = extractImportModule(child);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function pushSymbol(
  symbols: DeclaredSymbol[],
  filePath: string,
  name: string | undefined,
  kind: string,
  line: number,
  extras?: Partial<DeclaredSymbol>
): void {
  if (!name) {
    return;
  }
  symbols.push({
    name,
    kind,
    exported: !isPrivateName(name),
    line,
    file: filePath,
    visibility: dartVisibility(name),
    ...extras,
  });
}

/**
 * Dart / Flutter indexer using tree-sitter AST.
 *
 * Extracts: classes, mixins, extensions, enums, typedefs, functions/methods,
 * getters/setters, constructors, and imports.
 */
export const dartIndexer: LanguageIndexer = {
  language: "dart",
  extensions: [".dart"],
  async extract(filePath: string, content: string): Promise<ExtractionResult> {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];

    let tree;
    try {
      const parser = await getTreeSitterParser("dart");
      tree = parser.parse(content);
    } catch {
      return dartRegexFallback(filePath, content);
    }

    const traverse = (node: TreeSitterSyntaxNode) => {
      const lineNo = node.startPosition.row + 1;

      switch (node.type) {
        case "class_definition": {
          pushSymbol(symbols, filePath, firstIdentifier(node), "class", lineNo);
          break;
        }
        case "mixin_declaration": {
          pushSymbol(symbols, filePath, firstIdentifier(node), "mixin", lineNo);
          break;
        }
        case "extension_declaration": {
          pushSymbol(symbols, filePath, firstIdentifier(node), "extension", lineNo);
          break;
        }
        case "enum_declaration": {
          pushSymbol(symbols, filePath, firstIdentifier(node), "enum", lineNo);
          break;
        }
        case "type_alias": {
          pushSymbol(symbols, filePath, firstIdentifier(node), "typedef", lineNo);
          break;
        }
        case "function_signature": {
          // Covers top-level functions and methods nested under method_signature.
          const name = firstIdentifier(node);
          let paramsCount = 0;
          const paramsNode =
            node.childForFieldName("parameters") ??
            node.namedChildren.find((c) => c.type === "formal_parameter_list");
          if (paramsNode) {
            paramsCount = paramsNode.namedChildren.filter(
              (c) =>
                c.type === "formal_parameter" ||
                c.type === "optional_formal_parameters" ||
                c.type === "super_formal_parameter"
            ).length;
          }
          pushSymbol(symbols, filePath, name, "function", lineNo, {
            paramsCount,
            ...(name ? { signature: `${name}(${paramsCount} params)` } : {}),
          });
          break;
        }
        case "getter_signature": {
          pushSymbol(symbols, filePath, firstIdentifier(node), "getter", lineNo);
          break;
        }
        case "setter_signature": {
          pushSymbol(symbols, filePath, firstIdentifier(node), "setter", lineNo);
          break;
        }
        case "constructor_signature":
        case "constant_constructor_signature":
        case "factory_constructor_signature": {
          const name = firstIdentifier(node);
          if (!name) {
            break;
          }
          // Symbol node ids hash by name only; disambiguate from the class symbol.
          const namedMatch = /\.(\w+)\s*\(/.exec(node.text);
          const ctorName = namedMatch ? `${name}.${namedMatch[1]}` : `${name}.new`;
          pushSymbol(symbols, filePath, ctorName, "constructor", lineNo);
          break;
        }
        case "library_import": {
          const module = extractImportModule(node);
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

function dartRegexFallback(filePath: string, content: string): ExtractionResult {
  const symbols: DeclaredSymbol[] = [];
  const imports: ImportTarget[] = [];
  const lines = content.split(/\r?\n/);

  const RE_IMPORT = /^\s*import\s+['"]([^'"]+)['"]/;
  const RE_CLASS = /^\s*(?:abstract\s+|base\s+|interface\s+|final\s+|sealed\s+)*class\s+(\w+)/;
  const RE_ENUM = /^\s*enum\s+(\w+)/;
  const RE_MIXIN = /^\s*mixin\s+(\w+)/;
  const RE_EXTENSION = /^\s*extension\s+(\w+)\s+on\b/;
  const RE_TYPEDEF = /^\s*typedef\s+(\w+)\s*=/;
  const RE_FUNC =
    /^\s*(?:(?:static|external|Future<\w+>|void|int|double|bool|String|Widget|dynamic)\s+)+(\w+)\s*\(/;
  const RE_TOP_FUNC = /^\s*(?:Future(?:<[^>]+>)?|void|int|double|bool|String|Widget|dynamic)\s+(\w+)\s*\(/;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const lineNo = idx + 1;

    const importMatch = RE_IMPORT.exec(line);
    if (importMatch) {
      const module = normalizeDartImportUri(importMatch[1]!);
      if (module) {
        imports.push({ module, raw: line.trim() });
      }
      continue;
    }

    const classMatch = RE_CLASS.exec(line);
    if (classMatch) {
      pushSymbol(symbols, filePath, classMatch[1], "class", lineNo);
      continue;
    }

    const enumMatch = RE_ENUM.exec(line);
    if (enumMatch) {
      pushSymbol(symbols, filePath, enumMatch[1], "enum", lineNo);
      continue;
    }

    const mixinMatch = RE_MIXIN.exec(line);
    if (mixinMatch) {
      pushSymbol(symbols, filePath, mixinMatch[1], "mixin", lineNo);
      continue;
    }

    const extensionMatch = RE_EXTENSION.exec(line);
    if (extensionMatch) {
      pushSymbol(symbols, filePath, extensionMatch[1], "extension", lineNo);
      continue;
    }

    const typedefMatch = RE_TYPEDEF.exec(line);
    if (typedefMatch) {
      pushSymbol(symbols, filePath, typedefMatch[1], "typedef", lineNo);
      continue;
    }

    const funcMatch = RE_TOP_FUNC.exec(line) ?? RE_FUNC.exec(line);
    if (funcMatch) {
      const name = funcMatch[1]!;
      if (name !== "if" && name !== "for" && name !== "while" && name !== "switch") {
        pushSymbol(symbols, filePath, name, "function", lineNo);
      }
    }
  }

  return { symbols, imports };
}
