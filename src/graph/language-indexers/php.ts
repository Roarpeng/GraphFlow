import type {
  CallRelation,
  DeclaredSymbol,
  ExtractionResult,
  ImportTarget,
  InheritRelation,
  LanguageIndexer,
} from "./index.js";
import {
  getTreeSitterParser,
  walkTreeSitterAstWithState,
  type TreeSitterSyntaxNode,
} from "./tree-sitter-loader.js";

function phpVisibility(node: TreeSitterSyntaxNode): {
  visibility: "public" | "protected" | "private";
  exported: boolean;
} {
  const text = node.namedChildren.find((c) => c.type === "visibility_modifier")?.text ?? "";
  if (/\bprivate\b/.test(text)) {
    return { visibility: "private", exported: false };
  }
  if (/\bprotected\b/.test(text)) {
    return { visibility: "protected", exported: true };
  }
  return { visibility: "public", exported: true };
}

function phpParamsCount(node: TreeSitterSyntaxNode): number {
  const paramsNode = node.childForFieldName("parameters");
  if (!paramsNode) {
    return 0;
  }
  return paramsNode.namedChildren.filter((c) => c.type.endsWith("_parameter")).length;
}

/** Callee text for `function_call_expression`/`member_call_expression` (identifier, name or qualified). */
function phpCalleeName(node: TreeSitterSyntaxNode | null): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "identifier" || node.type === "name") {
    return node.text;
  }
  if (node.type === "qualified_name" || node.type === "fully_qualified_name") {
    const parts = node.namedChildren.filter((c) => c.type === "name");
    return parts.length > 0 ? parts[parts.length - 1]!.text : undefined;
  }
  return undefined;
}

/**
 * PHP indexer using tree-sitter AST.
 *
 * Extracts: classes, interfaces, traits, enums, functions, methods, fields,
 * imports (use declarations), calls, inheritance (extends/implements).
 *
 * Visibility comes from `visibility_modifier` children (public/protected/private).
 */
export const phpIndexer: LanguageIndexer = {
  language: "php",
  extensions: [".php"],
  async extract(filePath: string, content: string): Promise<ExtractionResult> {
    const symbols: DeclaredSymbol[] = [];
    const imports: ImportTarget[] = [];
    const calls: CallRelation[] = [];
    const inherits: InheritRelation[] = [];

    let tree;
    try {
      const parser = await getTreeSitterParser("php");
      tree = parser.parse(content);
    } catch {
      return phpRegexFallback(filePath, content);
    }

    walkTreeSitterAstWithState(tree.rootNode, undefined as string | undefined, (node, caller) => {
      const lineNo = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;

      switch (node.type) {
        case "class_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const name = nameNode.text;
            const { visibility, exported } = phpVisibility(node);
            symbols.push({
              name,
              kind: "class",
              exported,
              line: lineNo,
              endLine,
              file: filePath,
              visibility,
            });

            const baseClause = node.namedChildren.find((c) => c.type === "base_clause");
            if (baseClause) {
              for (const parent of baseClause.namedChildren) {
                if (parent.text) {
                  inherits.push({ child: name, parent: parent.text, kind: "extends", line: lineNo });
                }
              }
            }
            const ifaceClause = node.namedChildren.find((c) => c.type === "class_interface_clause");
            if (ifaceClause) {
              for (const parent of ifaceClause.namedChildren) {
                if (parent.text) {
                  inherits.push({ child: name, parent: parent.text, kind: "implements", line: lineNo });
                }
              }
            }
          }
          break;
        }
        case "interface_declaration":
        case "trait_declaration":
        case "enum_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nameNode.text,
              kind: node.type === "interface_declaration"
                ? "interface"
                : node.type === "trait_declaration"
                  ? "trait"
                  : "enum",
              exported: true,
              line: lineNo,
              endLine,
              file: filePath,
              visibility: "public",
            });
          }
          break;
        }
        case "function_definition":
        case "method_declaration": {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const name = nameNode.text;
            const paramsCount = phpParamsCount(node);
            const { visibility, exported } = phpVisibility(node);
            let returnType: string | undefined;
            const retNode = node.childForFieldName("return_type") ?? node.namedChildren.find(
              (c) => c.type === "primitive_type" || c.type === "named_type" || c.type === "optional_type"
            );
            if (retNode) {
              returnType = retNode.text.slice(0, 80);
            }
            symbols.push({
              name,
              kind: node.type === "method_declaration" ? "method" : "function",
              exported,
              line: lineNo,
              endLine,
              file: filePath,
              visibility,
              paramsCount,
              ...(returnType ? { returnType } : {}),
              signature: `${name}(${paramsCount} params)`,
            });
            return name;
          }
          break;
        }
        case "property_declaration": {
          const { visibility, exported } = phpVisibility(node);
          for (const element of node.namedChildren) {
            if (element.type !== "property_element") {
              continue;
            }
            const varNode =
              element.childForFieldName("variable_name") ??
              element.namedChildren.find((c) => c.type === "variable_name");
            if (!varNode) {
              continue;
            }
            const name = varNode.namedChildren.find((c) => c.type === "name")?.text
              ?? varNode.text.replace(/^\$/, "");
            if (name) {
              symbols.push({
                name,
                kind: "field",
                exported,
                line: lineNo,
                endLine,
                file: filePath,
                visibility,
              });
            }
          }
          break;
        }
        case "namespace_use_declaration": {
          for (const clause of node.namedChildren) {
            if (!clause.type.endsWith("_use_clause")) {
              continue;
            }
            // Qualified names parse as qualified_name; single-segment uses are a bare name.
            const nameNode =
              clause.namedChildren.find((c) => c.type === "qualified_name") ??
              clause.namedChildren.find((c) => c.type === "name");
            if (nameNode) {
              imports.push({
                module: nameNode.text.replace(/\\/g, "/"),
                raw: node.text,
              });
            }
          }
          break;
        }
        case "function_call_expression":
        case "member_call_expression": {
          const calleeNode =
            node.type === "member_call_expression"
              ? node.childForFieldName("name")
              : node.childForFieldName("function");
          const callee = phpCalleeName(calleeNode);
          if (callee) {
            calls.push({ callee, ...(caller ? { caller } : {}), line: lineNo });
          }
          break;
        }
      }
      return caller;
    });

    return { symbols, imports, calls, inherits };
  },
};

/**
 * Regex-based fallback used when tree-sitter WASM is unavailable.
 */
function phpRegexFallback(filePath: string, content: string): ExtractionResult {
  const symbols: DeclaredSymbol[] = [];
  const imports: ImportTarget[] = [];
  const lines = content.split(/\r?\n/);

  const RE_IMPORT = /^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)/;
  const RE_CLASS = /^\s*(?:abstract\s+|final\s+)*class\s+(\w+)/;
  const RE_INTERFACE = /^\s*interface\s+(\w+)/;
  const RE_TRAIT = /^\s*trait\s+(\w+)/;
  const RE_ENUM = /^\s*(?:abstract\s+|final\s+)*enum\s+(\w+)/;
  const RE_FUNCTION = /^\s*(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+(?:&\s*)?(\w+)\s*\(/;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const lineNo = idx + 1;

    const importMatch = RE_IMPORT.exec(line);
    if (importMatch) {
      imports.push({
        module: importMatch[1]!.replace(/\\/g, "/"),
        raw: line.trim(),
      });
      continue;
    }

    const classMatch = RE_CLASS.exec(line);
    if (classMatch) {
      symbols.push({ name: classMatch[1]!, kind: "class", exported: true, line: lineNo, file: filePath });
      continue;
    }

    const ifaceMatch = RE_INTERFACE.exec(line);
    if (ifaceMatch) {
      symbols.push({ name: ifaceMatch[1]!, kind: "interface", exported: true, line: lineNo, file: filePath });
      continue;
    }

    const traitMatch = RE_TRAIT.exec(line);
    if (traitMatch) {
      symbols.push({ name: traitMatch[1]!, kind: "trait", exported: true, line: lineNo, file: filePath });
      continue;
    }

    const enumMatch = RE_ENUM.exec(line);
    if (enumMatch) {
      symbols.push({ name: enumMatch[1]!, kind: "enum", exported: true, line: lineNo, file: filePath });
      continue;
    }

    const funMatch = RE_FUNCTION.exec(line);
    if (funMatch) {
      const isMethod = /^\s+(?:public|protected|private)\s/.test(line);
      symbols.push({
        name: funMatch[1]!,
        kind: isMethod ? "method" : "function",
        exported: true,
        line: lineNo,
        file: filePath,
      });
    }
  }

  return { symbols, imports };
}
