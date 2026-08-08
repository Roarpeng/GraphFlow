import type { DeclaredSymbol, ExtractionResult, ImportTarget, LanguageIndexer } from "./index.js";
import { getTreeSitterParser, walkTreeSitterAst } from "./tree-sitter-loader.js";

/**
 * Java indexer using tree-sitter AST.
 *
 * Extracts: methods, classes, interfaces, enums, records, annotation types,
 * fields, constants, constructors.
 *
 * Visibility (`public`/`protected`/`private`) is determined by modifier keywords.
 * Borrowed from codebase-memory-mcp's broad language support pattern.
 */
export const javaIndexer: LanguageIndexer = {
  language: "java",
  extensions: [".java"],
  async extract(filePath: string, content: string): Promise<ExtractionResult> {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];

    let tree;
    try {
      const parser = await getTreeSitterParser("java");
      tree = parser.parse(content);
    } catch {
      return javaRegexFallback(filePath, content);
    }

    walkTreeSitterAst(tree.rootNode, (node) => {
      const lineNo = node.startPosition.row + 1;
      const modifierText = node.children
        ?.filter((c) => c.type === "modifiers")
        .map((c) => c.text)
        .join(" ") ?? "";
      const isPublic = /\bpublic\b/.test(modifierText);
      const isProtected = /\bprotected\b/.test(modifierText);
      const isPrivate = /\bprivate\b/.test(modifierText);
      const visibility: "public" | "protected" | "private" = isPublic
        ? "public"
        : isProtected
          ? "protected"
          : isPrivate
            ? "private"
            : "public";

      switch (node.type) {
        case "class_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "class",
              exported: isPublic || !isPrivate,
              line: lineNo,
              file: filePath,
              visibility,
            });
          }
          break;
        }
        case "interface_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "interface",
              exported: isPublic || !isPrivate,
              line: lineNo,
              file: filePath,
              visibility,
            });
          }
          break;
        }
        case "enum_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "enum",
              exported: isPublic || !isPrivate,
              line: lineNo,
              file: filePath,
              visibility,
            });
          }
          break;
        }
        case "record_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "record",
              exported: isPublic || !isPrivate,
              line: lineNo,
              file: filePath,
              visibility,
            });
          }
          break;
        }
        case "annotation_type_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: "annotation",
              exported: isPublic || !isPrivate,
              line: lineNo,
              file: filePath,
              visibility,
            });
          }
          break;
        }
        case "method_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            let paramsCount = 0;
            const paramsNode = node.childForFieldName("parameters");
            if (paramsNode) {
              paramsCount = paramsNode.namedChildren.filter(
                (c) => c.type === "formal_parameter"
              ).length;
            }
            let returnType: string | undefined;
            const retNode = node.childForFieldName("type");
            if (retNode) {
              returnType = retNode.text.slice(0, 80);
            }
            symbols.push({
              name: nameNode.text,
              kind: "method",
              exported: isPublic || !isPrivate,
              line: lineNo,
              file: filePath,
              visibility,
              paramsCount,
              ...(returnType ? { returnType } : {}),
              signature: `${returnType ?? "void"} ${nameNode.text}(${paramsCount} params)`,
            });
          }
          break;
        }
        case "constructor_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            let paramsCount = 0;
            const paramsNode = node.childForFieldName("parameters");
            if (paramsNode) {
              paramsCount = paramsNode.namedChildren.filter(
                (c) => c.type === "formal_parameter"
              ).length;
            }
            symbols.push({
              name: nameNode.text,
              kind: "constructor",
              exported: isPublic || !isPrivate,
              line: lineNo,
              file: filePath,
              visibility,
              paramsCount,
              signature: `${nameNode.text}(${paramsCount} params)`,
            });
          }
          break;
        }
        case "field_declaration": {
          // Field declarations contain variable_declarator nodes
          const varDecls = node.namedChildren.filter((c) => c.type === "variable_declarator");
          for (const vd of varDecls) {
            const nameNode = vd.childForFieldName("name");
            if (nameNode) {
              const isStatic = /\bstatic\b/.test(modifierText);
              const isFinal = /\bfinal\b/.test(modifierText);
              symbols.push({
                name: nameNode.text,
                kind: isStatic && isFinal ? "const" : "field",
                exported: isPublic || !isPrivate,
                line: lineNo,
                file: filePath,
                visibility,
              });
            }
          }
          break;
        }
        case "import_declaration": {
          const scopedDecl = node.childForFieldName("scoped_identifier");
          const name = scopedDecl?.text ?? node.text.replace(/^import\s+(?:static\s+)?/, "").replace(/;.*$/, "");
          if (name) {
            imports.push({ module: name.replace(/\./g, "/"), raw: node.text });
          }
          break;
        }
      }
    });

    return { symbols, imports };
  },
};

/**
 * Regex-based fallback used when tree-sitter WASM is unavailable.
 */
function javaRegexFallback(filePath: string, content: string): ExtractionResult {
  const symbols: DeclaredSymbol[] = [];
  const imports: ImportTarget[] = [];
  const lines = content.split(/\r?\n/);

  const RE_CLASS = /^\s*(?:@\w+\s*)*(public|protected|private)?\s*(?:abstract\s+|final\s+|static\s+)*class\s+(\w+)/;
  const RE_INTERFACE = /^\s*(?:@\w+\s*)*(public|protected|private)?\s*interface\s+(\w+)/;
  const RE_ENUM = /^\s*(?:@\w+\s*)*(public|protected|private)?\s*enum\s+(\w+)/;
  const RE_METHOD = /^\s*(?:@\w+\s*)*(public|protected|private)?\s*(?:static\s+|final\s+|abstract\s+|synchronized\s+|native\s+)*[\w<>\[\],\s]+\s+(\w+)\s*\(([^)]*)\)/;
  const RE_IMPORT = /^\s*import\s+(?:static\s+)?([\w.]+);/;
  

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const lineNo = idx + 1;

    const importMatch = RE_IMPORT.exec(line);
    if (importMatch) {
      imports.push({ module: importMatch[1]!.replace(/\./g, "/"), raw: line.trim() });
      continue;
    }

    const classMatch = RE_CLASS.exec(line);
    if (classMatch) {
      symbols.push({
        name: classMatch[2]!,
        kind: "class",
        exported: classMatch[1] !== "private",
        line: lineNo,
        file: filePath,
        visibility: (classMatch[1] as "public" | "protected" | "private") ?? "public",
      });
      continue;
    }

    const ifaceMatch = RE_INTERFACE.exec(line);
    if (ifaceMatch) {
      symbols.push({
        name: ifaceMatch[2]!,
        kind: "interface",
        exported: ifaceMatch[1] !== "private",
        line: lineNo,
        file: filePath,
        visibility: (ifaceMatch[1] as "public" | "protected" | "private") ?? "public",
      });
      continue;
    }

    const enumMatch = RE_ENUM.exec(line);
    if (enumMatch) {
      symbols.push({
        name: enumMatch[2]!,
        kind: "enum",
        exported: enumMatch[1] !== "private",
        line: lineNo,
        file: filePath,
        visibility: (enumMatch[1] as "public" | "protected" | "private") ?? "public",
      });
      continue;
    }

    const methodMatch = RE_METHOD.exec(line);
    if (methodMatch) {
      const paramsStr = methodMatch[2] ?? "";
      const paramsCount = paramsStr.trim() ? paramsStr.split(",").length : 0;
      symbols.push({
        name: methodMatch[1]!,
        kind: "method",
        exported: true,
        line: lineNo,
        file: filePath,
        paramsCount,
      });
      continue;
    }
  }

  return { symbols, imports };
}
